import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, gt, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { billingSubscriptions, creditTransactions, users } from "../../db/schema/index.js";
import { SchedulerService } from "../jobs/scheduler.service.js";
import { appLink, sendEmail } from "../system/email.service.js";
import { JobsService } from "../system/jobs.service.js";
import { loadBillingConfig } from "./billing-config.js";
import { CreditsService } from "./credits.service.js";
import { EntitlementsService } from "./entitlements.service.js";
import { PaymentsService } from "./payments.service.js";
import { addDays, daysUntil } from "./periods.js";

export const BILLING_DAILY_JOB = "billing.daily";

/**
 * The daily billing reminders: trials ending in 3 days, prepaid plans
 * (SSLCommerz, manual) ending in 5 days, and AI credits running low. Each is
 * sent once, remembered in the subscription's metadata.
 */
@Injectable()
export class BillingJobs implements OnModuleInit {
  private readonly logger = new Logger("BillingJobs");

  constructor(
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(CreditsService) private readonly credits: CreditsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  onModuleInit() {
    this.jobs.register(BILLING_DAILY_JOB, () => this.runDaily());
    this.scheduler.register(BILLING_DAILY_JOB, "0 8 * * *", "Billing reminders: trials and prepaid plans ending, AI credits running low", () =>
      this.jobs.enqueue(BILLING_DAILY_JOB, {}, { dedupeKey: `${BILLING_DAILY_JOB}:${new Date().toISOString().slice(0, 10)}`, maxAttempts: 2 }),
    );
  }

  async runDaily(now = new Date()) {
    const config = await loadBillingConfig({ fresh: true });
    if (!config.enabled) return { skipped: true };
    const trials = await this.trialsEnding(now);
    const prepaid = await this.prepaidEnding(now);
    const lowCredits = await this.creditsLow(now);
    this.logger.log(`Billing reminders: ${trials} trial, ${prepaid} renewal, ${lowCredits} low-credit emails`);
    return { trials, prepaid, lowCredits };
  }

  private async emailOf(userId: string) {
    const [user] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    return user ?? null;
  }

  async trialsEnding(now: Date): Promise<number> {
    const config = await loadBillingConfig();
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(
        and(eq(billingSubscriptions.status, "trialing"), gt(billingSubscriptions.trialEndsAt, now), lte(billingSubscriptions.trialEndsAt, addDays(now, 3))),
      );
    let sent = 0;
    for (const row of rows) {
      if (row.metadata?.trialEndingNotified === true || !row.trialEndsAt) continue;
      const user = await this.emailOf(row.userId);
      if (!user) continue;
      const days = daysUntil(row.trialEndsAt, now);
      const planName = config.plans[row.plan]?.name ?? row.plan;
      await sendEmail({
        to: user.email,
        subject: `Your ${planName} trial ends in ${days} day${days === 1 ? "" : "s"}`,
        heading: `${days} day${days === 1 ? "" : "s"} left on your ${planName} trial`,
        paragraphs: [
          `After ${row.trialEndsAt.toISOString().slice(0, 10)} your account moves to the Free plan. Nothing is deleted, but Free has lower limits on workspaces, people, storage and AI credits.`,
          `Choose a plan to keep everything in ${planName}.`,
        ],
        action: { label: "Choose a plan", url: appLink("/settings/billing") },
      });
      await this.payments.upsertSubscription(row.userId, { metadataPatch: { trialEndingNotified: true } });
      sent += 1;
    }
    return sent;
  }

  async prepaidEnding(now: Date): Promise<number> {
    const config = await loadBillingConfig();
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.status, "active"),
          inArray(billingSubscriptions.provider, ["sslcommerz", "manual"]),
          isNotNull(billingSubscriptions.currentPeriodEnd),
          gt(billingSubscriptions.currentPeriodEnd, now),
          lte(billingSubscriptions.currentPeriodEnd, addDays(now, 5)),
        ),
      );
    let sent = 0;
    for (const row of rows) {
      const end = row.currentPeriodEnd;
      if (!end || row.plan === "free" || row.metadata?.expiringNotifiedFor === end.toISOString()) continue;
      const user = await this.emailOf(row.userId);
      if (!user) continue;
      const planName = config.plans[row.plan]?.name ?? row.plan;
      const days = daysUntil(end, now);
      await sendEmail({
        to: user.email,
        subject: `Your ${planName} plan ends in ${days} day${days === 1 ? "" : "s"}`,
        heading: `Renew ${planName} before ${end.toISOString().slice(0, 10)}`,
        paragraphs: [
          row.cancelAtPeriodEnd
            ? `You chose not to renew. After ${end.toISOString().slice(0, 10)} your account moves to the Free plan.`
            : `Your prepaid ${planName} period ends on ${end.toISOString().slice(0, 10)}. Pay for another month or year to keep it; a new payment adds to the time you have left.`,
        ],
        action: { label: "Renew now", url: appLink("/settings/billing") },
      });
      await this.payments.upsertSubscription(row.userId, { metadataPatch: { expiringNotifiedFor: end.toISOString() } });
      sent += 1;
    }
    return sent;
  }

  /** People who used AI in the last month and have under 10% of their allowance left (balance included). */
  async creditsLow(now: Date): Promise<number> {
    const recent = await db
      .selectDistinct({ userId: creditTransactions.userId })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.kind, "usage"), gte(creditTransactions.createdAt, addDays(now, -35))));
    let sent = 0;
    for (const { userId } of recent) {
      const resolved = await this.entitlements.resolve(userId, now);
      if (!resolved.billingEnabled) continue;
      const summary = await this.credits.summary(userId, resolved, now);
      if (summary.allowance <= 0) continue;
      const remaining = summary.remainingAllowance + Math.max(0, summary.balance);
      if (remaining >= summary.allowance * 0.1) continue;
      const row = await this.payments.subscriptionOf(userId);
      if (row?.metadata?.lowCreditsNotifiedFor === summary.periodStart) continue;
      const user = await this.emailOf(userId);
      if (!user) continue;
      await sendEmail({
        to: user.email,
        subject: remaining > 0 ? "Your AI credits are running low" : "Your AI credits are used up",
        heading: remaining > 0 ? `${remaining.toLocaleString("en-US")} AI credits left` : "You're out of AI credits",
        paragraphs: [
          `Your plan includes ${summary.allowance.toLocaleString("en-US")} AI credits a month; they renew on ${summary.periodEnd.slice(0, 10)}.`,
          "Until then, reading receipts, suggestions and the AI copilot pause when the credits run out; everything else keeps working. Buy a credit pack (it never expires) or upgrade your plan to keep using AI.",
        ],
        action: { label: "Get more credits", url: appLink("/settings/billing") },
      });
      if (row) await this.payments.upsertSubscription(userId, { metadataPatch: { lowCreditsNotifiedFor: summary.periodStart } });
      else await this.payments.upsertSubscription(userId, { plan: "free", status: "active", metadataPatch: { lowCreditsNotifiedFor: summary.periodStart } });
      sent += 1;
    }
    return sent;
  }
}
