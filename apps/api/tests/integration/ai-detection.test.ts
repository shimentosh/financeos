import { addDays, addMonths, startOfMonth, today } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { categories, commitmentOccurrences, inboxItems } from "../../src/db/schema/index.js";
import { DetectionService } from "../../src/modules/ai/detection/detection.service.js";
import { AiInboxService } from "../../src/modules/ai/inbox/ai-inbox.service.js";
import { SchedulerService } from "../../src/modules/jobs/scheduler.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { CommitmentsService } from "../../src/modules/planning/commitments.service.js";
import { JobsService } from "../../src/modules/system/jobs.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider } from "../fixtures/ai/fake-provider.js";
import { asSystem, createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let detection: DetectionService;
let ledger: TransactionsService;
let user: TestUser;
let ctx: WorkspaceContext;
let bkash: string;
const day = today("Asia/Dhaka");
const thisMonth = startOfMonth(day);

beforeAll(async () => {
  app = await aiApp(provider);
  detection = app.service(DetectionService);
  ledger = app.service(TransactionsService);
});

afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Tahmid Hasan");
  ctx = user.personal;
  bkash = (
    await app.service(AccountsService).create(ctx, {
      name: "bKash",
      kind: "mobile_wallet",
      provider: "bkash",
      currency: "BDT",
      openingBalance: 50_000_000,
      openingDate: addMonths(day, -14),
    })
  ).id;
});

const spend = async (amount: number, date: string, merchant: string, categoryId: string | null = null, context: WorkspaceContext = ctx, accountId = bkash) =>
  (
    await ledger.create(context, {
      type: "expense",
      accountId,
      amount,
      currency: "BDT",
      date,
      merchant,
      categoryId,
    })
  ).transaction;

const openItems = (kind: "recurring_candidate" | "anomaly" | "duplicate", workspaceId = ctx.workspaceId) =>
  db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.kind, kind)));

describe("recurring detection", () => {
  it("files each untracked recurring charge once and skips merchants already tracked", async () => {
    for (const months of [4, 3, 2, 1]) {
      await spend(120_000, addDays(addMonths(day, -months), 3), "Netflix");
      await spend(29_900, addDays(addMonths(day, -months), 5), "Spotify");
    }
    await app.service(CommitmentsService).create(ctx, {
      kind: "subscription",
      name: "Spotify",
      payee: "Spotify",
      amount: 29_900,
      currency: "BDT",
      frequency: "monthly",
      startDate: addDays(addMonths(day, -4), 5),
      nextDueDate: addDays(day, 5),
    });

    const system = asSystem(ctx);
    const first = await detection.recurring(system);
    expect(first).toMatchObject({
      candidates: 2,
      upserted: 1,
      skippedCovered: 1,
    });
    const again = await detection.recurring(system);
    expect(again.upserted).toBe(1);

    const items = await openItems("recurring_candidate");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      dedupeKey: "recurring:netflix",
      status: "open",
      title: "Recurring monthly payment to Netflix",
    });
    expect(items[0]?.data).toMatchObject({
      cadence: "monthly",
      amount: 120_000,
      currency: "BDT",
      occurrences: 4,
    });
    expect(items[0]?.data.transactionIds).toHaveLength(4);
    expect(items[0]?.data.href).toMatch(/^\/transactions\?counterpartyId=[^&]+&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);

    // A dismissed finding stays dismissed.
    await app.service(AiInboxService).act(ctx, items[0]?.id as string, { action: "dismiss" });
    await detection.recurring(system);
    const after = await openItems("recurring_candidate");
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe("dismissed");
  });
});

describe("recurring detection noise", () => {
  it("never proposes payroll, commitment payments or salaries as a subscription", async () => {
    const netflix: string[] = [];
    const internet: Array<{ id: string; date: string }> = [];
    for (const months of [4, 3, 2, 1]) {
      const month = addMonths(day, -months);
      netflix.push((await spend(120_000, addDays(month, 3), "Netflix")).id);
      // Salaries paid by a payroll run.
      await ledger.create(
        ctx,
        {
          type: "expense",
          accountId: bkash,
          amount: 4_500_000,
          currency: "BDT",
          date: addDays(month, 1),
          merchant: "Rafi Hasan",
        },
        { metadata: { payrollRunId: `run-${months}` } },
      );
      // A bill already settled through a tracked commitment under another name.
      const bill = await spend(150_000, addDays(month, 7), "Link3 Technologies");
      internet.push({ id: bill.id, date: bill.date });
    }
    const commitment = await app.service(CommitmentsService).create(ctx, {
      kind: "utility",
      name: "Home broadband",
      amount: 150_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: internet[0]?.date as string,
      nextDueDate: addDays(day, 20),
    });
    await db.insert(commitmentOccurrences).values(
      internet.map((bill) => ({
        workspaceId: ctx.workspaceId,
        commitmentId: commitment.id,
        dueDate: bill.date,
        amount: 150_000,
        currency: "BDT",
        status: "paid" as const,
        transactionId: bill.id,
        paidOn: bill.date,
        paidAmount: 150_000,
      })),
    );

    const result = await detection.recurring(asSystem(ctx));
    expect(result).toMatchObject({ candidates: 1, upserted: 1 });
    const items = await openItems("recurring_candidate");
    expect(items.map((item) => item.data.merchant)).toEqual(["Netflix"]);
    expect([...(items[0]?.data.transactionIds ?? [])].sort()).toEqual([...netflix].sort());
  });
});

describe("anomaly detection", () => {
  it("flags a truly large payment but not a slightly bigger fee", async () => {
    const [fees] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.name, "Fees & Charges")));
    for (const back of [100, 70, 40]) {
      await spend(17_200, addDays(day, -back), "Stripe");
      await spend(500_000, addDays(day, -back), "Star Tech");
      await spend(10_000, addDays(day, -back), "Bank charge", fees?.id);
    }
    // ৳600 against a usual ৳172: three times as much, but only ৳428 more.
    await spend(60_000, addDays(day, -2), "Stripe");
    // ৳50 against ৳100 of charges is fine; ৳5,000 would be large, but fees never are.
    await spend(500_000, addDays(day, -2), "Bank charge", fees?.id);
    const laptop = await spend(6_000_000, addDays(day, -2), "Star Tech");

    const result = await detection.anomalies(asSystem(ctx));
    const large = (await openItems("anomaly")).filter((item) => item.data.metric === "large_transaction");
    expect(large).toHaveLength(1);
    expect(large[0]).toMatchObject({
      title: "Unusually large payment to Star Tech",
      dedupeKey: `anomaly:large:${laptop.id}`,
    });
    expect(large[0]?.data.transactionIds).toEqual([laptop.id]);
    expect(result.byKind.large_transaction).toBe(1);
  });

  it("flags a category spike with the transactions behind it, once per period", async () => {
    const [groceries] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.name, "Groceries")));
    const [rent] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.name, "Rent")));
    const lastMonth = addMonths(thisMonth, -1);
    // Five ordinary months, then a month where groceries quadruple.
    for (const back of [6, 5, 4, 3, 2]) {
      const month = addMonths(thisMonth, -back);
      await spend(1_000_000, addDays(month, 2), "Shwapno", groceries?.id);
      await spend(3_000_000, addDays(month, 1), "Landlord", rent?.id);
    }
    const spikeIds = [
      (await spend(2_000_000, addDays(lastMonth, 3), "Shwapno", groceries?.id)).id,
      (await spend(2_000_000, addDays(lastMonth, 12), "Meena Bazar", groceries?.id)).id,
    ];
    await spend(3_000_000, addDays(lastMonth, 1), "Landlord", rent?.id);

    const system = asSystem(ctx);
    const result = await detection.anomalies(system);
    expect(result.byKind.category_spike).toBe(1);
    await detection.anomalies(system);

    const items = (await openItems("anomaly")).filter((item) => item.data.metric === "category_spike");
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.title).toBe("Groceries spending is 300% above normal");
    expect(item?.data).toMatchObject({
      categoryId: groceries?.id,
      expected: 1_000_000,
      actual: 4_000_000,
      currency: "BDT",
    });
    expect([...(item?.data.transactionIds ?? [])].sort()).toEqual([...spikeIds].sort());
    expect(item?.data.href).toBe(`/transactions?categoryId=${groceries?.id}&from=${lastMonth}&to=${addDays(thisMonth, -1)}`);
    expect(item?.dedupeKey).toBe(`anomaly:category_spike:${groceries?.id}:${lastMonth.slice(0, 7)}`);
  });

  it("flags a possible duplicate recorded in the last few days", async () => {
    const first = await spend(75_000, addDays(day, -1), "Daraz");
    const second = await spend(75_000, addDays(day, -1), "Daraz");
    await detection.anomalies(asSystem(ctx));
    const items = await openItems("duplicate");
    expect(items).toHaveLength(1);
    expect([...(items[0]?.data.transactionIds ?? [])].sort()).toEqual([first.id, second.id].sort());
    expect(items[0]?.data.href).toMatch(/^\/transactions\?ids=[^&]+&period=all_time$/);
  });

  it("registers daily jobs that fan out one job per workspace", async () => {
    const scheduler = app.service(SchedulerService);
    const tasks = scheduler.list().filter((task) => task.name.startsWith("ai."));
    expect(tasks.map((task) => [task.name, task.cron])).toEqual(
      expect.arrayContaining([
        ["ai.recurring", "0 3 * * *"],
        ["ai.anomalies", "0 4 * * *"],
      ]),
    );
    const jobs = app.service(JobsService);
    expect(jobs.registeredTypes()).toEqual(expect.arrayContaining(["ai.recurring", "ai.anomalies", "ai.capture", "ai.capture.followup"]));
    await scheduler.runTask("ai.recurring");
    await scheduler.runTask("ai.recurring");
    const queued = (await jobs.recent(50)).filter((job) => job.type === "ai.recurring");
    // Personal + business workspace, deduplicated by day.
    expect(queued).toHaveLength(2);
    expect(await jobs.runDue(10)).toBeGreaterThanOrEqual(2);
  });
});
