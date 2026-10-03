import {
  type BillingInterval,
  type BillingPaymentView,
  type BillingProvider,
  formatMoney,
  type PaymentPurpose,
  type PaymentStatus,
  type PlanId,
} from "@financeos/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { db, type Executor } from "../../db/index.js";
import { billingPayments, billingSubscriptions, users } from "../../db/schema/index.js";
import { appLink, sendEmail } from "../system/email.service.js";
import { loadBillingConfig } from "./billing-config.js";
import { CreditsService } from "./credits.service.js";
import type { SubscriptionRow } from "./entitlements.service.js";
import { addInterval } from "./periods.js";

export type PaymentRow = typeof billingPayments.$inferSelect;
type SubscriptionPatch = Partial<Omit<typeof billingSubscriptions.$inferInsert, "id" | "userId" | "createdAt">>;

export function paymentView(row: PaymentRow): BillingPaymentView {
  return {
    id: row.id,
    provider: row.provider,
    providerRef: row.providerRef,
    purpose: row.purpose,
    plan: row.plan,
    interval: row.interval,
    credits: row.credits,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    paidAt: row.paidAt?.toISOString() ?? null,
    receiptUrl: row.receiptUrl,
    createdAt: row.createdAt.toISOString(),
    note: typeof row.metadata?.note === "string" ? row.metadata.note : null,
  };
}

/** Removes keys set to undefined, so a metadata merge can drop flags. */
function merged(base: Record<string, unknown> | null | undefined, patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...(base ?? {}), ...patch };
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
  return next;
}

/**
 * Money received for the service, whichever way it came: records payments,
 * applies what was paid for (a plan period, a pack of credits) exactly once,
 * and sends the receipt.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger("Payments");

  constructor(@Inject(CreditsService) private readonly credits: CreditsService) {}

  async subscriptionOf(userId: string, exec: Executor = db): Promise<SubscriptionRow | null> {
    const [row] = await exec.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)).limit(1);
    return row ?? null;
  }

  /** Creates or changes a user's subscription row; `metadata` is merged into what is there. */
  async upsertSubscription(userId: string, patch: SubscriptionPatch & { metadataPatch?: Record<string, unknown> }, exec: Executor = db) {
    const { metadataPatch, ...fields } = patch;
    const existing = await this.subscriptionOf(userId, exec);
    const metadata = merged(existing?.metadata, metadataPatch ?? {});
    const [row] = await exec
      .insert(billingSubscriptions)
      .values({ userId, ...fields, metadata })
      .onConflictDoUpdate({ target: billingSubscriptions.userId, set: { ...fields, metadata, updatedAt: new Date() } })
      .returning();
    return row as SubscriptionRow;
  }

  async create(
    input: {
      id?: string;
      userId: string;
      provider: BillingProvider;
      providerRef: string;
      purpose: PaymentPurpose;
      plan?: PlanId | null;
      interval?: BillingInterval | null;
      credits?: number | null;
      amount: number;
      currency: string;
      status?: PaymentStatus;
      paidAt?: Date | null;
      providerPaymentId?: string | null;
      receiptUrl?: string | null;
      metadata?: Record<string, unknown>;
    },
    exec: Executor = db,
  ): Promise<PaymentRow | null> {
    const [row] = await exec
      .insert(billingPayments)
      .values({
        ...(input.id ? { id: input.id } : {}),
        userId: input.userId,
        provider: input.provider,
        providerRef: input.providerRef,
        providerPaymentId: input.providerPaymentId ?? null,
        purpose: input.purpose,
        plan: input.plan ?? null,
        interval: input.interval ?? null,
        credits: input.credits ?? null,
        amount: input.amount,
        currency: input.currency.toUpperCase(),
        status: input.status ?? "pending",
        paidAt: input.paidAt ?? null,
        receiptUrl: input.receiptUrl ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async byId(id: string): Promise<PaymentRow | null> {
    const [row] = await db.select().from(billingPayments).where(eq(billingPayments.id, id)).limit(1);
    return row ?? null;
  }

  async byRef(provider: BillingProvider, providerRef: string): Promise<PaymentRow | null> {
    const [row] = await db
      .select()
      .from(billingPayments)
      .where(and(eq(billingPayments.provider, provider), eq(billingPayments.providerRef, providerRef)))
      .limit(1);
    return row ?? null;
  }

  /** A pending payment that did not go through. Paid payments are never downgraded. */
  async markUnpaid(id: string, status: "failed" | "canceled", metadataPatch: Record<string, unknown> = {}) {
    const payment = await this.byId(id);
    if (!payment || payment.status === "paid") return payment;
    const [row] = await db
      .update(billingPayments)
      .set({ status, metadata: merged(payment.metadata, metadataPatch), updatedAt: new Date() })
      .where(and(eq(billingPayments.id, id), ne(billingPayments.status, "paid")))
      .returning();
    return row ?? payment;
  }

  /**
   * Marks a payment paid and applies it — once. A repeated webhook or callback
   * finds it already paid and changes nothing. Credits are granted here; a
   * prepaid plan period (SSLCommerz, manual) is extended here; a Stripe plan
   * is activated by the caller from the subscription it belongs to.
   */
  async markPaid(
    id: string,
    details: { providerPaymentId?: string | null; receiptUrl?: string | null; paidAt?: Date; amount?: number; metadata?: Record<string, unknown> } = {},
  ): Promise<{ payment: PaymentRow | null; applied: boolean }> {
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(billingPayments).where(eq(billingPayments.id, id)).for("update");
      if (!current) return { payment: null, applied: false };
      if (current.status === "paid") return { payment: current, applied: false };
      const [payment] = await tx
        .update(billingPayments)
        .set({
          status: "paid",
          paidAt: details.paidAt ?? new Date(),
          providerPaymentId: details.providerPaymentId ?? current.providerPaymentId,
          receiptUrl: details.receiptUrl ?? current.receiptUrl,
          ...(details.amount !== undefined ? { amount: details.amount } : {}),
          metadata: merged(current.metadata, details.metadata ?? {}),
          updatedAt: new Date(),
        })
        .where(eq(billingPayments.id, id))
        .returning();
      const paid = payment as PaymentRow;
      if (paid.purpose === "credits" && paid.credits) {
        await this.credits.grant(
          { userId: paid.userId, credits: paid.credits, kind: "purchase", paymentId: paid.id, note: `Bought ${paid.credits} credits` },
          tx,
        );
      }
      if (paid.purpose === "plan" && paid.plan && paid.provider !== "stripe") {
        await this.extendPrepaid(paid.userId, paid.plan, paid.interval ?? "month", paid.provider, tx);
      }
      return { payment: paid, applied: true };
    });
    if (outcome.applied && outcome.payment) await this.sendReceipt(outcome.payment);
    return outcome;
  }

  /**
   * One more month or year on a prepaid plan: from the end of the period
   * already paid for when it is the same plan and still running, else from now.
   */
  async extendPrepaid(userId: string, plan: PlanId, interval: BillingInterval, provider: BillingProvider, exec: Executor = db, now = new Date()) {
    const row = await this.subscriptionOf(userId, exec);
    const running = row && row.plan === plan && row.status === "active" && row.currentPeriodEnd && row.currentPeriodEnd > now;
    const from = running && row.currentPeriodEnd ? row.currentPeriodEnd : now;
    return this.upsertSubscription(
      userId,
      {
        plan,
        status: "active",
        provider,
        interval,
        currentPeriodStart: running && row.currentPeriodStart ? row.currentPeriodStart : now,
        currentPeriodEnd: addInterval(from, interval),
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        providerSubscriptionId: null,
        metadataPatch: { pastDueAt: undefined, expiringNotifiedFor: undefined },
      },
      exec,
    );
  }

  async sendReceipt(payment: PaymentRow) {
    try {
      const [user] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, payment.userId)).limit(1);
      if (!user) return;
      const config = await loadBillingConfig();
      const what =
        payment.purpose === "credits"
          ? `${(payment.credits ?? 0).toLocaleString("en-US")} AI credits`
          : `${config.plans[payment.plan ?? "pro"]?.name ?? payment.plan} plan${payment.interval ? ` (${payment.interval === "year" ? "yearly" : "monthly"})` : ""}`;
      await sendEmail({
        to: user.email,
        subject: `Receipt: ${what}`,
        preview: `Thanks for your payment of ${formatMoney(payment.amount, payment.currency)}.`,
        heading: "Thanks — payment received",
        paragraphs: [
          payment.purpose === "credits" ? `Your ${what} are in your balance and never expire.` : `Your ${what} is active. It covers every workspace you own.`,
        ],
        details: [
          { label: "Item", value: what },
          { label: "Amount", value: formatMoney(payment.amount, payment.currency) },
          { label: "Paid", value: (payment.paidAt ?? new Date()).toISOString().slice(0, 10) },
          { label: "Reference", value: payment.providerRef },
        ],
        action: payment.receiptUrl ? { label: "View receipt", url: payment.receiptUrl } : { label: "Plan & billing", url: appLink("/settings/billing") },
        footnote: "Keep this email for your records.",
      });
    } catch (error) {
      this.logger.warn(`Receipt for payment ${payment.id} not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
