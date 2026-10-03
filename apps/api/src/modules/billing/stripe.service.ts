import { type BillingInterval, type BillingStatus, PLAN_IDS, type PlanId, uuidv7 } from "@financeos/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { badRequest, unprocessable } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { billingPayments, billingSubscriptions, users } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { verifyTimestampedHeader } from "../integrations/connectors/signatures.js";
import { appLink, sendEmail } from "../system/email.service.js";
import { type BillingConfig, loadBillingConfig } from "./billing-config.js";
import type { SubscriptionRow } from "./entitlements.service.js";
import { BILLING_FETCH, type BillingFetch, formEncode } from "./http.js";
import { PaymentsService } from "./payments.service.js";
import { addInterval, fromUnix } from "./periods.js";

const STRIPE_API = "https://api.stripe.com/v1";

type StripeObject = Record<string, unknown> & { id: string };
type StripeEvent = { id: string; type: string; created: number; data: { object: StripeObject } };

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
/** An expandable Stripe field: an id string or an object with an id. */
const idOf = (value: unknown): string | null => str(value) ?? str(obj(value).id);
const planOf = (value: unknown): PlanId | null => (PLAN_IDS.includes(value as PlanId) ? (value as PlanId) : null);
const intervalOf = (value: unknown): BillingInterval | null => (value === "month" || value === "year" ? value : null);

export const successUrl = () => appLink("/settings/billing?checkout=success");
export const cancelUrl = () => appLink("/settings/billing?checkout=canceled");

/**
 * Stripe over its REST API (no SDK): Checkout for plans (subscriptions) and
 * credit packs (one-time), the billing portal, cancel/resume, and the signed
 * webhook that keeps plans and payments in step with Stripe.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger("Stripe");

  constructor(
    @Inject(BILLING_FETCH) private readonly fetcher: BillingFetch,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  private async call<T = StripeObject>(
    secretKey: string | null,
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!secretKey) throw unprocessable("Stripe isn't set up on this server", "stripe_not_configured");
    const body = params ? formEncode(params) : undefined;
    const response = await this.fetcher(`${STRIPE_API}${path}${method === "GET" && body ? `?${body}` : ""}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: method === "POST" ? (body ?? "") : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = str(obj(json.error).message) ?? `HTTP ${response.status}`;
      this.logger.warn(`Stripe ${method} ${path} failed: ${message}`);
      throw unprocessable(`Stripe: ${message}`, "stripe_error");
    }
    return json as T;
  }

  /** Checks the secret key (GET /v1/balance). */
  async test(secretKey: string): Promise<{ ok: boolean; message: string }> {
    try {
      const balance = await this.call<{ livemode?: boolean }>(secretKey, "GET", "/balance");
      return { ok: true, message: `Connected to Stripe (${balance.livemode ? "live" : "test"} mode)` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The user's Stripe customer, created on first checkout and remembered on their subscription row. */
  private async customerFor(config: BillingConfig, user: { id: string; email: string; name: string }): Promise<string> {
    const row = await this.payments.subscriptionOf(user.id);
    if (row?.providerCustomerId?.startsWith("cus_")) return row.providerCustomerId;
    const customer = await this.call(config.stripe.secretKey, "POST", "/customers", { email: user.email, name: user.name, metadata: { userId: user.id } });
    await this.payments.upsertSubscription(
      user.id,
      row ? { providerCustomerId: customer.id } : { plan: "free", status: "active", providerCustomerId: customer.id },
    );
    return customer.id;
  }

  async checkout(
    config: BillingConfig,
    user: { id: string; email: string; name: string },
    item:
      | { purpose: "plan"; plan: PlanId; interval: BillingInterval; amount: number; currency: string }
      | { purpose: "credits"; packId: string; credits: number; amount: number; currency: string },
  ): Promise<{ url: string }> {
    const customer = await this.customerFor(config, user);
    const paymentId = uuidv7();
    const currency = item.currency.toLowerCase();
    const common = {
      customer,
      client_reference_id: user.id,
      success_url: successUrl(),
      cancel_url: cancelUrl(),
    };
    const session =
      item.purpose === "plan"
        ? await this.call(config.stripe.secretKey, "POST", "/checkout/sessions", {
            ...common,
            mode: "subscription",
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency,
                  unit_amount: item.amount,
                  recurring: { interval: item.interval },
                  product_data: { name: `FinanceOS ${config.plans[item.plan].name}` },
                },
              },
            ],
            metadata: { userId: user.id, purpose: "plan", plan: item.plan, interval: item.interval, paymentId },
            subscription_data: { metadata: { userId: user.id, plan: item.plan, interval: item.interval } },
          })
        : await this.call(config.stripe.secretKey, "POST", "/checkout/sessions", {
            ...common,
            mode: "payment",
            line_items: [
              {
                quantity: 1,
                price_data: { currency, unit_amount: item.amount, product_data: { name: `${item.credits.toLocaleString("en-US")} AI credits` } },
              },
            ],
            metadata: { userId: user.id, purpose: "credits", packId: item.packId, paymentId },
            payment_intent_data: { metadata: { userId: user.id, purpose: "credits", paymentId } },
          });
    const url = str(session.url);
    if (!url) throw unprocessable("Stripe did not return a checkout page", "stripe_error");
    await this.payments.create({
      id: paymentId,
      userId: user.id,
      provider: "stripe",
      providerRef: session.id,
      purpose: item.purpose,
      plan: item.purpose === "plan" ? item.plan : null,
      interval: item.purpose === "plan" ? item.interval : null,
      credits: item.purpose === "credits" ? item.credits : null,
      amount: item.amount,
      currency: item.currency,
      metadata: item.purpose === "credits" ? { packId: item.packId } : {},
    });
    return { url };
  }

  async portal(config: BillingConfig, row: SubscriptionRow | null): Promise<{ url: string }> {
    if (!row?.providerCustomerId?.startsWith("cus_")) throw badRequest("There is no card subscription to manage", "no_stripe_customer");
    const session = await this.call(config.stripe.secretKey, "POST", "/billing_portal/sessions", {
      customer: row.providerCustomerId,
      return_url: appLink("/settings/billing"),
    });
    const url = str(session.url);
    if (!url) throw unprocessable("Stripe did not return a portal link", "stripe_error");
    return { url };
  }

  /** Ends the card subscription straight away, with no further charges (the account is being deleted). */
  async cancelNow(config: BillingConfig, row: SubscriptionRow) {
    if (!row.providerSubscriptionId) return;
    await this.call(config.stripe.secretKey, "DELETE", `/subscriptions/${encodeURIComponent(row.providerSubscriptionId)}`);
  }

  /** Cancels at the end of the period (or takes that back). */
  async setCancelAtPeriodEnd(config: BillingConfig, row: SubscriptionRow, cancel: boolean) {
    if (!row.providerSubscriptionId) throw badRequest("There is no card subscription to change", "no_stripe_subscription");
    const subscription = await this.call(config.stripe.secretKey, "POST", `/subscriptions/${encodeURIComponent(row.providerSubscriptionId)}`, {
      cancel_at_period_end: cancel,
    });
    return this.payments.upsertSubscription(row.userId, {
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      canceledAt: cancel ? new Date() : null,
    });
  }

  // --------------------------------------------------------------- webhook

  /**
   * POST /billing/webhooks/stripe. The signature is HMAC-SHA256 of
   * `${t}.${rawBody}` with the endpoint's signing secret, at most five minutes
   * old. Every handler is idempotent: Stripe retries, and events can repeat
   * or arrive out of order.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined, now = new Date()) {
    const config = await loadBillingConfig();
    if (!config.stripe.webhookSecret) throw badRequest("Stripe webhooks aren't set up on this server", "stripe_not_configured");
    if (!rawBody?.length) throw badRequest("Missing request body", "invalid_payload");
    if (!verifyTimestampedHeader({ header: signature, rawBody, secret: config.stripe.webhookSecret, now })) {
      throw badRequest("Invalid Stripe signature", "invalid_signature");
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as StripeEvent;
    } catch {
      throw badRequest("Invalid JSON", "invalid_payload");
    }
    const object = event.data?.object;
    if (!object || typeof object !== "object") return { received: true, handled: false };
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await this.onCheckoutCompleted(config, object, now);
        return { received: true, handled: true };
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await this.onSubscription(object, event, now);
        return { received: true, handled: true };
      case "invoice.paid":
        await this.onInvoicePaid(object, now);
        return { received: true, handled: true };
      case "invoice.payment_failed":
        await this.onInvoiceFailed(config, object, now);
        return { received: true, handled: true };
      default:
        return { received: true, handled: false };
    }
  }

  private async onCheckoutCompleted(config: BillingConfig, session: StripeObject, now: Date) {
    const status = str(session.payment_status);
    if (status !== "paid" && status !== "no_payment_required") return;
    const metadata = obj(session.metadata);
    let payment =
      (str(metadata.paymentId) ? await this.payments.byId(str(metadata.paymentId) as string) : null) ?? (await this.payments.byRef("stripe", session.id));
    if (!payment) {
      // A session this server did not record (created elsewhere): record it from its metadata.
      const userId = str(metadata.userId) ?? str(session.client_reference_id);
      const purpose = metadata.purpose === "credits" ? "credits" : metadata.purpose === "plan" ? "plan" : null;
      if (!userId || !purpose) return;
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return;
      const pack = purpose === "credits" ? config.creditPacks.find((p) => p.id === metadata.packId) : null;
      payment = await this.payments.create({
        userId,
        provider: "stripe",
        providerRef: session.id,
        purpose,
        plan: planOf(metadata.plan),
        interval: intervalOf(metadata.interval),
        credits: pack?.credits ?? null,
        amount: num(session.amount_total) ?? 0,
        currency: str(session.currency) ?? "usd",
      });
      payment ??= await this.payments.byRef("stripe", session.id);
      if (!payment) return;
    }
    if (payment.provider !== "stripe") return;
    const amount = num(session.amount_total) ?? undefined;
    if (payment.purpose === "credits") {
      await this.payments.markPaid(payment.id, { providerPaymentId: idOf(session.payment_intent), amount, paidAt: now });
      return;
    }
    const invoiceId = idOf(session.invoice);
    await this.payments.markPaid(payment.id, { providerPaymentId: invoiceId, amount, paidAt: now });
    const plan = payment.plan ?? planOf(metadata.plan);
    const interval = payment.interval ?? intervalOf(metadata.interval) ?? "month";
    if (!plan) return;
    const subscriptionId = idOf(session.subscription);
    const row = await this.payments.subscriptionOf(payment.userId);
    // A subscription event may already have set the exact period; keep it.
    const known =
      row && subscriptionId && row.providerSubscriptionId === subscriptionId && row.status === "active" && row.currentPeriodEnd && row.currentPeriodEnd > now;
    await this.payments.upsertSubscription(payment.userId, {
      plan,
      status: "active",
      provider: "stripe",
      interval,
      providerCustomerId: idOf(session.customer) ?? row?.providerCustomerId ?? null,
      providerSubscriptionId: subscriptionId ?? row?.providerSubscriptionId ?? null,
      ...(known ? {} : { currentPeriodStart: now, currentPeriodEnd: addInterval(now, interval) }),
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      metadataPatch: { pastDueAt: undefined },
    });
  }

  /** The subscription row a Stripe object belongs to: by subscription id, then customer, then the user in its metadata. */
  private async rowFor(ids: { subscriptionId?: string | null; customerId?: string | null; userId?: string | null }): Promise<SubscriptionRow | null> {
    const conditions = [
      ids.subscriptionId ? eq(billingSubscriptions.providerSubscriptionId, ids.subscriptionId) : null,
      ids.customerId ? eq(billingSubscriptions.providerCustomerId, ids.customerId) : null,
      ids.userId ? eq(billingSubscriptions.userId, ids.userId) : null,
    ].filter((c) => c !== null);
    if (!conditions.length) return null;
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(or(...conditions))
      .limit(5);
    return (
      rows.find((r) => ids.subscriptionId && r.providerSubscriptionId === ids.subscriptionId) ??
      rows.find((r) => ids.customerId && r.providerCustomerId === ids.customerId) ??
      rows.find((r) => ids.userId && r.userId === ids.userId) ??
      null
    );
  }

  private async onSubscription(subscription: StripeObject, event: StripeEvent, now: Date) {
    const metadata = obj(subscription.metadata);
    const customerId = idOf(subscription.customer);
    const row = await this.rowFor({ subscriptionId: subscription.id, customerId, userId: str(metadata.userId) });
    let userId = row?.userId ?? null;
    if (!userId && str(metadata.userId)) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, str(metadata.userId) as string))
        .limit(1);
      userId = user?.id ?? null;
    }
    if (!userId) {
      this.logger.warn(`${event.type} for ${subscription.id}: no matching user`);
      return;
    }
    // Events can arrive out of order: never let an older one undo a newer one.
    const lastEventAt = num(row?.metadata?.stripeEventAt);
    if (lastEventAt !== null && event.created < lastEventAt) return;

    const item = obj((obj(subscription.items).data as unknown[] | undefined)?.[0]);
    const price = obj(item.price);
    const plan = planOf(metadata.plan) ?? row?.plan ?? null;
    const interval = intervalOf(obj(price.recurring).interval) ?? intervalOf(metadata.interval) ?? row?.interval ?? null;
    const periodStart = fromUnix(subscription.current_period_start ?? item.current_period_start);
    const periodEnd = fromUnix(subscription.current_period_end ?? item.current_period_end);
    const stripeStatus = str(subscription.status);

    if (event.type === "customer.subscription.deleted") {
      await this.payments.upsertSubscription(userId, {
        ...(plan ? { plan } : {}),
        status: "canceled",
        provider: "stripe",
        providerCustomerId: customerId ?? row?.providerCustomerId ?? null,
        providerSubscriptionId: subscription.id,
        currentPeriodEnd: fromUnix(subscription.ended_at) ?? periodEnd ?? now,
        cancelAtPeriodEnd: false,
        canceledAt: fromUnix(subscription.canceled_at) ?? now,
        metadataPatch: { stripeEventAt: event.created },
      });
      return;
    }
    // Not paid yet: remember the ids, change nothing else.
    if (stripeStatus === "incomplete") {
      await this.payments.upsertSubscription(
        userId,
        row
          ? { providerCustomerId: customerId ?? row.providerCustomerId, metadataPatch: { stripeEventAt: event.created } }
          : { plan: "free", status: "active", providerCustomerId: customerId, metadataPatch: { stripeEventAt: event.created } },
      );
      return;
    }
    const status: BillingStatus =
      stripeStatus === "active"
        ? "active"
        : stripeStatus === "trialing"
          ? "trialing"
          : stripeStatus === "past_due" || stripeStatus === "unpaid"
            ? "past_due"
            : stripeStatus === "canceled" || stripeStatus === "incomplete_expired" || stripeStatus === "paused"
              ? "canceled"
              : "active";
    await this.payments.upsertSubscription(userId, {
      ...(plan ? { plan } : {}),
      status,
      provider: "stripe",
      interval,
      providerCustomerId: customerId ?? row?.providerCustomerId ?? null,
      providerSubscriptionId: subscription.id,
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      trialEndsAt: status === "trialing" ? fromUnix(subscription.trial_end) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      canceledAt:
        status === "canceled" ? (fromUnix(subscription.canceled_at) ?? now) : subscription.cancel_at_period_end === true ? (row?.canceledAt ?? now) : null,
      metadataPatch: {
        stripeEventAt: event.created,
        pastDueAt: status === "past_due" ? (str(row?.metadata?.pastDueAt) ?? now.toISOString()) : undefined,
      },
    });
  }

  private invoiceIds(invoice: StripeObject) {
    const parent = obj(obj(invoice.parent).subscription_details);
    const legacy = obj(invoice.subscription_details);
    return {
      subscriptionId: idOf(invoice.subscription) ?? idOf(parent.subscription),
      customerId: idOf(invoice.customer),
      userId: str(obj(parent.metadata).userId) ?? str(obj(legacy.metadata).userId),
    };
  }

  private async onInvoicePaid(invoice: StripeObject, now: Date) {
    const ids = this.invoiceIds(invoice);
    if (!ids.subscriptionId) return;
    const row = await this.rowFor(ids);
    if (!row) return;
    const line = obj((obj(invoice.lines).data as unknown[] | undefined)?.[0]);
    const period = obj(line.period);
    const periodStart = fromUnix(period.start);
    const periodEnd = fromUnix(period.end);
    const receiptUrl = str(invoice.hosted_invoice_url);

    if (invoice.billing_reason === "subscription_create") {
      // The first payment is recorded from its checkout session; add the invoice link to it.
      if (receiptUrl) {
        await db
          .update(billingPayments)
          .set({ receiptUrl, updatedAt: new Date() })
          .where(and(eq(billingPayments.provider, "stripe"), eq(billingPayments.providerPaymentId, invoice.id)));
      }
    } else {
      const amount = num(invoice.amount_paid) ?? 0;
      if (amount > 0) {
        const payment = await this.payments.create({
          userId: row.userId,
          provider: "stripe",
          providerRef: invoice.id,
          providerPaymentId: idOf(invoice.payment_intent) ?? idOf(invoice.charge),
          purpose: "plan",
          plan: row.plan,
          interval: row.interval,
          amount,
          currency: str(invoice.currency) ?? "usd",
          status: "paid",
          paidAt: fromUnix(obj(invoice.status_transitions).paid_at) ?? now,
          receiptUrl,
          metadata: { billingReason: str(invoice.billing_reason) },
        });
        if (payment) await this.payments.sendReceipt(payment);
      }
    }
    const extend = periodEnd && (!row.currentPeriodEnd || periodEnd > row.currentPeriodEnd);
    await this.payments.upsertSubscription(row.userId, {
      status: row.status === "canceled" && !row.cancelAtPeriodEnd ? row.status : "active",
      providerSubscriptionId: ids.subscriptionId,
      ...(extend ? { currentPeriodEnd: periodEnd, ...(periodStart ? { currentPeriodStart: periodStart } : {}) } : {}),
      metadataPatch: { pastDueAt: undefined, failedInvoiceNotified: undefined },
    });
  }

  private async onInvoiceFailed(config: BillingConfig, invoice: StripeObject, now: Date) {
    const ids = this.invoiceIds(invoice);
    const row = await this.rowFor(ids);
    if (!row) return;
    const alreadyNotified = row.metadata?.failedInvoiceNotified === invoice.id;
    await this.payments.upsertSubscription(row.userId, {
      status: "past_due",
      metadataPatch: { pastDueAt: str(row.metadata?.pastDueAt) ?? now.toISOString(), failedInvoiceNotified: invoice.id },
    });
    if (alreadyNotified) return;
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user) return;
    const planName = config.plans[row.plan]?.name ?? row.plan;
    await sendEmail({
      to: user.email,
      subject: "Your payment didn't go through",
      heading: "We couldn't take your payment",
      paragraphs: [
        `The renewal of your ${planName} plan failed. Your plan keeps working for 7 more days while you update your card.`,
        "Stripe will try again automatically; you can also update your payment method now.",
      ],
      action: { label: "Update payment method", url: appLink("/settings/billing") },
      footnote: `Sent by ${new URL(env.APP_URL).host} because a payment for your plan failed.`,
    });
  }
}
