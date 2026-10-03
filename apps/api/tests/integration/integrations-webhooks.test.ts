import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectInput } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { inboxItems, integrationConnections, jobs, syncRuns, transactions, webhookEvents } from "../../src/db/schema/index.js";
import { ConnectionsService } from "../../src/modules/integrations/connections.service.js";
import { demoPaymentsConnector } from "../../src/modules/integrations/connectors/demo-payments.js";
import { type HttpClient, jsonResponse } from "../../src/modules/integrations/connectors/http.js";
import { signFinanceOS, signTimestampedHeader } from "../../src/modules/integrations/connectors/signatures.js";
import { SyncService } from "../../src/modules/integrations/sync.service.js";
import { WebhooksService } from "../../src/modules/integrations/webhooks.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { JobsService } from "../../src/modules/system/jobs.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

const fixture = (name: string) => readFileSync(resolve(__dirname, "../fixtures/stripe", name));

let connections: ConnectionsService;
let webhooks: WebhooksService;
let sync: SyncService;
let jobsService: JobsService;
let accounts: AccountsService;
let user: TestUser;

beforeAll(async () => {
  connections = await service(ConnectionsService);
  webhooks = await service(WebhooksService);
  sync = await service(SyncService);
  jobsService = await service(JobsService);
  accounts = await service(AccountsService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Nusrat Jahan");
});

const connect = (ctx: WorkspaceContext, input: Record<string, unknown>, deps: { http?: HttpClient } = {}) =>
  connections.create(ctx, connectInput.parse(input), deps);
const publicIdOf = (url: string | null | undefined) => (url ?? "").split("/").pop() as string;

describe("demo payments webhooks", () => {
  async function setup() {
    const connected = await connect(user.business, { provider: "demo_payments", name: "Demo Payments", trustLevel: "trusted", syncFrequency: "manual" });
    // Skip the history: these tests are about pushed events.
    await db.delete(jobs);
    await db.delete(syncRuns);
    const secret = connected.webhook?.secret as string;
    const publicId = publicIdOf(connected.webhook?.url);
    const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connected.connection.id));
    if (!row) throw new Error("no connection");
    return { connected, secret, publicId, row };
  }

  it("processes a validly signed event once and answers a replay with duplicate", async () => {
    const { connected, secret, publicId } = await setup();
    const now = new Date();
    const event = demoPaymentsConnector.buildTestEvent?.({
      connection: {
        id: connected.connection.id,
        workspaceId: user.business.workspaceId,
        name: "Demo Payments",
        provider: "demo_payments",
        accountId: null,
        projectId: null,
        createdAt: now,
        timezone: "Asia/Dhaka",
        baseCurrency: "BDT",
        config: { currency: "USD" },
      },
      secret,
      now,
    });
    if (!event) throw new Error("no event");
    const first = await webhooks.receive(publicId, event.headers, event.rawBody, now);
    expect(first).toMatchObject({ status: "received", webhookEventId: expect.any(String) });
    const replay = await webhooks.receive(publicId, event.headers, event.rawBody, now);
    expect(replay).toMatchObject({ status: "duplicate", eventId: first.eventId, webhookEventId: null });

    // Processing runs as a job through the sync pipeline.
    await jobsService.runDue(5);
    const [stored] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, first.webhookEventId as string));
    expect(stored).toMatchObject({ status: "processed", signatureValid: true, eventType: "charge.succeeded" });
    const imported = await db.select().from(transactions).where(eq(transactions.connectionId, connected.connection.id));
    expect(imported.map((t) => t.type).sort()).toEqual(["expense", "income"]);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.connectionId, connected.connection.id));
    expect(run).toMatchObject({ trigger: "webhook", status: "succeeded", created: 2 });
    // Processing is idempotent too.
    expect((await webhooks.process(first.webhookEventId as string)).status).toBe("processed");
    expect(await db.$count(transactions, eq(transactions.connectionId, connected.connection.id))).toBe(2);
  });

  it("rejects and records bad signatures, stale timestamps and unknown endpoints", async () => {
    const { connected, secret, publicId } = await setup();
    const body = Buffer.from(
      JSON.stringify({
        id: "evt_forged",
        type: "charge.succeeded",
        data: { object: { object: "charge", id: "ch_forged", amount: 100000, fee: 0, currency: "usd", created: 1757700000 } },
      }),
    );
    const now = new Date();
    await expect(webhooks.receive(publicId, { "x-demo-signature": signTimestampedHeader("whsec_wrong", body, now) }, body, now)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      webhooks.receive(publicId, { "x-demo-signature": signTimestampedHeader(secret, body, new Date(now.getTime() - 10 * 60_000)) }, body, now),
    ).rejects.toMatchObject({ status: 401 });
    await expect(webhooks.receive(publicId, {}, body, now)).rejects.toMatchObject({ status: 401 });
    const recorded = await db.select().from(webhookEvents).where(eq(webhookEvents.connectionId, connected.connection.id));
    expect(recorded).toHaveLength(3);
    expect(recorded.every((e) => !e.signatureValid && e.status === "failed" && e.payload === null && e.providerEventId.startsWith("unverified:"))).toBe(true);
    // A forged event with a real id cannot block the genuine one.
    const genuine = await webhooks.receive(publicId, { "x-demo-signature": signTimestampedHeader(secret, body, now) }, body, now);
    expect(genuine.status).toBe("received");
    expect(await db.$count(transactions, eq(transactions.connectionId, connected.connection.id))).toBe(0);

    await expect(webhooks.receive("wh_doesNotExist000000000000000", {}, body, now)).rejects.toMatchObject({ status: 404 });
    const events = await connections.webhookEvents(user.business, connected.connection.id);
    expect(events.filter((e) => !e.signatureValid).every((e) => e.providerEventId === null)).toBe(true);
  });

  it("sends a signed test event through the real endpoint and rotates the secret", async () => {
    const { connected, publicId } = await setup();
    const result = await connections.sendTestWebhook(user.business, connected.connection.id);
    expect(result).toMatchObject({
      eventType: "charge.succeeded",
      delivery: { status: "received" },
      processing: { status: "processed", run: { trigger: "webhook", status: "succeeded", created: 2 } },
    });

    const rotated = await connections.rotateWebhook(user.business, connected.connection.id);
    expect(rotated.secret).not.toBe(connected.webhook?.secret);
    await expect(webhooks.receive(publicId, {}, Buffer.from("{}"))).rejects.toMatchObject({ status: 404 });
    const refund = await connections.sendTestWebhook(user.business, connected.connection.id, "charge.refunded");
    expect(refund.processing?.status).toBe("processed");
    const [refunded] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.connectionId, connected.connection.id), eq(transactions.type, "refund")));
    expect(refunded?.direction).toBe("out");

    await connections.disconnect(user.business, connected.connection.id);
    await expect(webhooks.receive(publicIdOf(rotated.url), {}, Buffer.from("{}"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("custom webhook", () => {
  it("imports signed canonical events idempotently and refuses malformed ones", async () => {
    const ctx = user.business;
    const bank = await accounts.create(ctx, { name: "BRAC Bank", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-01-01" });
    const connected = await connect(ctx, { provider: "generic_webhook", name: "My shop", accountId: bank.id });
    expect(connected.initialSyncRunId).toBeNull();
    expect(connected.connection).toMatchObject({ syncFrequency: "manual", capabilities: { sync: false, webhook: true } });
    const secret = connected.webhook?.secret as string;
    const publicId = publicIdOf(connected.webhook?.url);
    const now = new Date();
    const send = (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload));
      const { timestamp, signature } = signFinanceOS(secret, body, now);
      return webhooks.receive(publicId, { "X-FinanceOS-Timestamp": timestamp, "X-FinanceOS-Signature": signature }, body, now);
    };

    const order = {
      id: "order_1001",
      type: "revenue",
      data: {
        amount: 1499.5,
        amount_unit: "major",
        currency: "BDT",
        date: "2026-09-14",
        customer: "Rafiq Ahmed",
        product: "Handloom saree",
        category: "Product sales",
        project: "General Operations",
      },
    };
    expect(await send(order)).toMatchObject({ status: "received", eventId: "order_1001" });
    expect(await send(order)).toMatchObject({ status: "duplicate" });
    await send({
      id: "cost_77",
      type: "expense",
      data: { amount: 250000, currency: "BDT", date: "2026-09-14", vendor: "Sundarban Courier", category: "Operations" },
    });
    await jobsService.runDue(10);

    const rows = await db.select().from(transactions).where(eq(transactions.connectionId, connected.connection.id));
    expect(rows).toHaveLength(2);
    const income = rows.find((t) => t.type === "income");
    expect(income).toMatchObject({ amount: 149_950, merchant: "Rafiq Ahmed", status: "draft", externalId: "order_1001", accountId: bank.id });
    expect(income?.categoryId).toBeTruthy();
    expect(income?.projectId).toBeTruthy();
    expect(rows.find((t) => t.type === "expense")).toMatchObject({ amount: 250_000, merchant: "Sundarban Courier" });

    await expect(send({ id: "bad_1", type: "revenue", data: { currency: "BDT", date: "2026-09-14" } })).rejects.toMatchObject({
      status: 400,
      code: "invalid_event",
    });
    await expect(send({ id: "bad_2", type: "revenue", data: { amount: 10.5, currency: "BDT", date: "2026-09-14" } })).rejects.toMatchObject({ status: 400 });
    const failed = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.connectionId, connected.connection.id), eq(webhookEvents.status, "failed")));
    expect(failed).toHaveLength(2);
    expect(failed.every((e) => e.signatureValid)).toBe(true);
  });
});

describe("distinct records that look alike", () => {
  it("posts two same-amount same-day charges with different ids, and flags only a real copy of a manual entry", async () => {
    const ctx = user.business;
    const bank = await accounts.create(ctx, { name: "Merchant account", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-01-01" });
    const connected = await connect(ctx, { provider: "generic_webhook", name: "Checkout", accountId: bank.id, trustLevel: "trusted" });
    const secret = connected.webhook?.secret as string;
    const publicId = publicIdOf(connected.webhook?.url);
    const now = new Date();
    const send = async (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload));
      const { timestamp, signature } = signFinanceOS(secret, body, now);
      const receipt = await webhooks.receive(publicId, { "x-financeos-timestamp": timestamp, "x-financeos-signature": signature }, body, now);
      return webhooks.process(receipt.webhookEventId as string);
    };
    const charge = (id: string, reference?: string) => ({
      id,
      type: "revenue",
      data: { amount: 299_900, currency: "BDT", date: "2026-09-21", customer: "Karim & Co", product: "Team plan", ...(reference ? { reference } : {}) },
    });

    // A manual entry of the same amount, day and customer, with its own reference.
    const { transaction: manual } = await (await service(TransactionsService)).create(ctx, {
      type: "income",
      accountId: bank.id,
      amount: 299_900,
      currency: "BDT",
      date: "2026-09-21",
      merchant: "Karim & Co",
      reference: "ORD-10000",
    });

    await send(charge("ch_distinct_1", "ORD-10001"));
    await send(charge("ch_distinct_2", "ORD-10002"));
    const imported = await db.select().from(transactions).where(eq(transactions.connectionId, connected.connection.id));
    expect(imported).toHaveLength(2);
    expect(imported.every((t) => t.status === "posted" && t.reviewReason === null)).toBe(true);
    expect(await db.$count(inboxItems, and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.kind, "duplicate")))).toBe(0);

    // Without a distinguishing reference, the same money entered by hand is still caught.
    await send(charge("ch_copy_of_manual"));
    const [copy] = await db.select().from(transactions).where(eq(transactions.externalId, "ch_copy_of_manual"));
    expect(copy).toMatchObject({ status: "draft", metadata: expect.objectContaining({ duplicateOf: manual.id }) });
    expect(await db.$count(inboxItems, and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.kind, "duplicate")))).toBe(1);
  });
});

describe("stripe", () => {
  it("connects with a validated key, syncs balance transactions and accepts Stripe-signed webhooks", async () => {
    const ctx = user.business;
    const bank = await accounts.create(ctx, { name: "City Bank USD", kind: "bank", currency: "USD", openingBalance: 0, openingDate: "2025-01-01" });
    const requests: string[] = [];
    const http: HttpClient = async (request) => {
      requests.push(request.url);
      if (request.headers?.Authorization !== "Bearer rk_test_51Abcdefghijklmnop") return jsonResponse(401, { error: { message: "Invalid API Key provided" } });
      const url = new URL(request.url);
      if (url.pathname === "/v1/balance") return jsonResponse(200, JSON.parse(fixture("balance.json").toString()));
      if (url.pathname === "/v1/balance_transactions" && !url.searchParams.get("starting_after"))
        return jsonResponse(200, JSON.parse(fixture("balance-transactions-page1.json").toString()));
      if (url.pathname === "/v1/balance_transactions") return jsonResponse(200, JSON.parse(fixture("balance-transactions-page2.json").toString()));
      return jsonResponse(404, { error: { message: "No such route" } });
    };
    await expect(connect(ctx, { provider: "stripe", name: "Stripe", credentials: { secretKey: "rk_test_51WrongWrongWrong" } }, { http })).rejects.toMatchObject(
      { status: 422, message: expect.stringMatching(/rejected the API key/) },
    );
    await expect(connect(ctx, { provider: "stripe", name: "Stripe", credentials: { secretKey: "pk_live_nope" } }, { http })).rejects.toMatchObject({
      status: 400,
    });

    const connected = await connect(
      ctx,
      {
        provider: "stripe",
        name: "Stripe",
        credentials: { secretKey: "rk_test_51Abcdefghijklmnop" },
        config: { payoutAccountId: bank.id, revenueCategory: "Subscription revenue" },
        trustLevel: "trusted",
        syncFrequency: "hourly",
      },
      { http },
    );
    expect(connected.validation).toMatchObject({ ok: true, message: expect.stringMatching(/test mode/) });
    expect(connected.createdAccount).toMatchObject({ name: "Stripe balance", currency: "USD" });
    expect(connected.webhook).toMatchObject({ secretSource: "provider", signatureHeader: "stripe-signature" });
    expect(connected.connection.credentials).toEqual([
      { key: "secretKey", label: "Restricted API key", set: true, masked: "••••mnop" },
      { key: "webhookSigningSecret", label: "Webhook signing secret", set: false, masked: null },
    ]);

    const run = await sync.run(connected.connection.id, "initial", {
      runId: connected.initialSyncRunId ?? undefined,
      http,
      now: new Date("2025-09-05T00:00:00Z"),
    });
    // charge → revenue + fee, refund, payout → transfer, adjustment + fee; top-up skipped.
    expect(run).toMatchObject({ status: "succeeded", recordsFound: 7, created: 6, skipped: 1, errors: 0 });
    const rows = await db.select().from(transactions).where(eq(transactions.connectionId, connected.connection.id));
    const byId = new Map(rows.map((t) => [t.externalId, t]));
    expect(byId.get("txn_3PpQ2aCharge0001")).toMatchObject({
      type: "income",
      amount: 4900,
      currency: "USD",
      merchant: "Nimbus Labs",
      status: "posted",
      accountId: connected.createdAccount?.id,
    });
    expect(byId.get("txn_3PpQ2aCharge0001:fee")).toMatchObject({ type: "expense", amount: 172, description: "Stripe fees" });
    expect(byId.get("txn_3PpQ2aRefund0001")).toMatchObject({ type: "refund", direction: "out", amount: 2900 });
    expect(byId.get("txn_1PpPayout0001")).toMatchObject({ type: "transfer", amount: 15000, toAccountId: bank.id });
    const detail = await sync.get(ctx, run?.id as string);
    expect(detail.balances).toEqual([expect.objectContaining({ currency: "USD", balance: 83_828 })]);
    expect(requests.some((u) => u.includes("starting_after=txn_3PpQ2aRefund0001"))).toBe(true);

    // Webhooks are verified with the endpoint signing secret the user pastes in.
    await connections.update(
      ctx,
      connected.connection.id,
      { credentials: { secretKey: "rk_test_51Abcdefghijklmnop", webhookSigningSecret: "whsec_stripeEndpointSecret" } },
      { http },
    );
    const publicId = publicIdOf(connected.webhook?.url);
    const body = fixture("event-charge-succeeded.json");
    const at = new Date(1756810000 * 1000 + 30_000);
    await expect(
      webhooks.receive(publicId, { "stripe-signature": signTimestampedHeader(connected.webhook?.secret as string, body, at) }, body, at),
    ).rejects.toMatchObject({ status: 401 });
    const receipt = await webhooks.receive(publicId, { "stripe-signature": signTimestampedHeader("whsec_stripeEndpointSecret", body, at) }, body, at);
    expect(receipt).toMatchObject({ status: "received", eventId: "evt_3PpQ9zEvent0001" });
    expect((await webhooks.process(receipt.webhookEventId as string)).status).toBe("processed");
    expect(byId.has("txn_3PpQ9zCharge0002")).toBe(false);
    const [pushed] = await db.select().from(transactions).where(eq(transactions.externalId, "txn_3PpQ9zCharge0002"));
    expect(pushed).toMatchObject({ type: "income", amount: 9900, merchant: "Riverstone Ltd" });

    // A payout event maps to the same balance transaction id a later sync would see.
    const payout = fixture("event-payout-paid.json");
    const payoutAt = new Date(1756820000 * 1000);
    const payoutReceipt = await webhooks.receive(
      publicId,
      { "stripe-signature": signTimestampedHeader("whsec_stripeEndpointSecret", payout, payoutAt) },
      payout,
      payoutAt,
    );
    await webhooks.process(payoutReceipt.webhookEventId as string);
    const [transfer] = await db.select().from(transactions).where(eq(transactions.externalId, "txn_1PpPayout0002"));
    expect(transfer).toMatchObject({ type: "transfer", amount: 20000, toAccountId: bank.id });
  });
});
