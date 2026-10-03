import {
  type AdminBillingPayment,
  type AdminBillingSummary,
  type AdminBillingUser,
  type AdminCreditsInput,
  type AdminPlanInput,
  adminBillingPaymentsQuery,
  adminCreditsWithPaymentInput,
  adminPlanWithPaymentInput,
  type BillingConfigInput,
  type BillingConfigView,
  type BillingTestInput,
  type BillingTestResult,
  billingConfigInput,
  billingTestInput,
  DEFAULT_CREDIT_PACKS,
  DEFAULT_PLAN_PRICES,
  DEFAULT_PLANS,
  PLAN_IDS,
  type PlanId,
  type PlanLimits,
  STRIPE_WEBHOOK_EVENTS,
} from "@financeos/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { SessionUser } from "../../common/context.js";
import { conflict, notFound } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { billingPayments, billingSubscriptions, creditTransactions, users, workspaceMembers } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { maskSecret } from "../integrations/crypto.js";
import { PlatformAuditService } from "../system/platform-audit.service.js";
import { encryptBillingSecret, loadBillingConfig, readyProviders, type StoredBillingConfig, saveBillingConfig } from "./billing-config.js";
import { CreditsService } from "./credits.service.js";
import { EntitlementsService } from "./entitlements.service.js";
import { PaymentsService, paymentView } from "./payments.service.js";
import { SSLCOMMERZ_CALLBACKS, SslcommerzService } from "./sslcommerz.service.js";
import { StripeService } from "./stripe.service.js";

type Actor = Pick<SessionUser, "id" | "email"> & { ip?: string | null };

const origin = () => env.APP_URL.replace(/\/$/, "");
const secretView = (value: string | null) => ({ set: Boolean(value), masked: value ? maskSecret(value) : null });

/** A secret field from the form: omitted keeps what is saved, "" removes it. */
function nextSecret(input: string | undefined, saved: string | null): string | null {
  if (input === undefined) return saved;
  return input ? encryptBillingSecret(input) : null;
}

/**
 * Admin → Billing: whether the installation charges at all, plans and their
 * limits and prices, credit packs, payment providers (secrets encrypted,
 * never returned), and the people paying. Every change is platform-audited.
 */
@Injectable()
export class BillingAdminService {
  constructor(
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(CreditsService) private readonly credits: CreditsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(StripeService) private readonly stripe: StripeService,
    @Inject(SslcommerzService) private readonly sslcommerz: SslcommerzService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  async view(): Promise<BillingConfigView> {
    const config = await loadBillingConfig({ fresh: true });
    const ready = readyProviders(config);
    let updatedBy: string | null = null;
    if (config.updatedBy) {
      const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, config.updatedBy));
      updatedBy = user ? user.name || user.email : null;
    }
    return {
      enabled: config.enabled,
      creditsPerUsd: config.creditsPerUsd,
      trial: config.trial,
      plans: Object.fromEntries(
        PLAN_IDS.map((id) => [id, { name: config.plans[id].name, limits: config.plans[id].limits, prices: config.plans[id].prices }]),
      ) as BillingConfigView["plans"],
      defaults: {
        plans: Object.fromEntries(PLAN_IDS.map((id) => [id, DEFAULT_PLANS[id].limits])) as Record<PlanId, PlanLimits>,
        prices: DEFAULT_PLAN_PRICES,
        creditPacks: DEFAULT_CREDIT_PACKS,
      },
      creditPacks: config.creditPacks,
      providers: {
        stripe: {
          enabled: config.stripe.enabled,
          ready: ready.stripe && Boolean(config.stripe.webhookSecret),
          secretKey: secretView(config.stripe.secretKey),
          webhookSecret: secretView(config.stripe.webhookSecret),
          webhookUrl: `${origin()}/api/billing/webhooks/stripe`,
          events: [...STRIPE_WEBHOOK_EVENTS],
        },
        sslcommerz: {
          enabled: config.sslcommerz.enabled,
          ready: ready.sslcommerz,
          storeId: config.sslcommerz.storeId,
          storePassword: secretView(config.sslcommerz.storePassword),
          sandbox: config.sslcommerz.sandbox,
          ipnUrl: `${origin()}${SSLCOMMERZ_CALLBACKS.ipn}`,
        },
        manual: { enabled: config.manual.enabled, instructions: config.manual.instructions },
      },
      problems: config.problems,
      updatedAt: config.updatedAt?.toISOString() ?? null,
      updatedBy,
    };
  }

  async update(raw: BillingConfigInput, actor: Actor): Promise<BillingConfigView> {
    const input = billingConfigInput.parse(raw);
    const current = await loadBillingConfig({ fresh: true });
    const saved = current.stored;
    const stored: StoredBillingConfig = {
      enabled: input.enabled,
      creditsPerUsd: input.creditsPerUsd,
      trial: input.trial,
      plans: input.plans,
      creditPacks: input.creditPacks,
      providers: {
        stripe: {
          enabled: input.providers.stripe.enabled,
          secretKeyEncrypted: nextSecret(input.providers.stripe.secretKey, saved?.providers.stripe.secretKeyEncrypted ?? null),
          webhookSecretEncrypted: nextSecret(input.providers.stripe.webhookSecret, saved?.providers.stripe.webhookSecretEncrypted ?? null),
        },
        sslcommerz: {
          enabled: input.providers.sslcommerz.enabled,
          storeId: input.providers.sslcommerz.storeId || null,
          storePasswordEncrypted: nextSecret(input.providers.sslcommerz.storePassword, saved?.providers.sslcommerz.storePasswordEncrypted ?? null),
          sandbox: input.providers.sslcommerz.sandbox,
        },
        manual: { enabled: input.providers.manual.enabled, instructions: input.providers.manual.instructions || null },
      },
    };
    const packIds = new Set<string>();
    for (const pack of stored.creditPacks) {
      if (packIds.has(pack.id)) throw conflict(`Two credit packs are called "${pack.id}"`, "duplicate_pack");
      packIds.add(pack.id);
    }
    await saveBillingConfig(stored, actor.id);
    const secretsChanged = [
      input.providers.stripe.secretKey !== undefined ? "stripe.secretKey" : null,
      input.providers.stripe.webhookSecret !== undefined ? "stripe.webhookSecret" : null,
      input.providers.sslcommerz.storePassword !== undefined ? "sslcommerz.storePassword" : null,
    ].filter(Boolean);
    await this.audit.record({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "billing.config_updated",
      targetType: "billing",
      targetId: "billing",
      ip: actor.ip ?? null,
      details: {
        before: saved ? { enabled: saved.enabled, creditsPerUsd: saved.creditsPerUsd, trial: saved.trial } : null,
        after: { enabled: stored.enabled, creditsPerUsd: stored.creditsPerUsd, trial: stored.trial },
        providers: { stripe: stored.providers.stripe.enabled, sslcommerz: stored.providers.sslcommerz.enabled, manual: stored.providers.manual.enabled },
        secretsChanged,
      },
    });
    return this.view();
  }

  async test(raw: BillingTestInput): Promise<BillingTestResult> {
    const input = billingTestInput.parse(raw);
    const config = await loadBillingConfig({ fresh: true });
    if (input.provider === "stripe") {
      if (!config.stripe.secretKey) return { ok: false, message: "Save a Stripe secret key first" };
      const result = await this.stripe.test(config.stripe.secretKey);
      if (result.ok && !config.stripe.webhookSecret)
        return { ok: true, message: `${result.message}. Add the webhook signing secret so payments are recorded.` };
      return result;
    }
    if (!config.sslcommerz.storeId || !config.sslcommerz.storePassword) return { ok: false, message: "Save the SSLCommerz store ID and password first" };
    return this.sslcommerz.test(config);
  }

  // ----------------------------------------------------------------- users

  async users(query: { q?: string }): Promise<AdminBillingUser[]> {
    const config = await loadBillingConfig();
    const q = query.q?.trim();
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(q ? or(ilike(users.email, `%${q}%`), ilike(users.name, `%${q}%`)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(50);
    const ids = rows.map((r) => r.id);
    const owned = ids.length
      ? await db
          .select({ userId: workspaceMembers.userId, value: sql<number>`count(*)::int` })
          .from(workspaceMembers)
          .where(and(inArray(workspaceMembers.userId, ids), eq(workspaceMembers.role, "owner")))
          .groupBy(workspaceMembers.userId)
      : [];
    const ownedBy = new Map(owned.map((o) => [o.userId, o.value]));
    return Promise.all(
      rows.map(async (user): Promise<AdminBillingUser> => {
        const resolved = config.enabled ? await this.entitlements.resolve(user.id, new Date(), config) : null;
        const row = resolved?.row ?? (await this.payments.subscriptionOf(user.id));
        const credits = resolved ? await this.credits.summary(user.id, resolved) : null;
        const plan = resolved && resolved.plan !== "unlimited" ? resolved.plan : (row?.plan ?? "free");
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt.toISOString(),
          plan,
          status: resolved?.status ?? row?.status ?? "active",
          provider: row?.provider ?? null,
          currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
          trialEndsAt: row?.trialEndsAt?.toISOString() ?? null,
          cancelAtPeriodEnd: Boolean(row?.cancelAtPeriodEnd),
          workspacesOwned: ownedBy.get(user.id) ?? 0,
          credits: credits ? { remainingAllowance: credits.remainingAllowance, balance: credits.balance } : null,
        };
      }),
    );
  }

  private async requireUser(userId: string) {
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw notFound("User");
    return user;
  }

  /** Puts a user on a plan: a manual payment, a gift, a correction. */
  async setPlan(userId: string, raw: AdminPlanInput, actor: Actor) {
    const input = adminPlanWithPaymentInput.parse(raw);
    const user = await this.requireUser(userId);
    const before = await this.payments.subscriptionOf(userId);
    const periodEnd = input.periodEnd ? new Date(input.periodEnd) : null;
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      let paymentId: string | null = null;
      if (input.payment) {
        const payment = await this.payments.create(
          {
            userId,
            provider: "manual",
            providerRef: input.payment.reference,
            purpose: "plan",
            plan: input.plan,
            interval: input.interval ?? null,
            amount: input.payment.amount,
            currency: input.payment.currency,
            status: "paid",
            paidAt: now,
            metadata: { note: input.note ?? null, recordedBy: actor.email },
          },
          tx,
        );
        if (!payment) throw conflict("A manual payment with this reference is already recorded", "duplicate_reference");
        paymentId = payment.id;
      }
      const row = await this.payments.upsertSubscription(
        userId,
        {
          plan: input.plan,
          status: input.status,
          provider: input.plan === "free" ? null : "manual",
          interval: input.interval ?? null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          trialEndsAt: input.status === "trialing" ? periodEnd : null,
          cancelAtPeriodEnd: false,
          canceledAt: input.status === "canceled" ? now : null,
          providerSubscriptionId: null,
          metadataPatch: { pastDueAt: undefined, expiringNotifiedFor: undefined, trialEndingNotified: undefined, note: input.note ?? undefined },
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          action: "billing.plan_set",
          targetType: "user",
          targetId: userId,
          ip: actor.ip ?? null,
          details: {
            email: user.email,
            before: before ? { plan: before.plan, status: before.status, currentPeriodEnd: before.currentPeriodEnd?.toISOString() ?? null } : null,
            after: { plan: row.plan, status: row.status, currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null },
            paymentId,
            payment: input.payment ?? null,
            note: input.note ?? null,
          },
        },
        tx,
      );
      return { row, paymentId };
    });
    if (result.paymentId) {
      const payment = await this.payments.byId(result.paymentId);
      if (payment) await this.payments.sendReceipt(payment);
    }
    return { userId, plan: result.row.plan, status: result.row.status, currentPeriodEnd: result.row.currentPeriodEnd?.toISOString() ?? null };
  }

  /** Adds (or removes) balance credits, optionally with the payment they were bought with. */
  async addCredits(userId: string, raw: AdminCreditsInput, actor: Actor) {
    const input = adminCreditsWithPaymentInput.parse(raw);
    const user = await this.requireUser(userId);
    const paymentId = await db.transaction(async (tx) => {
      let paymentId: string | null = null;
      if (input.payment) {
        const payment = await this.payments.create(
          {
            userId,
            provider: "manual",
            providerRef: input.payment.reference,
            purpose: "credits",
            credits: input.credits,
            amount: input.payment.amount,
            currency: input.payment.currency,
            status: "paid",
            paidAt: new Date(),
            metadata: { note: input.note, recordedBy: actor.email },
          },
          tx,
        );
        if (!payment) throw conflict("A manual payment with this reference is already recorded", "duplicate_reference");
        paymentId = payment.id;
      }
      await this.credits.grant(
        {
          userId,
          credits: input.credits,
          kind: paymentId ? "purchase" : input.credits > 0 ? "grant" : "adjustment",
          paymentId,
          note: input.note,
          createdBy: actor.id,
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          action: "billing.credits_added",
          targetType: "user",
          targetId: userId,
          ip: actor.ip ?? null,
          details: { email: user.email, credits: input.credits, note: input.note, paymentId, payment: input.payment ?? null },
        },
        tx,
      );
      return paymentId;
    });
    if (paymentId) {
      const payment = await this.payments.byId(paymentId);
      if (payment) await this.payments.sendReceipt(payment);
    }
    const summary = await this.credits.summary(userId);
    return { userId, credits: summary };
  }

  async paymentsList(raw: z.input<typeof adminBillingPaymentsQuery>): Promise<AdminBillingPayment[]> {
    const query = adminBillingPaymentsQuery.parse(raw);
    const rows = await db
      .select({ payment: billingPayments, email: users.email, name: users.name })
      .from(billingPayments)
      .leftJoin(users, eq(users.id, billingPayments.userId))
      .where(
        and(
          query.status ? eq(billingPayments.status, query.status) : undefined,
          query.provider ? eq(billingPayments.provider, query.provider) : undefined,
          query.userId ? eq(billingPayments.userId, query.userId) : undefined,
        ),
      )
      .orderBy(desc(billingPayments.createdAt))
      .limit(query.limit);
    return rows.map((r) => ({ ...paymentView(r.payment), userId: r.payment.userId, userEmail: r.email, userName: r.name }));
  }

  async summary(): Promise<AdminBillingSummary> {
    const config = await loadBillingConfig();
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const [subs, [usersCount], revenue, credits, lastPaid] = await Promise.all([
      db.select().from(billingSubscriptions),
      db.select({ value: sql<number>`count(*)::int` }).from(users),
      db
        .select({ currency: billingPayments.currency, amount: sql<string>`coalesce(sum(${billingPayments.amount}), 0)`, payments: sql<number>`count(*)::int` })
        .from(billingPayments)
        .where(and(eq(billingPayments.status, "paid"), gte(billingPayments.paidAt, since)))
        .groupBy(billingPayments.currency),
      db
        .select({ kind: creditTransactions.kind, total: sql<string>`coalesce(sum(${creditTransactions.credits}), 0)` })
        .from(creditTransactions)
        .where(gte(creditTransactions.createdAt, since))
        .groupBy(creditTransactions.kind),
      db
        .selectDistinctOn([billingPayments.userId], { userId: billingPayments.userId, currency: billingPayments.currency })
        .from(billingPayments)
        .where(and(eq(billingPayments.status, "paid"), eq(billingPayments.purpose, "plan")))
        .orderBy(billingPayments.userId, desc(billingPayments.paidAt)),
    ]);
    const currencyOf = new Map(lastPaid.map((p) => [p.userId, p.currency]));
    const counts = { free: 0, pro: 0, business: 0, trialing: 0, pastDue: 0 };
    const mrr = new Map<string, number>();
    let onPaidPlans = 0;
    for (const row of subs) {
      const resolved = config.enabled ? await this.entitlements.resolve(row.userId, now, config) : null;
      const plan = resolved && resolved.plan !== "unlimited" ? resolved.plan : row.plan;
      const status = resolved?.status ?? row.status;
      if (plan === "free") continue;
      onPaidPlans += 1;
      if (status === "trialing") {
        counts.trialing += 1;
        continue;
      }
      counts[plan] += 1;
      if (status === "past_due") counts.pastDue += 1;
      const currency = currencyOf.get(row.userId) ?? "USD";
      const interval = row.interval ?? "month";
      const price =
        config.plans[plan].prices.find((p) => p.interval === interval && p.currency === currency) ??
        config.plans[plan].prices.find((p) => p.interval === interval && p.currency === "USD");
      if (!price || status === "canceled") continue;
      const monthly = interval === "year" ? Math.round(price.amount / 12) : price.amount;
      mrr.set(price.currency, (mrr.get(price.currency) ?? 0) + monthly);
    }
    counts.free = Math.max(0, (usersCount?.value ?? 0) - onPaidPlans);
    const byKind = Object.fromEntries(credits.map((c) => [c.kind, Number(c.total)])) as Record<string, number>;
    return {
      enabled: config.enabled,
      subscriptions: counts,
      mrr: [...mrr.entries()].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)),
      revenue30d: revenue
        .map((r) => ({ currency: r.currency, amount: Number(r.amount), payments: r.payments }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      credits30d: { sold: byKind.purchase ?? 0, granted: (byKind.grant ?? 0) + (byKind.adjustment ?? 0), used: Math.abs(byKind.usage ?? 0) },
    };
  }
}
