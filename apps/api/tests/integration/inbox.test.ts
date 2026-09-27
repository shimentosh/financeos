import { addDays, addMonths, today } from "@expensewise/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { aiUsage, categories, counterparties, inboxItems, subscriptions, transactions } from "../../src/db/schema/index.js";
import type { ClassifyInput } from "../../src/modules/ai/gateway/types.js";
import { AiInboxService } from "../../src/modules/ai/inbox/ai-inbox.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { InboxService } from "../../src/modules/system/notify.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider, ok } from "../fixtures/ai/fake-provider.js";
import { createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let inbox: AiInboxService;
let items: InboxService;
let ledger: TransactionsService;
let user: TestUser;
let ctx: WorkspaceContext;
let bkash: string;
let categoryId: (name: string) => string;
const day = today("Asia/Dhaka");

beforeAll(async () => {
  app = await aiApp(provider);
  inbox = app.service(AiInboxService);
  items = app.service(InboxService);
  ledger = app.service(TransactionsService);
});

afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  provider.reset();
  user = await createUser("Farhan Kabir");
  ctx = user.personal;
  bkash = (
    await app.service(AccountsService).create(ctx, {
      name: "bKash",
      kind: "mobile_wallet",
      provider: "bkash",
      currency: "BDT",
      openingBalance: 10_000_000,
      openingDate: addDays(day, -400),
    })
  ).id;
  const rows = await db.select().from(categories).where(eq(categories.workspaceId, ctx.workspaceId));
  categoryId = (name) => rows.find((row) => row.name === name)?.id as string;
});

const expense = async (input: {
  amount: number;
  date?: string;
  merchant?: string;
  categoryId?: string | null;
  status?: "draft" | "posted";
  reference?: string;
}) =>
  (
    await ledger.create(ctx, {
      type: "expense",
      status: input.status ?? "posted",
      accountId: bkash,
      amount: input.amount,
      currency: "BDT",
      date: input.date ?? addDays(day, -2),
      merchant: input.merchant ?? null,
      categoryId: input.categoryId ?? null,
      reference: input.reference ?? null,
    })
  ).transaction;

describe("the AI Inbox", () => {
  it("summarises what needs a decision and lists drafts and open items", async () => {
    await expense({ amount: 10_000, status: "draft", merchant: "Shwapno" });
    await expense({ amount: 20_000, merchant: "Unknown shop" });
    await expense({
      amount: 30_000,
      merchant: "Old uncategorised",
      date: addDays(day, -120),
    });
    await expense({
      amount: 40_000,
      merchant: "Categorised",
      categoryId: categoryId("Groceries"),
    });
    const ws = ctx.workspaceId;
    await items.upsert({
      workspaceId: ws,
      kind: "duplicate",
      title: "Possible duplicate",
      data: { transactionIds: [] },
      dedupeKey: "d1",
    });
    await items.upsert({
      workspaceId: ws,
      kind: "anomaly",
      title: "Spike",
      dedupeKey: "a1",
      data: { href: "/transactions?categoryId=x" },
    });
    await items.upsert({
      workspaceId: ws,
      kind: "large_transaction",
      title: "Large",
      dedupeKey: "a2",
    });
    await items.upsert({
      workspaceId: ws,
      kind: "recurring_candidate",
      title: "Netflix monthly",
      dedupeKey: "r1",
    });
    await items.upsert({
      workspaceId: ws,
      kind: "integration_error",
      title: "Sync failed",
      dedupeKey: "i1",
    });
    await items.upsert({
      workspaceId: ws,
      kind: "budget_warning",
      title: "Budget at 90%",
      dedupeKey: "b1",
    });
    await items.upsert({
      workspaceId: ws,
      kind: "observation",
      title: "Note",
      dedupeKey: "o1",
    });
    const dismissed = await items.upsert({
      workspaceId: ws,
      kind: "anomaly",
      title: "Old spike",
      dedupeKey: "a3",
    });
    await inbox.act(ctx, dismissed as string, { action: "dismiss" });

    const view = await inbox.overview(ctx, {});
    expect(view.summary).toEqual({
      needsReview: 1,
      uncategorized: 1,
      duplicates: 1,
      recurring: 1,
      anomalies: 2,
      integrationErrors: 1,
      warnings: 1,
      observations: 1,
    });
    expect(view.drafts).toHaveLength(1);
    expect(view.drafts[0]).toMatchObject({
      merchant: "Shwapno",
      status: "draft",
      accountName: "bKash",
    });
    expect(view.items).toHaveLength(7);
    expect(view.items.find((item) => item.kind === "anomaly")?.actions).toEqual(expect.arrayContaining(["resolve", "dismiss", "snooze", "view_transactions"]));

    const anomalies = await inbox.overview(ctx, {
      kind: "anomaly,large_transaction",
    });
    expect(anomalies.items.map((item) => item.kind).sort()).toEqual(["anomaly", "large_transaction"]);
    const closed = await inbox.overview(ctx, { status: "dismissed" });
    expect(closed.items.map((item) => item.title)).toEqual(["Old spike"]);
  });

  it("snoozes and reopens an item", async () => {
    const id = (await items.upsert({
      workspaceId: ctx.workspaceId,
      kind: "observation",
      title: "Later",
      dedupeKey: "s1",
    })) as string;
    const snoozed = await inbox.act(ctx, id, {
      action: "snooze",
      snoozeDays: 3,
    });
    expect(snoozed.status).toBe("snoozed");
    expect((await inbox.overview(ctx, {})).items).toHaveLength(0);
    const reopened = await inbox.act(ctx, id, { action: "reopen" });
    expect(reopened).toMatchObject({ status: "open", snoozedUntil: null });
  });

  it("resolves a duplicate by voiding the one not kept", async () => {
    const first = await expense({
      amount: 55_000,
      merchant: "Daraz",
      reference: "DRZ55000A",
    });
    const second = await expense({
      amount: 55_000,
      merchant: "Daraz",
      reference: "DRZ55000A",
    });
    const id = (await items.upsert({
      workspaceId: ctx.workspaceId,
      kind: "duplicate",
      title: "Daraz twice",
      data: { transactionIds: [first.id, second.id] },
      dedupeKey: "dup",
    })) as string;
    const result = await inbox.resolveDuplicate(ctx, id, { keep: "first" });
    expect(result.voidedTransactionId).toBe(second.id);
    expect(result.item).toMatchObject({ status: "resolved" });
    const [voided] = await db.select().from(transactions).where(eq(transactions.id, second.id));
    const [kept] = await db.select().from(transactions).where(eq(transactions.id, first.id));
    expect(voided?.status).toBe("void");
    expect(kept?.status).toBe("posted");

    const bothId = (await items.upsert({
      workspaceId: ctx.workspaceId,
      kind: "duplicate",
      title: "Pair",
      data: { transactionIds: [first.id, second.id] },
      dedupeKey: "dup2",
    })) as string;
    const both = await inbox.resolveDuplicate(ctx, bothId, { keep: "both" });
    expect(both.voidedTransactionId).toBeNull();
  });

  it("tracks a recurring candidate as a subscription linked to the latest charge", async () => {
    const charges = [];
    for (const offset of [3, 2, 1])
      charges.push(
        await expense({
          amount: 120_000,
          merchant: "Netflix",
          date: addMonths(addDays(day, -5), -offset + 1),
        }),
      );
    const latest = charges[charges.length - 1];
    const id = (await items.upsert({
      workspaceId: ctx.workspaceId,
      kind: "recurring_candidate",
      title: "Recurring monthly payment to Netflix",
      data: {
        merchant: "Netflix",
        cadence: "monthly",
        amount: 120_000,
        currency: "BDT",
        nextExpected: addMonths(latest?.date as string, 1),
        transactionIds: charges.map((c) => c.id),
      },
      dedupeKey: "recurring:netflix",
    })) as string;
    const result = await inbox.track(ctx, id, { kind: "subscription" });
    expect(result).toMatchObject({
      kind: "subscription",
      purchaseTransactionId: latest?.id,
    });
    expect(result.item.status).toBe("resolved");
    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ctx.workspaceId));
    expect(subscription?.provider).toBe("Netflix");
  });

  it("suggests categories for uncategorised spending from memory and keywords, and asks the model for the rest in one batch", async () => {
    const groceries = categoryId("Groceries");
    const restaurants = categoryId("Restaurants");
    // Merchant memory: Unimart has been confirmed as Groceries.
    const learned = await expense({
      amount: 80_000,
      merchant: "Unimart",
      categoryId: groceries,
    });
    await db
      .update(counterparties)
      .set({ defaultCategoryId: groceries, confirmations: 3 })
      .where(eq(counterparties.id, learned.counterpartyId as string));
    const fromMemory = await expense({ amount: 90_000, merchant: "Unimart" });
    const fromKeyword = await expense({
      amount: 45_000,
      merchant: "Foodpanda",
    });
    const fromModel = await expense({
      amount: 25_000,
      merchant: "Kacchi Bhai Dhanmondi",
    });
    provider.onClassify = (input: ClassifyInput) =>
      ok({
        items: input.items.map((item) => ({
          id: item.id,
          category: "Restaurants",
          project: null,
          confidence: 0.9,
        })),
      });

    const view = await inbox.uncategorized(ctx, {});
    expect(view.total).toBe(3);
    const byId = new Map(view.items.map((item) => [item.transaction.id, item.suggestion]));
    expect(byId.get(fromMemory.id)).toMatchObject({
      categoryId: groceries,
      source: "merchant",
      confidence: 0.95,
    });
    expect(byId.get(fromKeyword.id)).toMatchObject({
      categoryId: restaurants,
      source: "parser",
    });
    expect(byId.get(fromModel.id)).toMatchObject({
      categoryId: restaurants,
      source: "ai",
      confidence: 0.85,
    });
    expect(provider.count("classify")).toBe(1);
    expect((provider.calls[0]?.input as ClassifyInput | undefined)?.items.map((item) => item.id)).toEqual([fromModel.id]);
    expect(view.ai).toMatchObject({ used: true });
    expect(
      await db
        .select()
        .from(aiUsage)
        .where(and(eq(aiUsage.workspaceId, ctx.workspaceId), eq(aiUsage.feature, "classify"))),
    ).toHaveLength(1);

    const applied = await inbox.applyCategories(ctx, {
      items: [{ transactionId: fromModel.id, categoryId: restaurants }],
    });
    expect(applied).toEqual({ updated: 1, failures: [] });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, fromModel.id));
    expect(row?.categoryId).toBe(restaurants);
    const [memory] = await db
      .select()
      .from(counterparties)
      .where(eq(counterparties.id, row?.counterpartyId as string));
    expect(memory?.defaultCategoryId).toBe(restaurants);
    expect((await inbox.summary(ctx)).uncategorized).toBe(2);
  });

  it("does not call the model for suggestions when AI is off", async () => {
    await expense({ amount: 25_000, merchant: "Kacchi Bhai Dhanmondi" });
    provider.available = false;
    const view = await inbox.uncategorized(ctx, {});
    expect(view.ai).toMatchObject({
      used: false,
      reason: "AI is not configured",
    });
    expect(provider.count("classify")).toBe(0);
  });

  it("keeps each workspace's inbox to itself", async () => {
    const id = (await items.upsert({
      workspaceId: ctx.workspaceId,
      kind: "observation",
      title: "Mine",
      dedupeKey: "mine",
    })) as string;
    const other = await createUser("Other Person");
    await expect(inbox.act(other.personal, id, { action: "dismiss" })).rejects.toMatchObject({ status: 404 });
    await expect(inbox.act(user.business, id, { action: "dismiss" })).rejects.toMatchObject({ status: 404 });
    expect((await inbox.overview(other.personal, {})).items).toHaveLength(0);
    const [row] = await db.select().from(inboxItems).where(eq(inboxItems.id, id));
    expect(row?.status).toBe("open");
  });
});
