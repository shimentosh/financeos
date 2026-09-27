import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import type { AppRequest, SessionUser } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { billingPayments, billingSubscriptions, creditTransactions } from "../../src/db/schema/index.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { BillingAdminService } from "../../src/modules/billing/billing-admin.service.js";
import { forgetBillingConfig } from "../../src/modules/billing/billing-config.js";
import { CreditsService } from "../../src/modules/billing/credits.service.js";
import { EntitlementsService } from "../../src/modules/billing/entitlements.service.js";
import { BILLING_FETCH } from "../../src/modules/billing/http.js";
import { StripeService } from "../../src/modules/billing/stripe.service.js";
import { signTimestampedHeader } from "../../src/modules/integrations/connectors/signatures.js";
import { ApiKeysService } from "../../src/modules/integrations/public-api/api-keys.service.js";
import { enableBilling, FakeFetch, jsonResponse } from "../fixtures/billing.js";
import { createUser, resetDatabase, shutdown, type TestUser } from "./harness.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
const DAY = 86_400_000;
const fetcher = new FakeFetch();

let nest: INestApplication;
let baseUrl: string;
let billing: BillingService;
let stripe: StripeService;
let entitlements: EntitlementsService;
let credits: CreditsService;
let admin: BillingAdminService;
let keys: ApiKeysService;
let user: TestUser;
let sessionUser: SessionUser;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BILLING_FETCH)
    .useValue(fetcher.fn)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  const server = app.getHttpAdapter().getInstance();
  server.use(
    express.json({
      limit: "2mb",
      verify: ((request: AppRequest, _response: unknown, buffer: Buffer) => {
        request.rawBody = buffer;
      }) as never,
    }),
  );
  server.use(express.urlencoded({ extended: false }));
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");
  nest = app;
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  billing = moduleRef.get(BillingService, { strict: false });
  stripe = moduleRef.get(StripeService, { strict: false });
  entitlements = moduleRef.get(EntitlementsService, { strict: false });
  credits = moduleRef.get(CreditsService, { strict: false });
  admin = moduleRef.get(BillingAdminService, { strict: false });
  keys = moduleRef.get(ApiKeysService, { strict: false });
});

afterAll(async () => {
  await nest?.close();
  await shutdown();
});

beforeEach(async () => {
  await resetDatabase();
  forgetBillingConfig();
  fetcher.reset();
  user = await createUser("Tanvir Ahmed");
  sessionUser = { id: user.userId, name: "Tanvir Ahmed", email: user.email, role: "user" };
  await enableBilling({
    trial: { enabled: false },
    stripe: { secretKey: "sk_test_0123456789abcdef", webhookSecret: WEBHOOK_SECRET },
    sslcommerz: { storeId: "teststore", storePassword: "teststore@ssl", sandbox: true },
    manual: "Send ৳600 to bKash 01700000000 with your email as the reference",
  });
});

/** Stripe's answers: a customer and a checkout session. */
function stripeApi(sessionId: string) {
  fetcher.handler = (call) => {
    if (call.url.endsWith("/v1/customers")) return jsonResponse({ id: "cus_T1" });
    if (call.url.endsWith("/v1/checkout/sessions")) return jsonResponse({ id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` });
    return jsonResponse({ error: { message: `Unexpected ${call.url}` } }, 404);
  };
}

function signed(event: Record<string, unknown>, at = new Date()) {
  const raw = Buffer.from(JSON.stringify(event));
  return { raw, header: signTimestampedHeader(WEBHOOK_SECRET, raw, at) };
}

let eventSeq = 0;
function event(type: string, object: Record<string, unknown>, createdAt = new Date()) {
  eventSeq += 1;
  return { id: `evt_${eventSeq}`, type, created: Math.floor(createdAt.getTime() / 1000) + eventSeq, data: { object } };
}

const deliver = (e: Record<string, unknown>) => {
  const { raw, header } = signed(e);
  return stripe.handleWebhook(raw, header);
};

const subscriptionRow = async () => (await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, user.userId)))[0];

describe("Stripe", () => {
  it("starts a subscription checkout with an inline recurring price and remembers the customer", async () => {
    stripeApi("cs_test_plan");
    const { url } = await billing.checkout(sessionUser, { purpose: "plan", plan: "pro", interval: "month", provider: "stripe" });
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_plan");
    const form = fetcher.form("/v1/checkout/sessions");
    expect(Object.fromEntries(form)).toMatchObject({
      mode: "subscription",
      customer: "cus_T1",
      client_reference_id: user.userId,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "500",
      "line_items[0][price_data][recurring][interval]": "month",
      "metadata[purpose]": "plan",
      "metadata[plan]": "pro",
      "subscription_data[metadata][userId]": user.userId,
    });
    expect(form.get("success_url")).toMatch(/\/settings\/billing\?checkout=success$/);
    expect(fetcher.calls[0]?.url).toBe("https://api.stripe.com/v1/customers");
    const [payment] = await db.select().from(billingPayments).where(eq(billingPayments.userId, user.userId));
    expect(payment).toMatchObject({
      provider: "stripe",
      providerRef: "cs_test_plan",
      status: "pending",
      purpose: "plan",
      plan: "pro",
      amount: 500,
      currency: "USD",
    });
    expect(form.get("metadata[paymentId]")).toBe(payment?.id);
    expect(await subscriptionRow()).toMatchObject({ plan: "free", providerCustomerId: "cus_T1" });

    // The customer is reused next time.
    stripeApi("cs_test_credits");
    await billing.checkout(sessionUser, { purpose: "credits", packId: "credits-500", provider: "stripe" });
    expect(fetcher.calls.filter((c) => c.url.endsWith("/v1/customers"))).toHaveLength(1);
    expect(Object.fromEntries(fetcher.form("/v1/checkout/sessions"))).toMatchObject({
      mode: "payment",
      customer: "cus_T1",
      "line_items[0][price_data][unit_amount]": "500",
    });
  });

  it("verifies the webhook signature and refuses bad or replayed deliveries", async () => {
    const e = event("customer.created", { id: "cus_x" });
    const { raw, header } = signed(e);
    await expect(stripe.handleWebhook(raw, header)).resolves.toMatchObject({ received: true, handled: false });
    await expect(stripe.handleWebhook(raw, header.replace(/v1=[0-9a-f]{6}/, "v1=000000"))).rejects.toMatchObject({ status: 400, code: "invalid_signature" });
    await expect(stripe.handleWebhook(Buffer.from(`${raw.toString()} `), header)).rejects.toMatchObject({ status: 400, code: "invalid_signature" });
    const replay = signTimestampedHeader(WEBHOOK_SECRET, raw, new Date(Date.now() - 10 * 60_000));
    await expect(stripe.handleWebhook(raw, replay)).rejects.toMatchObject({ status: 400, code: "invalid_signature" });
    await expect(stripe.handleWebhook(raw, undefined)).rejects.toMatchObject({ status: 400 });

    // Over HTTP, with the raw body.
    const ok = await fetch(`${baseUrl}/billing/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: raw,
    });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${baseUrl}/billing/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
      body: raw,
    });
    expect(bad.status).toBe(400);
  });

  it("a paid credit pack is granted exactly once", async () => {
    stripeApi("cs_test_pack");
    await billing.checkout(sessionUser, { purpose: "credits", packId: "credits-2500", provider: "stripe" });
    const [payment] = await db.select().from(billingPayments).where(eq(billingPayments.providerRef, "cs_test_pack"));
    const completed = event("checkout.session.completed", {
      id: "cs_test_pack",
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      amount_total: 2_000,
      currency: "usd",
      customer: "cus_T1",
      payment_intent: "pi_123",
      metadata: { userId: user.userId, purpose: "credits", packId: "credits-2500", paymentId: payment?.id },
    });
    await deliver(completed);
    await deliver(completed);
    await deliver({ ...completed, id: "evt_other_delivery" });
    const [paid] = await db.select().from(billingPayments).where(eq(billingPayments.providerRef, "cs_test_pack"));
    expect(paid).toMatchObject({ status: "paid", providerPaymentId: "pi_123", credits: 2_500 });
    const grants = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.paymentId, paid?.id as string));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: "purchase", source: "balance", credits: 2_500 });
    expect((await credits.summary(user.userId)).balance).toBe(2_500);
  });

  it("a subscription checkout activates the plan; subscription and invoice events keep it in step", async () => {
    stripeApi("cs_test_sub");
    await billing.checkout(sessionUser, { purpose: "plan", plan: "business", interval: "year", provider: "stripe" });
    const [payment] = await db.select().from(billingPayments).where(eq(billingPayments.providerRef, "cs_test_sub"));
    const completed = event("checkout.session.completed", {
      id: "cs_test_sub",
      mode: "subscription",
      payment_status: "paid",
      amount_total: 15_000,
      currency: "usd",
      customer: "cus_T1",
      subscription: "sub_T1",
      invoice: "in_first",
      metadata: { userId: user.userId, purpose: "plan", plan: "business", interval: "year", paymentId: payment?.id },
    });
    await deliver(completed);
    await deliver(completed);
    expect(await subscriptionRow()).toMatchObject({
      plan: "business",
      status: "active",
      provider: "stripe",
      providerSubscriptionId: "sub_T1",
      interval: "year",
    });
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "business", status: "active" });
    expect(await db.$count(billingPayments, and(eq(billingPayments.userId, user.userId), eq(billingPayments.status, "paid")))).toBe(1);

    // The first invoice adds its link to that payment instead of a second one.
    const now = Math.floor(Date.now() / 1000);
    const yearEnd = now + 365 * 86_400;
    await deliver(
      event("invoice.paid", {
        id: "in_first",
        billing_reason: "subscription_create",
        subscription: "sub_T1",
        customer: "cus_T1",
        amount_paid: 15_000,
        currency: "usd",
        hosted_invoice_url: "https://invoice.stripe.com/i/first",
        lines: { data: [{ period: { start: now, end: yearEnd } }] },
      }),
    );
    expect(await db.$count(billingPayments, eq(billingPayments.userId, user.userId))).toBe(1);
    expect((await db.select().from(billingPayments).where(eq(billingPayments.providerRef, "cs_test_sub")))[0]?.receiptUrl).toBe(
      "https://invoice.stripe.com/i/first",
    );

    // Cancel at period end, exact period from Stripe (newer API: on the item).
    await deliver(
      event("customer.subscription.updated", {
        id: "sub_T1",
        customer: "cus_T1",
        status: "active",
        cancel_at_period_end: true,
        metadata: { userId: user.userId, plan: "business", interval: "year" },
        items: { data: [{ price: { recurring: { interval: "year" } }, current_period_start: now, current_period_end: yearEnd }] },
      }),
    );
    const updated = await subscriptionRow();
    expect(updated).toMatchObject({ cancelAtPeriodEnd: true, status: "active" });
    expect(updated?.currentPeriodEnd?.getTime()).toBe(yearEnd * 1000);

    // A renewal: one payment row however often it is delivered, and the period moves on.
    const renewal = event("invoice.paid", {
      id: "in_renewal",
      billing_reason: "subscription_cycle",
      parent: { subscription_details: { subscription: "sub_T1", metadata: { userId: user.userId } } },
      customer: "cus_T1",
      amount_paid: 15_000,
      currency: "usd",
      payment_intent: "pi_renewal",
      hosted_invoice_url: "https://invoice.stripe.com/i/renewal",
      lines: { data: [{ period: { start: yearEnd, end: yearEnd + 365 * 86_400 } }] },
    });
    await deliver(renewal);
    await deliver(renewal);
    const renewals = await db.select().from(billingPayments).where(eq(billingPayments.providerRef, "in_renewal"));
    expect(renewals).toHaveLength(1);
    expect(renewals[0]).toMatchObject({ status: "paid", amount: 15_000, currency: "USD", plan: "business", interval: "year" });
    expect((await subscriptionRow())?.currentPeriodEnd?.getTime()).toBe((yearEnd + 365 * 86_400) * 1000);

    // A failed payment: past due, the plan kept during the grace period, one email.
    const failed = event("invoice.payment_failed", { id: "in_failed", subscription: "sub_T1", customer: "cus_T1" });
    await deliver(failed);
    await deliver(failed);
    const pastDue = await subscriptionRow();
    expect(pastDue).toMatchObject({ status: "past_due" });
    expect(pastDue?.metadata).toMatchObject({ failedInvoiceNotified: "in_failed", pastDueAt: expect.any(String) });
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "business", status: "past_due" });

    // Deleted: the plan ends; an older event arriving late changes nothing.
    const stale = event(
      "customer.subscription.updated",
      { id: "sub_T1", customer: "cus_T1", status: "active", metadata: { plan: "business" } },
      new Date(Date.now() - DAY),
    );
    await deliver(event("customer.subscription.deleted", { id: "sub_T1", customer: "cus_T1", status: "canceled", ended_at: now - 60, canceled_at: now - 60 }));
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free", status: "canceled" });
    await deliver(stale);
    expect(await subscriptionRow()).toMatchObject({ status: "canceled" });
  });

  it("cancel and resume a card subscription through Stripe, and open the billing portal", async () => {
    await db.insert(billingSubscriptions).values({
      userId: user.userId,
      plan: "pro",
      status: "active",
      provider: "stripe",
      providerCustomerId: "cus_T1",
      providerSubscriptionId: "sub_T9",
      interval: "month",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });
    fetcher.handler = (call) => {
      if (call.url.endsWith("/v1/subscriptions/sub_T9"))
        return jsonResponse({ id: "sub_T9", cancel_at_period_end: new URLSearchParams(call.body).get("cancel_at_period_end") === "true" });
      if (call.url.endsWith("/v1/billing_portal/sessions")) return jsonResponse({ id: "bps_1", url: "https://billing.stripe.com/p/session/abc" });
      return jsonResponse({ error: { message: "unexpected" } }, 404);
    };
    const canceled = await billing.cancel(sessionUser);
    expect(canceled).toMatchObject({ plan: "pro", cancelAtPeriodEnd: true, hasStripeSubscription: true });
    expect(fetcher.form("/v1/subscriptions/sub_T9").get("cancel_at_period_end")).toBe("true");
    expect((await billing.resume(sessionUser)).cancelAtPeriodEnd).toBe(false);
    expect(await billing.portal(sessionUser)).toEqual({ url: "https://billing.stripe.com/p/session/abc" });
    expect(fetcher.form("/v1/billing_portal/sessions").get("customer")).toBe("cus_T1");
    // A second card subscription is refused while one is live.
    await expect(billing.checkout(sessionUser, { purpose: "plan", plan: "business", interval: "month", provider: "stripe" })).rejects.toMatchObject({
      status: 409,
      code: "subscription_exists",
    });
  });
});

describe("SSLCommerz", () => {
  const validation: Record<string, unknown> = {};

  function sslApi() {
    fetcher.handler = (call) => {
      if (call.url.includes("/gwprocess/v4/api.php")) {
        return jsonResponse({ status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.com/EasyCheckOut/testcde", sessionkey: "sk1" });
      }
      if (call.url.includes("/validator/api/validationserverAPI.php")) return jsonResponse(validation);
      return jsonResponse({}, 404);
    };
  }

  async function startPlan() {
    sslApi();
    const { url } = await billing.checkout(sessionUser, { purpose: "plan", plan: "pro", interval: "month", provider: "sslcommerz" });
    expect(url).toBe("https://sandbox.sslcommerz.com/EasyCheckOut/testcde");
    const init = fetcher.form("/gwprocess/v4/api.php");
    const tranId = init.get("tran_id") as string;
    Object.assign(validation, {
      status: "VALID",
      tran_id: tranId,
      amount: "600.00",
      currency: "BDT",
      currency_type: "BDT",
      currency_amount: "600.00",
      bank_tran_id: "BT-1",
    });
    return { init, tranId };
  }

  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${baseUrl}/billing/sslcommerz/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://sandbox.sslcommerz.com" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });

  it("a validated payment extends a prepaid plan from the end of the period already paid", async () => {
    const { init, tranId } = await startPlan();
    expect(Object.fromEntries(init)).toMatchObject({
      store_id: "teststore",
      total_amount: "600.00",
      currency: "BDT",
      cus_email: user.email,
      product_profile: "non-physical-goods",
      shipping_method: "NO",
    });
    expect(init.get("success_url")).toMatch(/\/api\/billing\/sslcommerz\/success$/);
    expect(init.get("ipn_url")).toMatch(/\/api\/billing\/sslcommerz\/ipn$/);

    const response = await post("success", { tran_id: tranId, val_id: "VAL-1", status: "VALID", amount: "600.00" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/\/settings\/billing\?checkout=success$/);
    const validate = fetcher.form("/validator/api/validationserverAPI.php");
    expect(Object.fromEntries(validate)).toMatchObject({ val_id: "VAL-1", store_id: "teststore", store_passwd: "teststore@ssl", format: "json" });

    const first = await subscriptionRow();
    expect(first).toMatchObject({ plan: "pro", status: "active", provider: "sslcommerz", interval: "month" });
    const firstEnd = first?.currentPeriodEnd?.getTime() ?? 0;
    expect(Math.round((firstEnd - Date.now()) / DAY)).toBeGreaterThanOrEqual(28);
    const [payment] = await db.select().from(billingPayments).where(eq(billingPayments.providerRef, tranId));
    expect(payment).toMatchObject({ status: "paid", providerPaymentId: "BT-1", amount: 60_000, currency: "BDT" });

    // The IPN and a repeated return change nothing.
    expect(await (await post("ipn", { tran_id: tranId, val_id: "VAL-1", status: "VALID" })).json()).toMatchObject({ outcome: "success" });
    expect((await post("success", { tran_id: tranId, val_id: "VAL-1" })).status).toBe(303);
    expect((await subscriptionRow())?.currentPeriodEnd?.getTime()).toBe(firstEnd);

    // Paying again adds another month after the current one.
    const second = await startPlan();
    await post("success", { tran_id: second.tranId, val_id: "VAL-2" });
    const extended = (await subscriptionRow())?.currentPeriodEnd?.getTime() ?? 0;
    expect(Math.round((extended - firstEnd) / DAY)).toBeGreaterThanOrEqual(28);
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "pro", status: "active" });
  });

  it("rejects a validation whose amount does not match, and returns fail and cancel with their outcome", async () => {
    const { tranId } = await startPlan();
    validation.currency_amount = "6.00";
    validation.amount = "6.00";
    const response = await post("success", { tran_id: tranId, val_id: "VAL-9" });
    expect(response.headers.get("location")).toMatch(/checkout=failed$/);
    const [payment] = await db.select().from(billingPayments).where(eq(billingPayments.providerRef, tranId));
    expect(payment?.status).toBe("failed");
    expect(String(payment?.metadata?.reason)).toMatch(/amount 6.00 instead of 600/);
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free" });

    const canceled = await startPlan();
    const back = await post("cancel", { tran_id: canceled.tranId, status: "CANCELLED" });
    expect(back.headers.get("location")).toMatch(/checkout=canceled$/);
    expect((await db.select().from(billingPayments).where(eq(billingPayments.providerRef, canceled.tranId)))[0]?.status).toBe("canceled");

    const failed = await startPlan();
    expect((await post("fail", { tran_id: failed.tranId, status: "FAILED" })).headers.get("location")).toMatch(/checkout=failed$/);
    expect((await post("success", { tran_id: "EW-unknown" })).headers.get("location")).toMatch(/checkout=failed$/);
  });

  it("a credit pack paid in BDT is granted once", async () => {
    sslApi();
    await billing.checkout(sessionUser, { purpose: "credits", packId: "credits-500", provider: "sslcommerz" });
    const tranId = fetcher.form("/gwprocess/v4/api.php").get("tran_id") as string;
    Object.assign(validation, { status: "VALIDATED", tran_id: tranId, amount: "600.00", currency: "BDT", currency_type: "BDT", currency_amount: "600.00" });
    await post("success", { tran_id: tranId, val_id: "VAL-C" });
    await post("ipn", { tran_id: tranId, val_id: "VAL-C", status: "VALID" });
    expect((await credits.summary(user.userId)).balance).toBe(500);
  });
});

describe("over HTTP", () => {
  it("the price list is public and never shows secrets", async () => {
    const response = await fetch(`${baseUrl}/billing/plans`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ enabled: true, providers: { stripe: true, sslcommerz: true, manual: true }, currencies: ["BDT", "USD"] });
    expect(body).not.toContain("sk_test_");
    expect(body).not.toContain("teststore@ssl");
    // Everything else needs a session.
    expect((await fetch(`${baseUrl}/billing`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin/billing`)).status).toBe(401);
  });

  it("API keys and MCP stop working (402) when the owner's plan no longer includes them", async () => {
    await admin.setPlan(user.userId, { plan: "pro", status: "active" }, { id: user.userId, email: user.email });
    const { key } = await keys.create(user.business, { name: "Agent", scopes: ["read"] });
    const auth = { Authorization: `Bearer ${key}` };
    expect((await fetch(`${baseUrl}/v1/accounts`, { headers: auth })).status).toBe(200);
    const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: mcpBody })).status).toBe(200);

    await admin.setPlan(user.userId, { plan: "free", status: "active" }, { id: user.userId, email: user.email });
    const api = await fetch(`${baseUrl}/v1/accounts`, { headers: auth });
    expect(api.status).toBe(402);
    expect(await api.json()).toMatchObject({ error: "plan_limit", issues: { limit: "apiAccess", plan: "free" } });
    const mcp = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: mcpBody });
    expect(mcp.status).toBe(402);
    expect(await mcp.json()).toMatchObject({ error: { code: -32003 } });
  });
});
