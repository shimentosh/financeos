import { addDays, connectInput, today } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { auditLogs, inboxItems, integrationConnections, jobs, notifications, syncRuns, transactions } from "../../src/db/schema/index.js";
import { ConnectionsService } from "../../src/modules/integrations/connections.service.js";
import { DEMO_BANK, demoBankRange } from "../../src/modules/integrations/connectors/demo-bank.js";
import { demoPaymentsDay } from "../../src/modules/integrations/connectors/demo-payments.js";
import { type HttpClient, jsonResponse } from "../../src/modules/integrations/connectors/http.js";
import { SyncService } from "../../src/modules/integrations/sync.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { JobsService } from "../../src/modules/system/jobs.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let connections: ConnectionsService;
let sync: SyncService;
let jobsService: JobsService;
let accounts: AccountsService;
let transactionsService: TransactionsService;
let user: TestUser;

beforeAll(async () => {
  connections = await service(ConnectionsService);
  sync = await service(SyncService);
  jobsService = await service(JobsService);
  accounts = await service(AccountsService);
  transactionsService = await service(TransactionsService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Tanvir Hasan");
});

const connect = (ctx: WorkspaceContext, input: Record<string, unknown>, deps: { http?: HttpClient } = {}) =>
  connections.create(ctx, connectInput.parse(input), deps);

/** The demo bank's first window, as the connector computes it. */
function initialWindow(createdAt: Date, timeZone: string) {
  const createdDay = today(timeZone, createdAt);
  const todayDay = today(timeZone);
  const start = addDays(createdDay, -DEMO_BANK.historyDays);
  const initial = addDays(createdDay, -DEMO_BANK.initialLagDays);
  return { start, target: initial < todayDay ? initial : todayDay, todayDay };
}

async function connectionRow(id: string) {
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, id));
  if (!row) throw new Error("missing connection");
  return row;
}

describe("demo bank sync", () => {
  it("imports the history once, then only newer records, and re-reading creates no duplicates", async () => {
    const ctx = user.personal;
    const connected = await connect(ctx, { provider: "demo_bank", name: "Demo Bank", trustLevel: "trusted" });
    expect(connected.createdAccount).toMatchObject({ name: "Demo Bank", currency: "BDT" });
    expect(connected.connection).toMatchObject({ status: "connected", health: "pending", capabilities: { sync: true, webhook: false }, webhook: null });
    expect(connected.initialSyncRunId).toBeTruthy();

    // The initial sync runs as a job.
    expect(await jobsService.runDue(5)).toBeGreaterThanOrEqual(1);
    const row = await connectionRow(connected.connection.id);
    const window = initialWindow(row.createdAt, ctx.timezone);
    const expected = demoBankRange(row.id, window.start, window.target);
    const initial = await sync.get(ctx, connected.initialSyncRunId as string);
    expect(initial).toMatchObject({
      trigger: "initial",
      status: "succeeded",
      recordsFound: expected.length,
      created: expected.length,
      duplicates: 0,
      errors: 0,
    });
    // Every record posted, so the books match the balance the bank reports.
    expect(initial.balances).toEqual([
      expect.objectContaining({ accountId: connected.createdAccount?.id, currency: "BDT", asOf: window.target, difference: 0 }),
    ]);

    const imported = await db.select().from(transactions).where(eq(transactions.connectionId, row.id));
    expect(imported).toHaveLength(expected.length);
    expect(imported.every((t) => t.status === "posted" && t.source === "integration")).toBe(true);
    const salary = imported.find((t) => t.externalId === expected.find((e) => e.category === "Salary")?.id);
    expect(salary).toMatchObject({ type: "income", direction: "in", amount: 8_500_000, merchant: "Acme Tech Ltd" });
    expect(salary?.categoryId).toBeTruthy();

    // Incremental: the simulated clock moves forward and only new days arrive.
    const next = await sync.run(row.id, "manual");
    const nextTarget = addDays(window.target, DEMO_BANK.stepDays) < window.todayDay ? addDays(window.target, DEMO_BANK.stepDays) : window.todayDay;
    const newer = window.target < nextTarget ? demoBankRange(row.id, addDays(window.target, 1), nextTarget) : [];
    expect(next).toMatchObject({ status: "succeeded", created: newer.length, duplicates: 0 });

    // Idempotency: read the whole feed again from the start.
    await db.update(integrationConnections).set({ syncCursor: null }).where(eq(integrationConnections.id, row.id));
    const again = await sync.run(row.id, "manual");
    expect(again).toMatchObject({ status: "succeeded", created: 0, duplicates: expected.length });
    expect(await db.$count(transactions, eq(transactions.connectionId, row.id))).toBe(expected.length + newer.length);

    const detail = await connections.detail(ctx, row.id);
    expect(detail).toMatchObject({
      status: "connected",
      health: "healthy",
      recordsTotal: expected.length + newer.length,
      consecutiveFailures: 0,
      errorMessage: null,
    });
    expect(detail.stats.transactions).toMatchObject({ total: expected.length + newer.length, posted: expected.length + newer.length });
    expect(detail.recentRuns.map((r) => r.trigger)).toEqual(["manual", "manual", "initial"]);

    const records = await connections.records(ctx, row.id, { page: 1, pageSize: 5 });
    expect(records.total).toBe(expected.length + newer.length);
    expect(records.items[0]).toHaveProperty("accountName", "Demo Bank");
  });

  it("stages records as drafts for review when the connection is not trusted", async () => {
    const connected = await connect(user.personal, { provider: "demo_bank", name: "Demo Bank" });
    await jobsService.runDue(5);
    const imported = await db.select().from(transactions).where(eq(transactions.connectionId, connected.connection.id));
    expect(imported.length).toBeGreaterThan(50);
    expect(imported.every((t) => t.status === "draft" && t.reviewReason?.includes("review before posting"))).toBe(true);
  });

  it("turns a synced copy of a manual entry into a draft with a duplicate inbox item", async () => {
    const ctx = user.personal;
    const bank = await accounts.create(ctx, { name: "City Bank", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-01-01" });
    const connected = await connect(ctx, { provider: "demo_bank", name: "Demo Bank", accountId: bank.id, trustLevel: "trusted" });
    expect(connected.createdAccount).toBeNull();
    const row = await connectionRow(connected.connection.id);
    const window = initialWindow(row.createdAt, ctx.timezone);
    const target = demoBankRange(row.id, window.start, window.target).find((t) => t.category === "Groceries");
    if (!target) throw new Error("no groceries in the feed");
    const { transaction: manual } = await transactionsService.create(ctx, {
      type: "expense",
      accountId: bank.id,
      amount: target.amount,
      currency: "BDT",
      date: target.date,
      merchant: target.merchant,
    });

    await jobsService.runDue(5);
    const [copy] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.externalKey, `integration:${row.id}:${target.id}`));
    expect(copy).toMatchObject({ status: "draft", metadata: expect.objectContaining({ duplicateOf: manual.id }) });
    expect(copy?.reviewReason).toMatch(/Possible duplicate/);
    const [item] = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.kind, "duplicate")));
    expect(item).toMatchObject({ status: "open", entityId: copy?.id, dedupeKey: `duplicate:${[copy?.id, manual.id].sort().join(":")}` });
    expect(item?.data).toMatchObject({ matchTransactionId: manual.id, connectionId: row.id });
    const run = await sync.get(ctx, connected.initialSyncRunId as string);
    expect(run.reviewDetails).toEqual([expect.objectContaining({ externalId: target.id, transactionId: copy?.id })]);
    // The manual entry is untouched and counted once in the balance.
    expect((await transactionsService.get(ctx, manual.id)).status).toBe("posted");
  });
});

describe("demo payments", () => {
  it("records gross revenue, fees and refunds; payouts need a payout account", async () => {
    const ctx = user.business;
    const bank = await accounts.create(ctx, { name: "Dutch-Bangla USD", kind: "bank", currency: "USD", openingBalance: 0, openingDate: "2026-01-01" });
    const connected = await connect(ctx, { provider: "demo_payments", name: "Demo Payments", trustLevel: "trusted", config: { currency: "USD" } });
    expect(connected.createdAccount).toMatchObject({ name: "Demo Payments balance", currency: "USD" });
    expect(connected.webhook).toMatchObject({
      url: expect.stringMatching(/\/api\/webhooks\/wh_[0-9A-Za-z]+$/),
      secret: expect.stringMatching(/^whsec_/),
      secretSource: "generated",
      signatureHeader: "x-demo-signature",
    });
    await jobsService.runDue(5);

    const id = connected.connection.id;
    const run = await sync.get(ctx, connected.initialSyncRunId as string);
    expect(run.status).toBe("succeeded");
    expect(run.skipped).toBeGreaterThan(0);
    expect(run.skippedDetails.every((d) => /payout account/.test(d.message))).toBe(true);

    const rows = await db.select().from(transactions).where(eq(transactions.connectionId, id));
    const byExternal = new Map(rows.map((t) => [t.externalId, t]));
    const row = await connectionRow(id);
    const start = addDays(today(ctx.timezone, row.createdAt), -90);
    const [charge] = demoPaymentsDay(id, addDays(start, 10), "USD", start).filter((e) => e.object === "charge");
    if (charge?.object !== "charge") throw new Error("no charge");
    expect(byExternal.get(charge.id)).toMatchObject({
      type: "income",
      direction: "in",
      amount: charge.amount,
      currency: "USD",
      merchant: charge.customer.name,
      status: "posted",
    });
    expect(byExternal.get(`${charge.id}:fee`)).toMatchObject({ type: "expense", direction: "out", amount: charge.fee });
    const refunds = rows.filter((t) => t.type === "refund");
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every((t) => t.direction === "out" && t.categoryId)).toBe(true);
    expect(rows.some((t) => t.type === "transfer")).toBe(false);
    expect(rows.filter((t) => t.type === "income")).toHaveLength(rows.filter((t) => t.externalId?.endsWith(":fee")).length);

    // With a payout account, payouts become transfers into it.
    await connections.update(ctx, id, { config: { payoutAccountId: bank.id } });
    await db.update(integrationConnections).set({ syncCursor: null }).where(eq(integrationConnections.id, id));
    const rerun = await sync.run(id, "manual");
    expect(rerun?.created).toBe(run.skipped);
    expect(rerun?.skipped).toBe(0);
    const transfers = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.connectionId, id), eq(transactions.type, "transfer")));
    expect(transfers.length).toBe(run.skipped);
    expect(transfers.every((t) => t.toAccountId === bank.id && t.accountId === connected.createdAccount?.id && t.status === "posted")).toBe(true);
  });
});

describe("sync failure accounting", () => {
  let mode: "partial" | "down" | "ok" = "ok";
  const http: HttpClient = async () => {
    if (mode === "down") return jsonResponse(503, { error: "maintenance" });
    const items = [
      { id: "a1", amount: 120.5, date: "2026-09-10", memo: "Hosting" },
      { id: "a2", amount: 80, date: "2026-09-11", memo: "Domain" },
      ...(mode === "partial" ? [{ id: "a3", date: "2026-09-12", memo: "No amount" }] : []),
    ];
    return jsonResponse(200, { items });
  };
  const config = {
    baseUrl: "https://ops.example.com",
    endpoints: [
      {
        path: "/costs",
        entity: "expense",
        itemsPath: "items",
        mapping: { externalId: "id", amount: "amount", date: "date", description: "memo" },
        defaults: { currency: "BDT" },
      },
    ],
  };

  it("marks record errors as partial, streaks of failures as needing attention, and recovers", async () => {
    const ctx = user.business;
    const bank = await accounts.create(ctx, { name: "Ops account", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-01-01" });
    mode = "partial";
    const connected = await connect(ctx, { provider: "generic_rest", name: "Ops API", accountId: bank.id, trustLevel: "trusted", config }, { http });
    const id = connected.connection.id;

    const partial = await sync.run(id, "manual", { http });
    expect(partial).toMatchObject({ status: "partial", recordsFound: 3, created: 2, errors: 1 });
    expect((await sync.get(ctx, partial?.id as string)).errorDetails).toEqual([{ externalId: "a3", message: expect.stringMatching(/no usable amount/) }]);
    expect(await connectionRow(id)).toMatchObject({ status: "connected", consecutiveFailures: 0, errorMessage: expect.stringMatching(/1 of 3 records/) });
    expect((await connections.detail(ctx, id)).health).toBe("degraded");

    mode = "down";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const failed = await sync.run(id, "scheduled", { http });
      expect(failed).toMatchObject({ status: "failed", errors: 1 });
      const row = await connectionRow(id);
      expect(row.consecutiveFailures).toBe(attempt);
      expect(row.status).toBe(attempt >= 3 ? "needs_attention" : "error");
      expect(row.errorMessage).toMatch(/HTTP 503/);
    }
    const alerts = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.kind, "integration_error")));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: "open", entityId: id, severity: "critical" });
    expect(await db.$count(notifications, and(eq(notifications.userId, user.userId), eq(notifications.kind, "integration_error")))).toBe(1);
    expect((await connections.detail(ctx, id)).health).toBe("failing");

    mode = "ok";
    const recovered = await sync.run(id, "manual", { http });
    expect(recovered).toMatchObject({ status: "succeeded", created: 0, duplicates: 2 });
    expect(await connectionRow(id)).toMatchObject({ status: "connected", consecutiveFailures: 0, errorMessage: null });
    const [resolved] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, alerts[0]?.id as string));
    expect(resolved?.status).toBe("resolved");

    const failedRuns = await sync.list(ctx, { page: 1, pageSize: 50, connectionId: id, status: ["failed"] });
    expect(failedRuns.total).toBe(4);
    const retry = await sync.retry(ctx, failedRuns.items[0]?.id as string);
    expect(retry.status === "queued" || retry.status === "already_running").toBe(true);
  });
});

describe("sync jobs and scheduling", () => {
  it("never queues two syncs of one connection and schedules only due connections", async () => {
    const ctx = user.personal;
    const daily = await connect(ctx, { provider: "demo_bank", name: "Daily bank", syncFrequency: "daily" });
    const manual = await connect(ctx, { provider: "demo_bank", name: "Manual bank", syncFrequency: "manual" });
    // The initial sync is queued; asking again returns the same run.
    const again = await sync.start(ctx, daily.connection.id, "manual");
    expect(again).toEqual({ runId: daily.initialSyncRunId, status: "already_running" });
    await jobsService.runDue(10);
    expect(await sync.start(ctx, daily.connection.id, "manual")).toMatchObject({ status: "queued" });
    await jobsService.runDue(10);

    // Nothing is due right after syncing.
    expect(await sync.enqueueDue()).toBe(0);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await db.update(integrationConnections).set({ lastSyncedAt: twoDaysAgo });
    expect(await sync.enqueueDue()).toBe(1);
    const queued = await db.select().from(jobs).where(eq(jobs.status, "queued"));
    expect(queued.map((j) => j.payload)).toEqual([expect.objectContaining({ connectionId: daily.connection.id, trigger: "scheduled" })]);
    expect(queued[0]?.dedupeKey).toBe(`sync:${daily.connection.id}`);
    expect(manual.connection.syncFrequency).toBe("manual");

    await connections.disconnect(ctx, daily.connection.id);
    await jobsService.runDue(10);
    await db.update(integrationConnections).set({ lastSyncedAt: twoDaysAgo });
    expect(await sync.enqueueDue()).toBe(0);
    await expect(sync.start(ctx, daily.connection.id, "manual")).rejects.toThrow(/Reconnect/);
  });
});

describe("connections API", () => {
  const restConfig = {
    baseUrl: "https://erp.example.com",
    auth: { type: "bearer" },
    endpoints: [
      { path: "/sales", entity: "revenue", itemsPath: "", mapping: { externalId: "id", amount: "amount", date: "date" }, defaults: { currency: "BDT" } },
    ],
  };
  const http: HttpClient = async () => jsonResponse(200, [{ id: "s1", amount: 100, date: "2026-09-01" }]);

  it("never returns or logs credentials, and validates before saving", async () => {
    const ctx = user.business;
    const token = "tok_super_secret_value_1234567890";
    const created = await connect(ctx, { provider: "generic_rest", name: "ERP", credentials: { token }, config: restConfig }, { http });
    expect(created.connection.credentials).toEqual([
      { key: "token", label: "Token / API key", set: true, masked: "••••7890" },
      { key: "username", label: "Username (basic auth)", set: false, masked: null },
    ]);
    expect(created.validation).toMatchObject({ ok: true });
    expect(JSON.stringify(created)).not.toContain(token);
    expect(JSON.stringify(await connections.list(ctx))).not.toContain(token);
    const row = await connectionRow(created.connection.id);
    expect(row.credentialsEncrypted).toMatch(/^v1:/);
    expect(row.credentialsEncrypted).not.toContain(token);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, ctx.workspaceId));
    expect(JSON.stringify(logs)).not.toContain(token);

    const failing: HttpClient = async () => jsonResponse(401, { error: "nope" });
    await expect(
      connect(ctx, { provider: "generic_rest", name: "ERP 2", credentials: { token }, config: restConfig }, { http: failing }),
    ).rejects.toMatchObject({ status: 422, code: "connection_failed" });
    await expect(connect(ctx, { provider: "paypal", name: "PayPal" })).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(connect(ctx, { provider: "generic_rest", name: "Bad", config: { baseUrl: "not a url", endpoints: [] } })).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
    });

    // Test uses the stored credentials; a credential change is validated too.
    expect(await connections.test(ctx, created.connection.id, { http })).toMatchObject({ ok: true });
    await expect(connections.update(ctx, created.connection.id, { credentials: { token: "other" } }, { http: failing })).rejects.toMatchObject({
      code: "connection_failed",
    });
    const renamed = await connections.update(ctx, created.connection.id, { name: "ERP (prod)", trustLevel: "trusted", syncFrequency: "hourly" });
    expect(renamed.connection).toMatchObject({ name: "ERP (prod)", trustLevel: "trusted", syncFrequency: "hourly" });
    expect(renamed.connection.credentials[0]).toMatchObject({ set: true });
  });

  it("refuses private network targets unless explicitly allowed outside production", async () => {
    const ctx = user.business;
    const local = { ...restConfig, baseUrl: "http://127.0.0.1:9000" };
    let called = 0;
    const counting: HttpClient = async (request) => {
      called++;
      return http(request);
    };
    await expect(connect(ctx, { provider: "generic_rest", name: "Local", config: local }, { http: counting })).rejects.toMatchObject({
      code: "connection_failed",
      message: expect.stringMatching(/private or loopback/),
    });
    expect(called).toBe(0);
    const allowed = await connect(
      ctx,
      { provider: "generic_rest", name: "Local dev", credentials: { token: "dev-token" }, config: { ...local, allowPrivateNetwork: true } },
      { http: counting },
    );
    expect(allowed.validation?.ok).toBe(true);
    expect(called).toBe(1);
  });

  it("deletes a connection without history but only disconnects one with imports", async () => {
    const ctx = user.personal;
    const empty = await connect(ctx, { provider: "demo_bank", name: "Unused", syncFrequency: "manual" });
    await db.delete(jobs);
    expect(await connections.remove(ctx, empty.connection.id)).toMatchObject({ deleted: true });
    expect(await db.$count(integrationConnections, eq(integrationConnections.id, empty.connection.id))).toBe(0);

    const used = await connect(ctx, { provider: "demo_bank", name: "Used", trustLevel: "trusted" });
    await jobsService.runDue(5);
    const result = await connections.remove(ctx, used.connection.id);
    expect(result).toMatchObject({ deleted: false, disconnected: true, connection: { status: "disconnected", health: "disconnected" } });
    const row = await connectionRow(used.connection.id);
    expect(row).toMatchObject({ credentialsEncrypted: null, webhookPublicId: null });
    expect(await db.$count(transactions, eq(transactions.connectionId, used.connection.id))).toBeGreaterThan(0);
    expect(await db.$count(syncRuns, eq(syncRuns.connectionId, used.connection.id))).toBeGreaterThan(0);

    // Reconnecting with credentials (none for the demo) brings it back.
    const back = await connections.update(ctx, used.connection.id, { credentials: {} });
    expect(back.connection.status).toBe("connected");
  });
});

describe("workspace isolation", () => {
  it("keeps connections, runs and records inside their workspace", async () => {
    const other = await createUser("Someone Else");
    const connected = await connect(user.personal, { provider: "demo_bank", name: "Mine", trustLevel: "trusted" });
    await jobsService.runDue(5);
    const id = connected.connection.id;

    await expect(connections.detail(other.personal, id)).rejects.toThrow(/not found/);
    await expect(connections.detail(user.business, id)).rejects.toThrow(/not found/);
    await expect(connections.records(other.personal, id, { page: 1, pageSize: 10 })).rejects.toThrow(/not found/);
    await expect(sync.start(other.personal, id, "manual")).rejects.toThrow(/not found/);
    await expect(sync.get(other.personal, connected.initialSyncRunId as string)).rejects.toThrow(/not found/);
    await expect(connections.update(other.personal, id, { name: "Hijacked" })).rejects.toThrow(/not found/);
    await expect(connections.disconnect(other.personal, id)).rejects.toThrow(/not found/);
    expect(await connections.list(other.personal)).toEqual([]);
    expect((await sync.list(other.personal, { page: 1, pageSize: 10 })).total).toBe(0);

    // Someone else's account cannot be used as a target.
    await expect(connect(other.personal, { provider: "demo_bank", name: "Sneaky", accountId: connected.createdAccount?.id })).rejects.toThrow(
      /not found in this workspace/,
    );
    await expect(
      connect(other.business, { provider: "demo_payments", name: "Sneaky", config: { payoutAccountId: connected.createdAccount?.id } }),
    ).rejects.toThrow(/not found in this workspace/);
  });
});
