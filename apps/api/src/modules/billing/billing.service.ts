import { type BillingOverview, type BillingPlansView, type CheckoutInput, checkoutInput, PLAN_IDS, type PlanId, UNLIMITED_LIMITS } from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import type { SessionUser } from "../../common/context.js";
import { badRequest, conflict, unprocessable } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { billingPayments, billingSubscriptions } from "../../db/schema/index.js";
import { type BillingConfig, currenciesOf, loadBillingConfig, priceFor, readyProviders } from "./billing-config.js";
import { CreditsService } from "./credits.service.js";
import { EntitlementsService } from "./entitlements.service.js";
import { PaymentsService, paymentView } from "./payments.service.js";
import { daysUntil } from "./periods.js";
import { SslcommerzService } from "./sslcommerz.service.js";
import { StripeService } from "./stripe.service.js";

/** What the public pricing page and the plan chooser show. */
export function plansView(config: BillingConfig): BillingPlansView {
  return {
    enabled: config.enabled,
    plans: PLAN_IDS.map((id) => config.plans[id]),
    creditPacks: config.creditPacks,
    providers: readyProviders(config),
    currencies: currenciesOf(config),
    trial: config.trial,
    creditsPerUsd: config.creditsPerUsd,
  };
}

/**
 * The signed-in user's side of billing: their plan and usage, checkout for a
 * plan or a credit pack, and managing (or cancelling) what they pay for.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(CreditsService) private readonly credits: CreditsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(StripeService) private readonly stripe: StripeService,
    @Inject(SslcommerzService) private readonly sslcommerz: SslcommerzService,
  ) {}

  async plans(): Promise<BillingPlansView> {
    return plansView(await loadBillingConfig());
  }

  async overview(user: SessionUser): Promise<BillingOverview> {
    const config = await loadBillingConfig();
    const view = plansView(config);
    const [payments, workspacesOwned, storageBytes] = await Promise.all([
      db.select().from(billingPayments).where(eq(billingPayments.userId, user.id)).orderBy(desc(billingPayments.createdAt)).limit(50),
      this.entitlements.workspacesOwned(user.id),
      this.entitlements.storageUsed(user.id),
    ]);
    const common = {
      payments: payments.filter((p) => p.status !== "pending" || Date.now() - p.createdAt.getTime() < 86_400_000).map(paymentView),
      manualInstructions: config.manual.enabled ? config.manual.instructions : null,
      providers: view.providers,
      plans: view.plans,
      creditPacks: view.creditPacks,
      currencies: view.currencies,
    };
    if (!config.enabled) {
      return {
        enabled: false,
        plan: "unlimited",
        planName: "Unlimited",
        status: "active",
        provider: null,
        interval: null,
        trial: { active: false, endsAt: null, daysLeft: null },
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        graceEndsAt: null,
        hasStripeSubscription: false,
        limits: UNLIMITED_LIMITS,
        usage: { workspacesOwned, storageBytes, credits: null },
        ...common,
      };
    }
    const resolved = await this.entitlements.resolve(user.id);
    const credits = await this.credits.summary(user.id, resolved);
    const row = resolved.row;
    const plan = resolved.plan === "unlimited" ? "free" : resolved.plan;
    const onPlan = plan !== "free";
    const trialing = resolved.status === "trialing" && resolved.trialEndsAt !== null;
    return {
      enabled: true,
      plan,
      planName: config.plans[plan].name,
      status: resolved.status,
      provider: onPlan ? (row?.provider ?? null) : null,
      interval: onPlan ? (row?.interval ?? null) : null,
      trial: {
        active: trialing,
        endsAt: resolved.trialEndsAt?.toISOString() ?? null,
        daysLeft: trialing && resolved.trialEndsAt ? daysUntil(resolved.trialEndsAt) : null,
      },
      currentPeriodStart: onPlan ? (row?.currentPeriodStart?.toISOString() ?? null) : null,
      currentPeriodEnd: onPlan ? (row?.currentPeriodEnd?.toISOString() ?? null) : null,
      cancelAtPeriodEnd: onPlan && Boolean(row?.cancelAtPeriodEnd),
      graceEndsAt: resolved.graceEndsAt?.toISOString() ?? null,
      hasStripeSubscription: Boolean(
        row?.provider === "stripe" && row.providerSubscriptionId && row.providerCustomerId?.startsWith("cus_") && view.providers.stripe,
      ),
      limits: resolved.limits,
      usage: { workspacesOwned, storageBytes, credits },
      ...common,
    };
  }

  /** Starts a checkout; returns where to send the browser. */
  async checkout(user: SessionUser, raw: CheckoutInput): Promise<{ url: string }> {
    const input = checkoutInput.parse(raw);
    const config = await loadBillingConfig();
    if (!config.enabled) throw unprocessable("This installation isn't billed; everything is already unlocked", "billing_disabled");
    const ready = readyProviders(config);
    if (!ready[input.provider])
      throw unprocessable(`Paying with ${input.provider === "stripe" ? "card (Stripe)" : "SSLCommerz"} isn't available`, "provider_unavailable");
    const preferred = input.provider === "sslcommerz" ? "BDT" : "USD";
    const payer = { id: user.id, email: user.email, name: user.name };

    if (input.purpose === "plan") {
      const priced = config.plans[input.plan].prices.filter((p) => p.interval === input.interval && p.amount > 0);
      const currency = (input.currency ?? (priced.some((p) => p.currency === preferred) ? preferred : priced[0]?.currency) ?? preferred).toUpperCase();
      const price = priceFor(config, input.plan, input.interval, currency);
      if (!price || price.amount <= 0) {
        throw unprocessable(
          `No ${input.interval === "year" ? "yearly" : "monthly"} price in ${currency} is set for ${config.plans[input.plan].name}`,
          "price_missing",
        );
      }
      const resolved = await this.entitlements.resolve(user.id);
      const row = resolved.row;
      const liveCardSubscription =
        row?.provider === "stripe" &&
        row.providerSubscriptionId &&
        (resolved.status === "active" || resolved.status === "past_due") &&
        resolved.plan !== "free";
      if (liveCardSubscription) {
        throw conflict("You already pay by card. Change or cancel the plan from Manage billing.", "subscription_exists");
      }
      const item = { purpose: "plan" as const, plan: input.plan as PlanId, interval: input.interval, amount: price.amount, currency };
      return input.provider === "stripe" ? this.stripe.checkout(config, payer, item) : this.sslcommerz.checkout(config, payer, item);
    }

    const pack = config.creditPacks.find((p) => p.id === input.packId);
    if (!pack) throw badRequest("That credit pack is no longer offered", "pack_missing");
    const currency = (input.currency ?? (pack.prices.some((p) => p.currency === preferred) ? preferred : pack.prices[0]?.currency) ?? preferred).toUpperCase();
    const price = pack.prices.find((p) => p.currency === currency);
    if (!price) throw unprocessable(`This pack has no price in ${currency}`, "price_missing");
    // Make sure a trial row exists before the first payment, so buying credits never ends a trial.
    await this.entitlements.resolve(user.id);
    const item = { purpose: "credits" as const, packId: pack.id, credits: pack.credits, amount: price.amount, currency };
    return input.provider === "stripe" ? this.stripe.checkout(config, payer, item) : this.sslcommerz.checkout(config, payer, item);
  }

  async portal(user: SessionUser): Promise<{ url: string }> {
    const config = await loadBillingConfig();
    if (!readyProviders(config).stripe) throw unprocessable("Card payments aren't available", "provider_unavailable");
    return this.stripe.portal(config, await this.payments.subscriptionOf(user.id));
  }

  /** Stops renewal: the plan runs to the end of the period already paid for. */
  async cancel(user: SessionUser) {
    return this.setCancel(user, true);
  }

  /**
   * Before an account is deleted: stops a running card subscription at once so
   * a deleted person is never charged again. Prepaid plans (SSLCommerz,
   * manual) simply end with the account. Throws when Stripe can't be reached,
   * so the deletion waits rather than leaving a live subscription behind.
   */
  async closeForDeletion(userId: string) {
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)).limit(1);
    if (row?.provider !== "stripe" || !row.providerSubscriptionId) return { canceled: false };
    if (row.status === "expired" || (row.status === "canceled" && (!row.currentPeriodEnd || row.currentPeriodEnd <= new Date()))) return { canceled: false };
    const config = await loadBillingConfig();
    try {
      await this.stripe.cancelNow(config, row);
    } catch (error) {
      throw unprocessable(
        `Your card subscription couldn't be cancelled (${error instanceof Error ? error.message : "Stripe didn't answer"}). Try again, or cancel it in Plan & billing first.`,
        "subscription_cancel_failed",
      );
    }
    return { canceled: true };
  }

  async resume(user: SessionUser) {
    return this.setCancel(user, false);
  }

  private async setCancel(user: SessionUser, cancel: boolean) {
    const config = await loadBillingConfig();
    if (!config.enabled) throw unprocessable("This installation isn't billed", "billing_disabled");
    const resolved = await this.entitlements.resolve(user.id);
    const row = resolved.row;
    if (!row || resolved.plan === "free" || resolved.plan === "unlimited" || resolved.status === "trialing") {
      throw badRequest("There's no paid plan to change", "no_paid_plan");
    }
    if (row.provider === "stripe" && row.providerSubscriptionId) {
      await this.stripe.setCancelAtPeriodEnd(config, row, cancel);
    } else {
      await this.payments.upsertSubscription(user.id, { cancelAtPeriodEnd: cancel, canceledAt: cancel ? new Date() : null });
    }
    return this.overview(user);
  }
}
