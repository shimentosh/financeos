import type { AddressInfo } from "node:net";
import { connectInput } from "@financeos/core";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import type { AppRequest } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { apiKeys, auditLogs, jobs, rateLimits, transactions, webhookEvents } from "../../src/db/schema/index.js";
import { ConnectionsService } from "../../src/modules/integrations/connections.service.js";
import { signTimestampedHeader } from "../../src/modules/integrations/connectors/signatures.js";
import { ApiKeyGuard } from "../../src/modules/integrations/public-api/api-key.guard.js";
import { ApiKeysService } from "../../src/modules/integrations/public-api/api-keys.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let app: INestApplication;
let baseUrl: string;
let keys: ApiKeysService;
let guard: ApiKeyGuard;
let accounts: AccountsService;
let connections: ConnectionsService;
let user: TestUser;
let bank: string;
let writeKey: string;
let readKey: string;

beforeAll(async () => {
  // The real HTTP stack, as main.ts builds it: raw body kept for signatures.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  nest
    .getHttpAdapter()
    .getInstance()
    .use(
      express.json({
        limit: "2mb",
        verify: ((request: AppRequest, _response: unknown, buffer: Buffer) => {
          request.rawBody = buffer;
        }) as never,
      }),
    );
  nest.setGlobalPrefix("api");
  await nest.listen(0, "127.0.0.1");
  app = nest;
  baseUrl = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}/api`;
  keys = await service(ApiKeysService);
  guard = await service(ApiKeyGuard);
  accounts = await service(AccountsService);
  connections = await service(ConnectionsService);
});

afterAll(async () => {
  await app?.close();
  await shutdown();
});

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Imran Chowdhury");
  bank = (await accounts.create(user.business, { name: "Operating account", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-01-01" })).id;
  writeKey = (await keys.create(user.business, { name: "Shop backend", scopes: ["read", "write"] })).key;
  readKey = (await keys.create(user.business, { name: "Dashboard", scopes: ["read"] })).key;
});

const call = (path: string, init: { method?: string; key?: string | null; body?: unknown; headers?: Record<string, string>; raw?: Buffer } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}),
      ...(init.body !== undefined || init.raw ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field.
type Json = Record<string, any>;
const json = async (response: Response): Promise<Json> => (await response.json()) as Json;

function httpContext(request: Partial<AppRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe("API keys", () => {
  it("shows the key once and stores only its hash", async () => {
    const created = await keys.create(user.business, { name: "CI", scopes: ["write"], expiresInDays: 30 });
    expect(created.key).toMatch(/^ew_live_[0-9A-Za-z]{43}$/);
    expect(created.apiKey).toMatchObject({ name: "CI", prefix: created.key.slice(0, 12), scopes: ["read", "write"], status: "active", lastUsedAt: null });
    expect(created.apiKey.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const listed = await keys.list(user.business);
    expect(listed).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(listed[0]).not.toHaveProperty("keyHash");
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.apiKey.id));
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await db.select().from(auditLogs).where(eq(auditLogs.entityType, "api_key")))).not.toContain(created.key);

    const revoked = await keys.revoke(user.business, created.apiKey.id);
    expect(revoked.status).toBe("revoked");
    await expect(keys.revoke(user.personal, created.apiKey.id)).rejects.toThrow(/not found/);
  });

  it("guards requests: missing, invalid, revoked, expired and read-only keys", async () => {
    await expect(guard.canActivate(httpContext({ method: "GET", headers: {} }))).rejects.toMatchObject({ status: 401, code: "missing_api_key" });
    await expect(
      guard.canActivate(httpContext({ method: "GET", headers: { authorization: "Bearer ew_live_nottherightkeyatallnottherightkey1234567" } })),
    ).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
    await expect(guard.canActivate(httpContext({ method: "POST", headers: { authorization: `Bearer ${readKey}` } }))).rejects.toMatchObject({
      status: 403,
      code: "insufficient_scope",
    });

    const request: Partial<AppRequest> = { method: "GET", headers: { authorization: `Bearer ${readKey}` }, ip: "203.0.113.9" };
    expect(await guard.canActivate(httpContext(request))).toBe(true);
    expect(request.ctx).toMatchObject({ workspaceId: user.business.workspaceId, actorType: "api", role: "member", userId: null, apiKeyId: expect.any(String) });
    const [used] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, request.ctx?.apiKeyId as string));
    expect(used?.lastUsedAt).toBeInstanceOf(Date);

    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, request.ctx?.apiKeyId as string));
    await expect(guard.canActivate(httpContext({ method: "GET", headers: { authorization: `Bearer ${readKey}` } }))).rejects.toMatchObject({ status: 401 });
    await db
      .update(apiKeys)
      .set({ expiresAt: null, revokedAt: new Date() })
      .where(eq(apiKeys.id, request.ctx?.apiKeyId as string));
    await expect(guard.canActivate(httpContext({ method: "GET", headers: { authorization: `Bearer ${readKey}` } }))).rejects.toMatchObject({ status: 401 });
  });
});

describe("public API v1 over HTTP", () => {
  it("authenticates by key, enforces scopes and rate limits", async () => {
    const missing = await call("/v1/accounts");
    expect(missing.status).toBe(401);
    expect(await json(missing)).toMatchObject({ statusCode: 401, error: "missing_api_key" });
    expect((await call("/v1/accounts", { key: "ew_live_bogus" })).status).toBe(401);

    const listed = await call("/v1/accounts", { key: readKey });
    expect(listed.status).toBe(200);
    expect((await json(listed)).items).toEqual([expect.objectContaining({ id: bank, name: "Operating account", currency: "BDT", balance: 0 })]);

    const readOnly = await call("/v1/revenue", {
      method: "POST",
      key: readKey,
      body: { external_id: "o-1", amount: 100, currency: "BDT", date: "2026-09-20" },
    });
    expect(readOnly.status).toBe(403);

    // Session routes stay behind the session guard.
    expect((await call("/integrations", { key: writeKey })).status).toBe(401);

    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.name, "Dashboard"));
    await db
      .insert(rateLimits)
      .values({ key: `api:${key?.id}`, windowStart: new Date(), count: 120 })
      .onConflictDoUpdate({ target: rateLimits.key, set: { count: 120, windowStart: new Date() } });
    const limited = await call("/v1/summary", { key: readKey });
    expect(limited.status).toBe(429);
  });

  it("records revenue idempotently by external_id and audits it as the API", async () => {
    const body = {
      external_id: "order-5001",
      amount: 2499.99,
      amount_unit: "major",
      currency: "BDT",
      date: "2026-09-20",
      customer: "Sadia Islam",
      product: "Premium plan",
      category: "Subscription revenue",
      project: "Mobile app",
      account_id: bank,
      status: "posted",
    };
    const first = await call("/v1/revenue", { method: "POST", key: writeKey, body });
    expect(first.status).toBe(201);
    const created = await json(first);
    expect(created).toMatchObject({
      duplicate: false,
      status: "posted",
      transaction: {
        type: "income",
        amount: 249_999,
        merchant: "Sadia Islam",
        description: "Premium plan",
        source: "api",
        externalId: "order-5001",
        accountId: bank,
      },
    });
    expect(created.warnings).toEqual(['No project called "Mobile app"; left unassigned']);
    expect(created.transaction.categoryId).toBeTruthy();

    const again = await call("/v1/revenue", { method: "POST", key: writeKey, body: { ...body, amount: 1 } });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ duplicate: true, id: created.id, transaction: { amount: 249_999 } });
    expect(await db.$count(transactions, eq(transactions.externalId, "order-5001"))).toBe(1);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, "transaction"), eq(auditLogs.entityId, created.id)));
    expect(audit).toMatchObject({ actorType: "api", source: "api" });
    expect(audit?.actorId).toBeTruthy();

    const invalid = await call("/v1/revenue", {
      method: "POST",
      key: writeKey,
      body: { ...body, external_id: "order-5002", amount: 10.5, amount_unit: "minor" },
    });
    expect(invalid.status).toBe(400);
    const needsAccount = await call("/v1/expenses", {
      method: "POST",
      key: writeKey,
      body: { external_id: "bill-1", amount: 50000, currency: "BDT", date: "2026-09-20", vendor: "Link3", status: "posted" },
    });
    expect(needsAccount.status).toBe(422);

    const expense = await call("/v1/expenses", {
      method: "POST",
      key: writeKey,
      body: { external_id: "bill-1", amount: 50000, currency: "BDT", date: "2026-09-20", vendor: "Link3", category: "Hosting" },
    });
    expect(expense.status).toBe(201);
    expect(await json(expense)).toMatchObject({
      status: "draft",
      transaction: { type: "expense", amount: 50_000, reviewReason: expect.stringMatching(/choose the account/) },
    });
  });

  it("creates drafts by default, lists transactions and summarises the month", async () => {
    const draft = await call("/v1/transactions", {
      method: "POST",
      key: writeKey,
      body: { type: "expense", accountId: bank, amount: 120_000, currency: "BDT", date: "2026-09-19", merchant: "Daraz" },
    });
    expect(draft.status).toBe(201);
    expect(await json(draft)).toMatchObject({ duplicate: false, transaction: { status: "draft", source: "api" } });
    const today = new Date().toISOString().slice(0, 10);
    const posted = await call("/v1/transactions", {
      method: "POST",
      key: writeKey,
      body: { type: "income", status: "posted", accountId: bank, amount: 500_000, currency: "BDT", date: today, externalId: "inv-9" },
    });
    expect(await json(posted)).toMatchObject({ transaction: { status: "posted", externalId: "inv-9" } });
    const repeat = await call("/v1/transactions", {
      method: "POST",
      key: writeKey,
      body: { type: "income", status: "posted", accountId: bank, amount: 500_000, currency: "BDT", date: today, externalId: "inv-9" },
    });
    expect(repeat.status).toBe(200);

    const list = await call("/v1/transactions?type=income&pageSize=10", { key: readKey });
    expect(list.status).toBe(200);
    const page = await json(list);
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(page.items[0]).toMatchObject({ type: "income", accountName: "Operating account", amount: 500_000 });

    const summary = await json(await call("/v1/summary", { key: readKey }));
    expect(summary).toMatchObject({ currency: "BDT", income: 500_000, expense: 0, net: 500_000, transactionCount: 1 });

    // A key cannot reach into another workspace.
    const other = await createUser("Other Owner");
    const theirs = await accounts.create(other.business, { name: "Theirs", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-01-01" });
    const sneaky = await call("/v1/transactions", {
      method: "POST",
      key: writeKey,
      body: { type: "expense", accountId: theirs.id, amount: 100, currency: "BDT", date: today },
    });
    expect(sneaky.status).toBe(400);
    expect(await json(sneaky)).toMatchObject({ error: "invalid_reference" });
    const otherKey = (await keys.create(other.business, { name: "Other", scopes: ["read"] })).key;
    expect((await json(await call("/v1/transactions", { key: otherKey }))).total).toBe(0);
  });
});

describe("webhooks over HTTP", () => {
  it("verifies the raw body signature, stores the event once and rejects tampering", async () => {
    const connected = await connections.create(
      user.business,
      connectInput.parse({ provider: "demo_payments", name: "Demo Payments", syncFrequency: "manual" }),
    );
    await db.delete(jobs);
    const path = `/webhooks/${connected.webhook?.url.split("/").pop()}`;
    const raw = Buffer.from(
      `{"id":"evt_http_1", "type":"charge.succeeded","data":{"object":{"object":"charge","id":"ch_http_1","amount":2900,"fee":114,"currency":"usd","created":${Math.floor(Date.now() / 1000)},"customer":{"name":"Nimbus Labs"},"product":"Pro plan (monthly)","category":"Subscription revenue"}}}`,
    );
    const signature = signTimestampedHeader(connected.webhook?.secret as string, raw, new Date());
    const ok = await call(path, { method: "POST", raw, headers: { "x-demo-signature": signature } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ status: "received", eventId: "evt_http_1" });
    const replay = await call(path, { method: "POST", raw, headers: { "x-demo-signature": signature } });
    expect(await json(replay)).toMatchObject({ status: "duplicate" });

    // Re-serialised JSON is not the signed bytes.
    const tampered = await call(path, { method: "POST", body: JSON.parse(raw.toString()), headers: { "x-demo-signature": signature } });
    expect(tampered.status).toBe(401);
    expect((await call("/webhooks/wh_unknownunknownunknownunknown00", { method: "POST", raw, headers: { "x-demo-signature": signature } })).status).toBe(404);
    const events = await db.select().from(webhookEvents).where(eq(webhookEvents.connectionId, connected.connection.id));
    expect(events.map((e) => [e.signatureValid, e.status]).sort()).toEqual([
      [false, "failed"],
      [true, "received"],
    ]);
  });
});
