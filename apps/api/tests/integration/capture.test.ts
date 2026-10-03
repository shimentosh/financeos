import { addDays, addMonths, today } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import {
  aiUsage,
  captures,
  categories,
  commitmentOccurrences,
  counterparties,
  inboxItems,
  ledgerEntries,
  subscriptions,
  transactions,
} from "../../src/db/schema/index.js";
import { CaptureService } from "../../src/modules/ai/capture/capture.service.js";
import { AiProviderError, type ExtractInput } from "../../src/modules/ai/gateway/types.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { extracted, extraction, FakeProvider, ok, png } from "../fixtures/ai/fake-provider.js";
import { createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let capturesService: CaptureService;
let transactionsService: TransactionsService;
let accounts: AccountsService;
let user: TestUser;
let ctx: WorkspaceContext;
let bkash: string;
let restaurants: string;
const day = today("Asia/Dhaka");
const yesterday = addDays(day, -1);

const upload = async (buffer: Buffer, kind?: "screenshot" | "receipt" | "pdf", context: WorkspaceContext = ctx) =>
  capturesService.createFromUpload(context, { buffer, filename: "screen.png", contentType: "image/png" }, kind);

const usageRows = () => db.select().from(aiUsage).where(eq(aiUsage.workspaceId, ctx.workspaceId));

const bkashPayment = (overrides: Parameters<typeof extracted>[0] = {}) =>
  extracted({
    amount: 1250,
    currency: "৳",
    date: yesterday,
    time: "1:45 pm",
    merchant: "Star Kabab",
    reference: "BGH7K2L9QX",
    paymentMethod: "bkash",
    description: "Payment",
    ...overrides,
  });

beforeAll(async () => {
  app = await aiApp(provider);
  capturesService = app.service(CaptureService);
  transactionsService = app.service(TransactionsService);
  accounts = app.service(AccountsService);
});

afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  provider.reset();
  user = await createUser("Nusrat Jahan");
  ctx = user.personal;
  bkash = (
    await accounts.create(ctx, {
      name: "bKash",
      kind: "mobile_wallet",
      provider: "bkash",
      currency: "BDT",
      openingBalance: 5_000_000,
      openingDate: addDays(day, -60),
    })
  ).id;
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.name, "Restaurants")));
  restaurants = row?.id as string;
});

describe("text captures", () => {
  it("reads a clear note with the parser alone: no model call, no usage row", async () => {
    const view = await capturesService.createFromText(ctx, {
      text: "Paid 1200 tk at Star Kabab today with bkash",
      kind: "text",
    });
    expect(view.capture).toMatchObject({
      stage: "suggested",
      method: "parser",
      kind: "text",
    });
    expect(view.drafts).toHaveLength(1);
    expect(view.drafts[0]?.transaction).toMatchObject({
      status: "draft",
      amount: 120_000,
      currency: "BDT",
      date: day,
      accountId: bkash,
      merchant: "Star Kabab",
    });
    expect(view.drafts[0]?.confidence?.sources?.amount).toBe("parser");
    expect(provider.calls).toHaveLength(0);
    expect(await usageRows()).toHaveLength(0);
  });

  it("asks the model when the parser is unsure, and shows confidence and missing fields", async () => {
    provider.onExtract = () =>
      ok(
        extraction(
          [
            extracted({
              amount: 500,
              currency: "Tk",
              date: yesterday,
              merchant: "Rahim",
              suggestedCategory: "Restaurants",
              confidence: {
                amount: 0.95,
                currency: 0.9,
                date: 0.9,
                merchant: 0.7,
                category: 0.7,
                type: 0.85,
                paymentMethod: 0,
              },
            }),
          ],
          {},
          ["The note does not say how it was paid."],
        ),
      );
    await accounts.create(ctx, {
      name: "City Visa",
      kind: "card",
      currency: "BDT",
      openingDate: addDays(day, -60),
    });
    const view = await capturesService.createFromText(ctx, {
      text: "gave 500 to rahim for lunch yesterday",
      kind: "voice",
    });

    expect(provider.count("extract")).toBe(1);
    const input = provider.calls[0]?.input as ExtractInput;
    expect(input).toMatchObject({
      kind: "text",
      sourceKind: "voice",
      text: "gave 500 to rahim for lunch yesterday",
    });
    expect(input.hints.today).toBe(day);
    expect(input.hints.accounts.map((a) => a.name)).toEqual(expect.arrayContaining(["Cash", "bKash", "City Visa"]));

    expect(view.capture).toMatchObject({
      stage: "suggested",
      method: "ai",
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(view.capture.costUsd).toBeGreaterThan(0);
    const draft = view.drafts[0];
    expect(draft?.transaction).toMatchObject({
      amount: 50_000,
      currency: "BDT",
      date: yesterday,
      merchant: "Rahim",
      categoryId: restaurants,
      accountId: null,
    });
    expect(draft?.missing).toEqual(["account"]);
    expect(draft?.lowConfidence).toContain("merchant");
    expect(draft?.confidence).toMatchObject({
      overall: 0,
      model: "claude-opus-5",
    });
    expect(draft?.confidence?.fields.amount).toBe(0.95);
    expect(draft?.suggestions.category).toMatchObject({
      id: restaurants,
      source: "ai",
    });
    expect(draft?.transaction.reviewReason).toMatch(/Needs account/);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "capture.extract",
      status: "ok",
      model: "claude-opus-5",
      inputTokens: 1_800,
    });
  });
});

describe("screenshots", () => {
  it("reads a bKash payment: the bKash account, the TrxID, and the existing transaction with the same TrxID", async () => {
    const { transaction: existing } = await transactionsService.create(ctx, {
      type: "expense",
      accountId: bkash,
      amount: 125_000,
      currency: "BDT",
      date: yesterday,
      merchant: "Star Kabab",
      reference: "BGH7K2L9QX",
    });
    provider.onExtract = () => ok(extraction([bkashPayment()]));

    const view = await upload(await png());
    const input = provider.calls[0]?.input as Extract<ExtractInput, { kind: "image" }>;
    expect(input.kind).toBe("image");
    expect(input.mimeType).toBe("image/jpeg");
    expect(input.data.subarray(0, 2).toString("hex")).toBe("ffd8");

    expect(view.capture).toMatchObject({
      stage: "suggested",
      method: "ai",
      kind: "screenshot",
      fileUrl: `/api/files/${view.capture.fileId}`,
    });
    expect(view.capture.file?.contentType).toBe("image/png");
    const draft = view.drafts[0];
    expect(draft?.transaction).toMatchObject({
      accountId: bkash,
      reference: "BGH7K2L9QX",
      amount: 125_000,
      currency: "BDT",
      date: yesterday,
      accountName: "bKash",
    });
    expect(draft?.transaction.occurredAt).toBe(new Date(`${yesterday}T13:45:00+06:00`).toISOString());
    expect(draft?.suggestions.account).toMatchObject({
      id: bkash,
      source: "ai",
    });
    expect(draft?.duplicates[0]).toMatchObject({
      transactionId: existing.id,
      exact: true,
    });
    expect(draft?.transaction.reviewReason).toMatch(/Possible duplicate/);

    // Confirming re-checks duplicates and refuses unless told to go ahead.
    const item = {
      id: draft?.transaction.id as string,
      type: "expense" as const,
      accountId: bkash,
      amount: 125_000,
      currency: "BDT",
      date: yesterday,
      merchant: "Star Kabab",
      reference: "BGH7K2L9QX",
    };
    await expect(capturesService.confirm(ctx, view.capture.id, { transactions: [item] })).rejects.toMatchObject({ code: "possible_duplicate" });
    const confirmed = await capturesService.confirm(ctx, view.capture.id, {
      transactions: [item],
      allowDuplicates: true,
      subscription: null,
    });
    expect(confirmed.postedTransactionIds).toEqual([item.id]);
  });

  it("flags the same file uploaded twice without paying to read it again", async () => {
    provider.onExtract = () => ok(extraction([bkashPayment({ reference: null })]));
    const image = await png({ r: 10, g: 200, b: 30 });
    const first = await upload(image);
    const second = await upload(image);
    expect(provider.count("extract")).toBe(1);
    expect(second.capture).toMatchObject({
      stage: "suggested",
      method: "duplicate",
    });
    expect(second.drafts).toHaveLength(0);
    expect(second.duplicateOf).toMatchObject({
      captureId: first.capture.id,
      transactionIds: first.drafts.map((d) => d.transaction.id),
    });

    const forced = await capturesService.retry(ctx, second.capture.id, {
      force: true,
    });
    expect(provider.count("extract")).toBe(2);
    expect(forced.capture.method).toBe("ai");
    expect(forced.drafts[0]?.duplicates[0]?.transactionId).toBe(first.drafts[0]?.transaction.id);
  });

  it("confirms into the ledger, learns the merchant, and categorises the next note from memory without AI", async () => {
    provider.onExtract = () => ok(extraction([bkashPayment({ reference: null })]));
    const view = await upload(await png({ r: 1, g: 2, b: 3 }));
    const draft = view.drafts[0];
    expect(draft?.transaction.categoryId).toBeNull();

    const result = await capturesService.confirm(ctx, view.capture.id, {
      transactions: [
        {
          id: draft?.transaction.id as string,
          type: "expense",
          accountId: bkash,
          amount: 125_000,
          currency: "BDT",
          date: yesterday,
          merchant: "Star Kabab",
          categoryId: restaurants,
        },
      ],
      rememberMerchant: true,
      subscription: null,
    });
    expect(result.capture.capture.stage).toBe("confirmed");
    expect(result.capture.drafts[0]?.transaction).toMatchObject({
      status: "posted",
      categoryId: restaurants,
    });
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, draft?.transaction.id as string));
    expect(entries).toHaveLength(1);
    const [memory] = await db
      .select()
      .from(counterparties)
      .where(and(eq(counterparties.workspaceId, ctx.workspaceId), eq(counterparties.name, "Star Kabab")));
    expect(memory).toMatchObject({
      defaultCategoryId: restaurants,
      confirmations: 1,
    });

    const usageBefore = (await usageRows()).length;
    const next = await capturesService.createFromText(ctx, {
      text: "Paid 450 tk at Star Kabab today with bkash",
      kind: "text",
    });
    expect(next.capture.method).toBe("parser");
    expect(next.drafts[0]?.transaction.categoryId).toBe(restaurants);
    expect(next.drafts[0]?.suggestions.category).toMatchObject({
      source: "merchant",
    });
    expect(next.drafts[0]?.confidence?.sources?.category).toBe("merchant");
    expect(provider.count("extract")).toBe(1);
    expect((await usageRows()).length).toBe(usageBefore);
  });

  it("leaves merchant memory alone when asked not to remember", async () => {
    provider.onExtract = () => ok(extraction([bkashPayment({ reference: null, merchant: "Kacchi Bhai" })]));
    const view = await upload(await png({ r: 9, g: 9, b: 9 }));
    await capturesService.confirm(ctx, view.capture.id, {
      transactions: [
        {
          id: view.drafts[0]?.transaction.id as string,
          type: "expense",
          accountId: bkash,
          amount: 125_000,
          currency: "BDT",
          date: yesterday,
          merchant: "Kacchi Bhai",
          categoryId: restaurants,
        },
      ],
      rememberMerchant: false,
      subscription: null,
    });
    const [memory] = await db
      .select()
      .from(counterparties)
      .where(and(eq(counterparties.workspaceId, ctx.workspaceId), eq(counterparties.name, "Kacchi Bhai")));
    expect(memory).toMatchObject({ defaultCategoryId: null, confirmations: 0 });
  });

  it("discards a capture and its drafts", async () => {
    provider.onExtract = () => ok(extraction([bkashPayment({ reference: null })]));
    const view = await upload(await png({ r: 90, g: 90, b: 90 }));
    const draftId = view.drafts[0]?.transaction.id as string;
    const discarded = await capturesService.discard(ctx, view.capture.id);
    expect(discarded.capture.stage).toBe("discarded");
    expect(discarded.drafts).toHaveLength(0);
    expect(await db.select().from(transactions).where(eq(transactions.id, draftId))).toHaveLength(0);
    await expect(
      capturesService.confirm(ctx, view.capture.id, {
        transactions: [
          {
            type: "expense",
            accountId: bkash,
            amount: 1,
            currency: "BDT",
            date: day,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "capture_not_reviewable",
    });
  });

  it("auto-posts only when the workspace allows it and every required field is near-certain", async () => {
    provider.onExtract = () => ok(extraction([bkashPayment({ reference: "ZZ12345678" })]));
    const auto = {
      ...ctx,
      settings: { ...ctx.settings, autoPostHighConfidence: true },
    };
    const view = await upload(await png({ r: 50, g: 60, b: 70 }), "screenshot", auto);
    expect(view.capture.stage).toBe("posted");
    expect(view.drafts[0]?.transaction.status).toBe("posted");
    expect(view.postedTransactionIds).toHaveLength(1);
  });
});

describe("when the model cannot help", () => {
  it("falls back to manual entry on a refusal, and posts what the person types", async () => {
    provider.onExtract = () => ({
      status: "refusal",
      usage: {
        inputTokens: 900,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: "claude-opus-5",
      costUsd: 0.0045,
      message: "Declined",
      category: null,
    });
    const view = await upload(await png({ r: 200, g: 200, b: 0 }), "receipt");
    expect(view.capture).toMatchObject({
      stage: "suggested",
      method: "manual",
      kind: "receipt",
      fallbackReason: "Declined",
    });
    expect(view.drafts).toHaveLength(0);
    expect((await usageRows())[0]).toMatchObject({ status: "refusal" });

    const result = await capturesService.confirm(ctx, view.capture.id, {
      transactions: [
        {
          type: "expense",
          accountId: bkash,
          amount: 30_000,
          currency: "BDT",
          date: day,
          merchant: "Pharmacy",
        },
      ],
    });
    expect(result.postedTransactionIds).toHaveLength(1);
    const [posted] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, result.postedTransactionIds[0] as string));
    expect(posted).toMatchObject({
      status: "posted",
      source: "receipt",
      sourceRef: view.capture.id,
      attachmentFileId: view.capture.fileId,
    });
  });

  it("does not call the model when this month's budget is spent", async () => {
    const limited = {
      ...ctx,
      settings: { ...ctx.settings, aiMonthlyBudgetUsd: 1 },
    };
    await db.insert(aiUsage).values({
      workspaceId: ctx.workspaceId,
      feature: "capture.extract",
      provider: "anthropic",
      model: "claude-opus-5",
      costUsd: "1.500000",
      status: "ok",
    });
    const view = await upload(await png({ r: 3, g: 3, b: 3 }), "screenshot", limited);
    expect(provider.count("extract")).toBe(0);
    expect(view.capture).toMatchObject({
      method: "manual",
      fallbackReason: "This month's AI budget is used up",
    });
    expect((await usageRows()).map((row) => row.status)).toContain("budget");
  });

  it("fails a capture on a temporary provider error and succeeds on retry", async () => {
    provider.onExtract = () => {
      throw new AiProviderError("overloaded", "The AI provider is overloaded");
    };
    const failed = await upload(await png({ r: 7, g: 70, b: 170 }));
    expect(failed.capture).toMatchObject({
      stage: "failed",
      retryable: true,
      error: "The AI provider is overloaded",
    });

    provider.onExtract = () => ok(extraction([bkashPayment({ reference: null })]));
    const retried = await capturesService.retry(ctx, failed.capture.id);
    expect(retried.capture.stage).toBe("suggested");
    expect(retried.drafts).toHaveLength(1);
    // Processing is idempotent: running it again changes nothing.
    await capturesService.process(ctx, failed.capture.id);
    expect((await capturesService.view(ctx, failed.capture.id)).drafts).toHaveLength(1);
  });
});

describe("subscriptions", () => {
  const netflix = () =>
    ok(
      extraction(
        [
          bkashPayment({
            merchant: "Netflix",
            amount: 1200,
            reference: "NFX9981234",
            paymentMethod: "bkash",
            description: "Netflix Standard plan",
          }),
        ],
        {
          isSubscription: true,
          provider: "Netflix",
          plan: "Standard",
          billingCycle: "monthly",
          purchaseDate: yesterday,
          renewalDate: addDays(yesterday, 30),
          autoRenew: "yes",
          transactionIndex: 0,
          confidence: 0.9,
        },
      ),
    );

  it("suggests tracking and links the posted expense as the purchase (no second expense)", async () => {
    provider.onExtract = netflix;
    const view = await upload(await png({ r: 229, g: 9, b: 20 }));
    expect(view.capture.isSubscription).toBe(true);
    expect(view.subscription).toMatchObject({
      provider: "Netflix",
      planName: "Standard",
      billingCycle: "monthly",
      nextRenewalDate: addDays(yesterday, 30),
      autoRenew: true,
      renewalDateEstimated: false,
      transactionIndex: 0,
    });
    const draft = view.drafts[0];
    expect(draft?.subscription?.provider).toBe("Netflix");

    const result = await capturesService.confirm(ctx, view.capture.id, {
      transactions: [
        {
          id: draft?.transaction.id as string,
          type: "expense",
          accountId: bkash,
          amount: 120_000,
          currency: "BDT",
          date: yesterday,
          merchant: "Netflix",
        },
      ],
      subscription: {
        provider: "Netflix",
        planName: "Standard",
        billingCycle: "monthly",
        nextRenewalDate: addDays(yesterday, 30),
        autoRenew: true,
      },
    });
    expect(result.subscription.status).toBe("created");
    const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ctx.workspaceId));
    expect(subscription).toMatchObject({
      provider: "Netflix",
      planName: "Standard",
    });
    const occurrences = await db
      .select()
      .from(commitmentOccurrences)
      .where(eq(commitmentOccurrences.commitmentId, subscription?.commitmentId as string));
    expect(occurrences.find((o) => o.status === "paid")?.transactionId).toBe(draft?.transaction.id);
    const expenses = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.type, "expense"), eq(transactions.status, "posted")));
    expect(expenses).toHaveLength(1);
  });

  it("leaves an undecided subscription in the AI Inbox instead of creating it", async () => {
    provider.onExtract = netflix;
    const view = await upload(await png({ r: 1, g: 99, b: 1 }));
    // Nobody decided within a day: the follow-up job files it.
    await capturesService.followUp(view.capture.id);
    let items = await db.select().from(inboxItems).where(eq(inboxItems.workspaceId, ctx.workspaceId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "subscription_candidate",
      status: "open",
      dedupeKey: `capture-subscription:${view.capture.id}`,
    });
    // The web review screen lives at /capture/:id (the REST resource is /captures).
    expect(items[0]?.data.href).toBe(`/capture/${view.capture.id}`);

    const result = await capturesService.confirm(ctx, view.capture.id, {
      transactions: [
        {
          id: view.drafts[0]?.transaction.id as string,
          type: "expense",
          accountId: bkash,
          amount: 120_000,
          currency: "BDT",
          date: yesterday,
          merchant: "Netflix",
        },
      ],
    });
    expect(result.subscription).toMatchObject({ status: "deferred" });
    items = await db.select().from(inboxItems).where(eq(inboxItems.workspaceId, ctx.workspaceId));
    expect(items).toHaveLength(1);
    expect(items[0]?.data.purchaseTransactionId).toBe(view.drafts[0]?.transaction.id);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ctx.workspaceId))).toHaveLength(0);
  });

  it("detects a known provider with billing words even when the model does not flag it", async () => {
    const view = await capturesService.createFromText(ctx, {
      text: "Paid 1200 tk for Netflix monthly subscription today with bkash",
      kind: "text",
    });
    expect(view.capture.method).toBe("parser");
    expect(view.subscription).toMatchObject({
      provider: "Netflix",
      billingCycle: "monthly",
      source: "heuristic",
      renewalDateEstimated: true,
      nextRenewalDate: addMonths(day, 1),
    });
  });
});

describe("isolation", () => {
  it("never shows or confirms another workspace's capture", async () => {
    provider.onExtract = () => ok(extraction([bkashPayment({ reference: null })]));
    const view = await upload(await png({ r: 12, g: 34, b: 56 }));
    const other = await createUser("Someone Else");
    await expect(capturesService.view(other.personal, view.capture.id)).rejects.toMatchObject({ status: 404 });
    await expect(capturesService.view(user.business, view.capture.id)).rejects.toMatchObject({ status: 404 });
    await expect(capturesService.discard(other.personal, view.capture.id)).rejects.toMatchObject({ status: 404 });
    const listed = await capturesService.list(other.personal, {});
    expect(listed.total).toBe(0);
    const [row] = await db.select().from(captures).where(eq(captures.id, view.capture.id));
    expect(row?.stage).toBe("suggested");
  });
});
