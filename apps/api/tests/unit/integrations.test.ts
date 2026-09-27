import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { demoBankDay, demoBankRange } from "../../src/modules/integrations/connectors/demo-bank.js";
import { demoPaymentsConnector } from "../../src/modules/integrations/connectors/demo-payments.js";
import { genericRestConnector, mapGenericItem } from "../../src/modules/integrations/connectors/generic-rest.js";
import { genericWebhookConnector } from "../../src/modules/integrations/connectors/generic-webhook.js";
import {
  assertSafeUrl,
  type HttpClient,
  isPrivateAddress,
  jsonResponse,
  privateNetworkAllowed,
  SsrfError,
} from "../../src/modules/integrations/connectors/http.js";
import { ConnectorRegistry } from "../../src/modules/integrations/connectors/registry.js";
import { signTimestampedHeader, verifyTimestampedHeader } from "../../src/modules/integrations/connectors/signatures.js";
import { mapBalanceTransaction, type StripeBalanceTransaction, stripeConnector } from "../../src/modules/integrations/connectors/stripe.js";
import type { ConnectionInfo } from "../../src/modules/integrations/connectors/types.js";
import { getPath, parseDateValue, parseSignedAmount } from "../../src/modules/integrations/connectors/values.js";
import {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  hmacSha256Hex,
  maskSecret,
  randomBase62,
  SecretDecryptionError,
} from "../../src/modules/integrations/crypto.js";
import { detectFormat, guessMapping, guessOptions, parseImportFile, tabulate } from "../../src/modules/integrations/imports/parse.js";
import { buildXlsx } from "../fixtures/xlsx.js";

const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "../fixtures/stripe", name), "utf8"));
const connection: ConnectionInfo = {
  id: "0199a000-0000-7000-8000-000000000001",
  workspaceId: "0199a000-0000-7000-8000-000000000002",
  name: "Test",
  provider: "generic_rest",
  accountId: null,
  projectId: null,
  createdAt: new Date("2026-09-20T06:00:00Z"),
  timezone: "Asia/Dhaka",
  baseCurrency: "BDT",
};

describe("credential encryption", () => {
  const key = randomBytes(32);

  it("round-trips with a fresh IV every time and a versioned format", () => {
    const a = encryptSecret("rk_live_secret", { key, aad: "integration:1:credentials" });
    const b = encryptSecret("rk_live_secret", { key, aad: "integration:1:credentials" });
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("rk_live_secret");
    expect(decryptSecret(a, { key, aad: "integration:1:credentials" })).toBe("rk_live_secret");
    expect(decryptJson(encryptJson({ token: "x", username: "y" }, { key }), { key })).toEqual({ token: "x", username: "y" });
  });

  it("detects tampering, a wrong key, other associated data and unknown versions", () => {
    const sealed = encryptSecret("top secret", { key, aad: "integration:1:credentials" });
    const [version, iv, tag, data] = sealed.split(":") as [string, string, string, string];
    const flipped = Buffer.from(data, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decryptSecret([version, iv, tag, flipped.toString("base64url")].join(":"), { key, aad: "integration:1:credentials" })).toThrow(
      SecretDecryptionError,
    );
    const badTag = Buffer.from(tag, "base64url");
    badTag[3] = (badTag[3] ?? 0) ^ 0xff;
    expect(() => decryptSecret([version, iv, badTag.toString("base64url"), data].join(":"), { key, aad: "integration:1:credentials" })).toThrow(
      SecretDecryptionError,
    );
    expect(() => decryptSecret(sealed, { key: randomBytes(32), aad: "integration:1:credentials" })).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(sealed, { key, aad: "integration:2:credentials" })).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(`v9:${iv}:${tag}:${data}`, { key })).toThrow(/Unsupported secret version/);
    expect(() => decryptSecret("garbage", { key })).toThrow(SecretDecryptionError);
  });

  it("uses ENCRYPTION_KEY by default and masks secrets", () => {
    expect(decryptSecret(encryptSecret("hello"))).toBe("hello");
    expect(maskSecret("rk_live_1234567890abcdef")).toBe("••••cdef");
    expect(maskSecret("short")).toBe("••••••••");
    expect(randomBase62(32)).toMatch(/^[0-9A-Za-z]{43}$/);
  });
});

describe("values", () => {
  it("reads dot paths safely", () => {
    const body = { data: { items: [{ id: 1 }, { id: 2 }] } };
    expect(getPath(body, "data.items.1.id")).toBe(2);
    expect(getPath(body, "")).toBe(body);
    expect(getPath(body, "data.__proto__")).toBeUndefined();
    expect(getPath(body, "constructor")).toBeUndefined();
    expect(getPath({ a: 1 }, "toString")).toBeUndefined();
    expect(getPath(body, "data.items.x")).toBeUndefined();
  });

  it("parses statement amounts in minor units", () => {
    expect(parseSignedAmount("1,234.50", "BDT")).toBe(123_450);
    expect(parseSignedAmount("1,00,000", "BDT")).toBe(10_000_000);
    expect(parseSignedAmount("(45.00)", "USD")).toBe(-4_500);
    expect(parseSignedAmount("1,500.00 Dr", "BDT")).toBe(-150_000);
    expect(parseSignedAmount("৳ ১,৫০০", "BDT")).toBe(150_000);
    expect(parseSignedAmount("1.234,56", "EUR")).toBe(123_456);
    expect(parseSignedAmount("-99", "BDT")).toBe(-9_900);
    expect(parseSignedAmount("Tk -250.5", "BDT")).toBe(-25_050);
    expect(parseSignedAmount(12.5, "USD")).toBe(1_250);
    expect(parseSignedAmount(1250, "USD", "minor")).toBe(1_250);
    expect(parseSignedAmount("abc", "USD")).toBeNull();
  });

  it("parses dates from APIs and files into the workspace's day", () => {
    expect(parseDateValue("2026-09-12", "Asia/Dhaka")?.day).toBe("2026-09-12");
    expect(parseDateValue("2026-09-12T20:30:00Z", "Asia/Dhaka")?.day).toBe("2026-09-13");
    expect(parseDateValue(1757660000, "Asia/Dhaka")?.day).toBe("2025-09-12");
    expect(parseDateValue(1757700000, "Asia/Dhaka")?.day).toBe("2025-09-13");
    expect(parseDateValue("12/09/2026", "Asia/Dhaka")?.day).toBe("2026-09-12");
    expect(parseDateValue("nope", "Asia/Dhaka")).toBeNull();
  });
});

describe("SSRF protection", () => {
  it("recognises private, loopback, link-local and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("rejects non-http schemes, private targets and internal names unless explicitly allowed", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertSafeUrl("ftp://example.com/x")).toThrow(SsrfError);
    expect(() => assertSafeUrl("http://127.0.0.1:8080/api")).toThrow(/private or loopback/);
    expect(() => assertSafeUrl("http://169.254.169.254/latest/meta-data")).toThrow(SsrfError);
    expect(() => assertSafeUrl("http://[::1]/")).toThrow(SsrfError);
    expect(() => assertSafeUrl("http://localhost:3000/")).toThrow(/internal hosts/);
    expect(() => assertSafeUrl("http://db.internal/")).toThrow(/internal hosts/);
    expect(() => assertSafeUrl("https://user:pass@api.example.com/")).toThrow(/credentials/);
    expect(assertSafeUrl("https://api.example.com/v1").host).toBe("api.example.com");
    expect(assertSafeUrl("http://127.0.0.1:8080/", { allowPrivateNetwork: true }).port).toBe("8080");
    expect(privateNetworkAllowed({ allowPrivateNetwork: true }, "development")).toBe(true);
    expect(privateNetworkAllowed({ allowPrivateNetwork: true }, "production")).toBe(false);
    expect(privateNetworkAllowed({}, "development")).toBe(false);
  });
});

describe("webhook signatures", () => {
  const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "charge.succeeded" }));
  const now = new Date("2026-09-20T10:00:00Z");

  it("verifies the timestamped HMAC scheme with a tolerance", () => {
    const header = signTimestampedHeader("whsec_test", body, now);
    expect(verifyTimestampedHeader({ header, rawBody: body, secret: "whsec_test", now })).toBe(true);
    expect(verifyTimestampedHeader({ header, rawBody: body, secret: "whsec_other", now })).toBe(false);
    expect(verifyTimestampedHeader({ header, rawBody: Buffer.from(`${body} `), secret: "whsec_test", now })).toBe(false);
    expect(verifyTimestampedHeader({ header, rawBody: body, secret: "whsec_test", now: new Date(now.getTime() + 301_000) })).toBe(false);
    expect(verifyTimestampedHeader({ header: undefined, rawBody: body, secret: "whsec_test", now })).toBe(false);
  });

  it("matches Stripe's scheme, including several v1 signatures", () => {
    const t = Math.floor(now.getTime() / 1000);
    const good = hmacSha256Hex("whsec_stripe", `${t}.${body.toString()}`);
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good},v0=deadbeef`;
    expect(stripeConnector.verifyWebhook?.({ headers: { "stripe-signature": header }, rawBody: body, secret: "whsec_stripe", now })).toBe(true);
    expect(
      stripeConnector.verifyWebhook?.({ headers: { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, rawBody: body, secret: "whsec_stripe", now }),
    ).toBe(false);
  });

  it("verifies the Expense Wise scheme for custom webhooks", () => {
    const connectionWithConfig = { ...connection, config: {} };
    const event = genericWebhookConnector.buildTestEvent?.({ connection: connectionWithConfig, secret: "whsec_custom", now });
    if (!event) throw new Error("no test event");
    const headers = event.headers as Record<string, string>;
    expect(genericWebhookConnector.verifyWebhook?.({ headers, rawBody: event.rawBody, secret: "whsec_custom", now })).toBe(true);
    expect(
      genericWebhookConnector.verifyWebhook?.({
        headers: { ...headers, "x-expensewise-timestamp": String(Number(headers["x-expensewise-timestamp"]) + 1) },
        rawBody: event.rawBody,
        secret: "whsec_custom",
        now,
      }),
    ).toBe(false);
    const parsed = genericWebhookConnector.parseWebhook?.(event.rawBody, headers);
    expect(parsed).toMatchObject({ eventType: "revenue" });
    expect(genericWebhookConnector.normalize(parsed?.records[0] ?? {}, connectionWithConfig)).toMatchObject({
      kind: "revenue",
      amount: 250_000,
      currency: "BDT",
      customer: "Test customer",
    });
  });
});

describe("stripe mapping", () => {
  const config = {
    payoutAccountId: "0199a000-0000-7000-8000-00000000aaaa",
    revenueCategory: "Subscription revenue",
    feeCategory: "Payment processing fees",
    initialDays: 90,
  };

  it("maps charges to gross revenue plus a Stripe fee expense", () => {
    const [charge] = fixture("balance-transactions-page1.json").data as StripeBalanceTransaction[];
    const records = mapBalanceTransaction(charge as StripeBalanceTransaction, config, "Asia/Dhaka");
    expect(records).toEqual([
      expect.objectContaining({
        kind: "revenue",
        externalId: "txn_3PpQ2aCharge0001",
        amount: 4900,
        currency: "USD",
        customer: "Nimbus Labs",
        product: "Team plan (monthly)",
        reference: "ch_3PpQ2aCharge0001",
      }),
      expect.objectContaining({
        kind: "expense",
        externalId: "txn_3PpQ2aCharge0001:fee",
        amount: 172,
        vendor: "Stripe",
        description: "Stripe fees",
        categoryHint: "Payment processing fees",
      }),
    ]);
  });

  it("maps refunds out, payouts to transfers only with a payout account, and skips the rest with a reason", () => {
    const [, refund] = fixture("balance-transactions-page1.json").data as StripeBalanceTransaction[];
    expect(mapBalanceTransaction(refund as StripeBalanceTransaction, config, "Asia/Dhaka")).toEqual([
      expect.objectContaining({ kind: "transaction", type: "refund", direction: "out", amount: 2900, counterparty: "Pixelwave" }),
    ]);
    const [payout, adjustment, topup] = fixture("balance-transactions-page2.json").data as StripeBalanceTransaction[];
    expect(mapBalanceTransaction(payout as StripeBalanceTransaction, config, "Asia/Dhaka")).toEqual([
      expect.objectContaining({ kind: "transaction", type: "transfer", amount: 15000, toAccountRef: config.payoutAccountId }),
    ]);
    expect(mapBalanceTransaction(payout as StripeBalanceTransaction, { ...config, payoutAccountId: null }, "Asia/Dhaka")).toEqual([
      expect.objectContaining({ kind: "skip", externalId: "txn_1PpPayout0001", reason: expect.stringMatching(/payout account/) }),
    ]);
    expect(mapBalanceTransaction(adjustment as StripeBalanceTransaction, config, "Asia/Dhaka")).toEqual([
      expect.objectContaining({ kind: "transaction", type: "adjustment", direction: "out", amount: 500 }),
      expect.objectContaining({ kind: "expense", externalId: "txn_1PpAdjust0001:fee", amount: 1500 }),
    ]);
    expect(mapBalanceTransaction(topup as StripeBalanceTransaction, config, "Asia/Dhaka")).toEqual([expect.objectContaining({ kind: "skip" })]);
  });

  it("maps webhook events onto the balance transaction ids a sync would use", () => {
    const body = Buffer.from(JSON.stringify(fixture("event-charge-succeeded.json")));
    const parsed = stripeConnector.parseWebhook?.(body, {});
    expect(parsed).toMatchObject({ eventId: "evt_3PpQ9zEvent0001", eventType: "charge.succeeded" });
    const records = stripeConnector.normalize(parsed?.records[0] ?? {}, { ...connection, config });
    expect(records).toEqual([expect.objectContaining({ kind: "revenue", externalId: "txn_3PpQ9zCharge0002", amount: 9900, customer: "Riverstone Ltd" })]);
  });

  it("pages balance transactions with starting_after and resumes from created[gte]", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (request) => {
      calls.push(request.url);
      expect(request.headers?.Authorization).toBe("Bearer rk_test_abcdefghijklmnop");
      if (request.url.includes("/balance_transactions") && !request.url.includes("starting_after"))
        return jsonResponse(200, fixture("balance-transactions-page1.json"));
      if (request.url.includes("starting_after=txn_3PpQ2aRefund0001")) return jsonResponse(200, fixture("balance-transactions-page2.json"));
      if (request.url.endsWith("/balance")) return jsonResponse(200, fixture("balance.json"));
      return jsonResponse(404, { error: { message: "not found" } });
    };
    const ctx = {
      connection: { ...connection, provider: "stripe" },
      config,
      credentials: { secretKey: "rk_test_abcdefghijklmnop" },
      http,
      now: new Date("2025-09-05T00:00:00Z"),
      allowPrivateNetwork: false,
    };
    const first = await stripeConnector.fetch?.(ctx, { cursor: null, since: null, trigger: "initial" });
    expect(first?.hasMore).toBe(true);
    expect(first?.records).toHaveLength(2);
    expect(calls[0]).toContain("created%5Bgte%5D=");
    const second = await stripeConnector.fetch?.(ctx, { cursor: first?.nextCursor, since: null, trigger: "initial" });
    expect(second?.hasMore).toBe(false);
    expect(second?.records.filter((r) => r.__stripe === "balance")).toEqual([expect.objectContaining({ currency: "USD", amount: 83_828 })]);
    expect(second?.nextCursor).toEqual({ createdGte: 1756800000 - 600 });
  });

  it("reports a rejected key clearly", async () => {
    const http: HttpClient = async () => jsonResponse(401, { error: { message: "Invalid API Key provided" } });
    const result = await stripeConnector.validate?.({
      credentials: { secretKey: "rk_live_badbadbadbadbad" },
      config,
      http,
      now: new Date(),
      allowPrivateNetwork: false,
    });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/rejected the API key/) });
  });
});

describe("custom API connector", () => {
  const config = genericRestConnector.configSchema.parse({
    baseUrl: "https://api.myshop.example",
    auth: { type: "header", name: "X-Api-Key" },
    endpoints: [
      {
        path: "/orders",
        entity: "revenue",
        itemsPath: "data.items",
        pagination: { type: "cursor", cursorPath: "data.next", cursorParam: "after" },
        mapping: { externalId: "id", amount: "total", currency: "currency", date: "paid_at", description: "product.name", counterparty: "customer.name" },
      },
      {
        path: "/costs",
        entity: "transaction",
        pagination: { type: "page", pageParam: "page", sizeParam: "per_page", pageSize: 2 },
        mapping: { externalId: "ref", amount: "amount_cents", amountUnit: "minor", date: "date", description: "memo", type: "kind" },
        defaults: { currency: "USD" },
      },
    ],
  });

  it("follows cursor and page pagination across endpoints and sends the auth header", async () => {
    const seen: string[] = [];
    const http: HttpClient = async (request) => {
      seen.push(request.url);
      expect(request.headers?.["X-Api-Key"]).toBe("secret-key");
      const url = new URL(request.url);
      if (url.pathname === "/orders" && !url.searchParams.get("after")) {
        return jsonResponse(200, {
          data: {
            items: [{ id: "o1", total: "19.99", currency: "usd", paid_at: "2026-09-10T08:00:00Z", product: { name: "Pro" }, customer: { name: "Ann" } }],
            next: "c2",
          },
        });
      }
      if (url.pathname === "/orders")
        return jsonResponse(200, { data: { items: [{ id: "o2", total: 5, currency: "USD", paid_at: "2026-09-11", product: { name: "Lite" } }], next: null } });
      if (url.pathname === "/costs" && url.searchParams.get("page") === "1")
        return jsonResponse(200, [
          { ref: "c1", amount_cents: -1500, date: "2026-09-12", memo: "Hosting", kind: "expense" },
          { ref: "c2", amount_cents: 300, date: "2026-09-12", memo: "Refund", kind: "refund" },
        ]);
      return jsonResponse(200, [{ ref: "c3", amount_cents: -700, date: "2026-09-13", memo: "Domain", kind: "expense" }]);
    };
    const ctx = { connection, config, credentials: { token: "secret-key" }, http, now: new Date("2026-09-20T00:00:00Z"), allowPrivateNetwork: false };
    let cursor: unknown = null;
    const records: Array<Record<string, unknown>> = [];
    for (let page = 0; page < 10; page++) {
      const result = await genericRestConnector.fetch?.(ctx, { cursor, since: null, trigger: "initial" });
      if (!result) throw new Error("no fetch");
      records.push(...result.records);
      cursor = result.nextCursor;
      if (!result.hasMore) break;
    }
    expect(seen.map((u) => new URL(u).pathname + new URL(u).search)).toEqual([
      "/orders",
      "/orders?after=c2",
      "/costs?page=1&per_page=2",
      "/costs?page=2&per_page=2",
    ]);
    expect(cursor).toEqual({ lastCompletedAt: "2026-09-20T00:00:00.000Z" });
    const mapped = records.map((raw) => genericRestConnector.normalize(raw, { ...connection, config }));
    expect(mapped[0]).toMatchObject({
      kind: "revenue",
      externalId: "o1",
      amount: 1999,
      currency: "USD",
      date: "2026-09-10",
      customer: "Ann",
      description: "Pro",
    });
    expect(mapped[2]).toMatchObject({ kind: "transaction", externalId: "c1", type: "expense", amount: 1500, currency: "USD" });
    expect(mapped[3]).toMatchObject({ kind: "transaction", type: "refund", direction: "in", amount: 300 });
  });

  it("names the missing field when a record does not map", () => {
    const endpoint = config.endpoints[0];
    if (!endpoint) throw new Error("no endpoint");
    expect(() => mapGenericItem({ id: "x", currency: "USD", paid_at: "2026-09-10" }, endpoint, connection)).toThrow(/no usable amount at "total"/);
  });

  it("refuses private targets before sending anything", async () => {
    let called = false;
    const http: HttpClient = async () => {
      called = true;
      return jsonResponse(200, []);
    };
    const local = genericRestConnector.configSchema.parse({ ...config, baseUrl: "http://127.0.0.1:9000" });
    const result = await genericRestConnector.validate?.({
      credentials: { token: "secret-key" },
      config: local,
      http,
      now: new Date(),
      allowPrivateNetwork: false,
    });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/private or loopback/) });
    expect(called).toBe(false);
  });
});

describe("demo feeds", () => {
  it("are deterministic per connection and day", () => {
    expect(demoBankDay("conn-a", "2026-08-01")).toEqual(demoBankDay("conn-a", "2026-08-01"));
    expect(demoBankDay("conn-a", "2026-08-01").find((t) => t.category === "Salary")).toMatchObject({
      type: "income",
      amount: 8_500_000,
      id: expect.stringMatching(/^DB-20260801-/),
    });
    expect(demoBankRange("conn-a", "2026-08-01", "2026-08-31").every((t) => t.amount > 0 && /^DB-\d{8}-\d{2}$/.test(t.id))).toBe(true);
  });

  it("maps demo payments to revenue, fees, refunds and conditional payouts", () => {
    const normalize = (raw: Record<string, unknown>, payoutAccountId: string | null) =>
      demoPaymentsConnector.normalize(raw, { ...connection, config: { currency: "USD", payoutAccountId } });
    expect(
      normalize(
        {
          object: "charge",
          id: "ch_1",
          amount: 2900,
          fee: 114,
          currency: "usd",
          created: 1757700000,
          customer: { name: "Nimbus Labs", email: "x@y.z" },
          product: "Pro",
          category: "Subscription revenue",
        },
        null,
      ),
    ).toEqual([
      expect.objectContaining({ kind: "revenue", amount: 2900, customer: "Nimbus Labs" }),
      expect.objectContaining({ kind: "expense", externalId: "ch_1:fee", amount: 114, categoryHint: "Payment processing fees" }),
    ]);
    expect(normalize({ object: "payout", id: "po_1", amount: 5000, currency: "usd", created: 1757700000 }, null)).toMatchObject({ kind: "skip" });
    expect(normalize({ object: "payout", id: "po_1", amount: 5000, currency: "usd", created: 1757700000 }, connection.id)).toMatchObject({
      kind: "transaction",
      type: "transfer",
      toAccountRef: connection.id,
    });
  });
});

describe("catalog", () => {
  it("lists real connectors with field metadata and coming-soon entries", () => {
    const catalog = new ConnectorRegistry().catalog();
    const byId = new Map(catalog.map((entry) => [entry.provider, entry]));
    expect(byId.get("stripe")).toMatchObject({
      available: true,
      connectable: true,
      requiresAccount: true,
      createsAccount: true,
      capabilities: { sync: true, webhook: true },
    });
    expect(byId.get("generic_rest")).toMatchObject({ requiresAccount: false, createsAccount: false });
    expect(byId.get("stripe")?.credentialFields.map((f) => f.key)).toEqual(["secretKey", "webhookSigningSecret"]);
    expect(byId.get("paypal")).toMatchObject({ available: false, connectable: false });
    expect(byId.get("file_import")).toMatchObject({ href: "/integrations/import", capabilities: { import: true } });
    expect(["demo_bank", "demo_payments", "stripe", "generic_rest", "generic_webhook"].every((id) => byId.get(id)?.available)).toBe(true);
  });
});

describe("statement parsing", () => {
  it("finds the header under a preamble and guesses Bangladeshi bank columns", async () => {
    const csv = [
      "﻿Demo Bank Ltd - Statement of Account",
      "Account No:,1234567890",
      "",
      "Txn Date;Particulars;Cheque No;Withdrawal (Dr);Deposit (Cr);Balance",
      "13/09/2026;POS SHWAPNO GULSHAN;;1,250.00;;48,750.00",
      "14/09/2026;SALARY SEP;;;85,000.00;1,33,750.00",
    ].join("\r\n");
    const sheet = await parseImportFile("csv", Buffer.from(csv, "utf8"));
    expect(sheet.headerRow).toBe(4);
    expect(sheet.delimiter).toBe(";");
    expect(sheet.rows).toHaveLength(2);
    const mapping = guessMapping(sheet.headers);
    expect(mapping).toMatchObject({
      date: "Txn Date",
      description: "Particulars",
      reference: "Cheque No",
      debit: "Withdrawal (Dr)",
      credit: "Deposit (Cr)",
      balance: "Balance",
    });
    expect(guessOptions(sheet.rows, mapping).dateFormat).toBe("DD/MM/YYYY");
  });

  it("guesses bKash-style and US-style statements", () => {
    const bkash = tabulate(
      [
        ["Date", "Trx ID", "Transaction Type", "To/From", "Amount (BDT)", "Balance"],
        ["09/13/2026", "9J7K2L3M4N", "Send Money", "01711000000", "-500", "1000"],
      ],
      { delimiter: ",", sheet: null, sheets: [] },
    );
    const mapping = guessMapping(bkash.headers);
    expect(mapping).toMatchObject({
      date: "Date",
      reference: "Trx ID",
      type: "Transaction Type",
      merchant: "To/From",
      amount: "Amount (BDT)",
      balance: "Balance",
    });
    expect(guessOptions(bkash.rows, mapping).dateFormat).toBe("MM/DD/YYYY");
  });

  it("reads .xlsx workbooks and detects formats", async () => {
    const workbook = buildXlsx({
      Summary: [["Nothing here"]],
      Transactions: [
        ["Date", "Description", "Amount"],
        ["2026-09-10", "Coffee", -350.5],
        ["2026-09-11", "Refund", 120],
      ],
    });
    expect(detectFormat("statement.xlsx", "application/octet-stream", workbook)).toBe("xlsx");
    expect(detectFormat("s.pdf", "application/pdf", Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectFormat("s.csv", "text/csv", Buffer.from("a,b"))).toBe("csv");
    const sheet = await parseImportFile("xlsx", workbook, "transactions");
    expect(sheet.sheet).toBe("Transactions");
    expect(sheet.sheets).toEqual(["Summary", "Transactions"]);
    expect(sheet.rows.map((r) => r.raw)).toEqual([
      { Date: "2026-09-10", Description: "Coffee", Amount: "-350.5" },
      { Date: "2026-09-11", Description: "Refund", Amount: "120" },
    ]);
    await expect(parseImportFile("xlsx", workbook, "Nope")).rejects.toThrow(/no sheet called "Nope"/);
  });
});
