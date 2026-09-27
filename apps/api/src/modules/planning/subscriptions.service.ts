import {
  addDays,
  annualized,
  type Day,
  deriveSubscriptionStatus,
  diffDays,
  dueDatesBetween,
  endOfMonth,
  maxDay,
  monthlyEquivalent,
  nextDueOnOrAfter,
  type Schedule,
  SUBSCRIPTION_STATUS_LABELS,
  type SubscriptionInput,
  type SubscriptionStatus,
  subscriptionInput,
  subscriptionUpdate,
  uuidv7,
} from "@expensewise/core";
import {
  BILLING_CYCLES,
  type BillingCycle,
  type SubscriptionCancelInput,
  type SubscriptionQuery,
  subscriptionCancelInput,
  subscriptionQuery,
} from "@expensewise/core/contracts/planning-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, ne, or, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { categories, commitmentOccurrences, commitments, files, financialAccounts, projects, subscriptions } from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { type TransactionRow, TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { type CommitmentChanges, type CommitmentStatus, CommitmentsService, frequencyLabel, occurrenceStats, projectDueDates } from "./commitments.service.js";
import { BaseConverter, type CommitmentRow, links, type OccurrenceRow, runIn, type SubscriptionRow, scheduleOf, Totals } from "./planning.shared.js";

export type { SubscriptionRow } from "./planning.shared.js";

/** Subscriptions that will keep costing money. */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>(["trial", "active", "renewal_due", "renewed"]);

export function defaultSubscriptionName(provider: string, planName?: string | null): string {
  return `${provider}${planName ? ` ${planName}` : ""}`;
}

/**
 * The schedule anchor. The subscription's start date when its cycle lands on
 * the next renewal date; otherwise the renewal date itself (trials, plans
 * whose billing day moved), so every following renewal falls on the right day.
 */
function anchorStart(input: {
  billingCycle: BillingCycle;
  intervalCount: number;
  intervalUnit?: CommitmentRow["intervalUnit"];
  startDate: Day;
  nextRenewalDate: Day;
}): Day {
  if (input.startDate > input.nextRenewalDate) return input.nextRenewalDate;
  const schedule = {
    frequency: input.billingCycle,
    intervalCount: input.intervalCount,
    intervalUnit: input.billingCycle === "custom" ? (input.intervalUnit ?? "month") : (input.intervalUnit ?? null),
    startDate: input.startDate,
  };
  return nextDueOnOrAfter(schedule, input.nextRenewalDate) === input.nextRenewalDate ? input.startDate : input.nextRenewalDate;
}

function commitmentStatusFor(status: SubscriptionStatus): CommitmentStatus {
  if (status === "paused") return "paused";
  if (status === "cancelled" || status === "cancellation_pending" || status === "expired") return "ended";
  return "active";
}

/**
 * The status a subscription shows today. Time-driven states follow the dates
 * (core `deriveSubscriptionStatus`); an expired subscription whose schedule
 * has ended stays expired.
 */
export function currentSubscriptionStatus(
  subscription: SubscriptionRow,
  commitment: Pick<CommitmentRow, "status" | "nextDueDate" | "name">,
  today: Day,
): SubscriptionStatus {
  if (subscription.status === "expired" && commitment.status !== "active") return "expired";
  return deriveSubscriptionStatus(
    {
      name: commitment.name,
      status: subscription.status,
      autoRenew: subscription.autoRenew,
      nextRenewalDate: commitment.status === "active" ? commitment.nextDueDate : null,
      expiryDate: subscription.expiryDate,
      cancellationDeadline: subscription.cancellationDeadline,
      trialEndsOn: subscription.trialEndsOn,
    },
    today,
  );
}

type JoinedSubscription = {
  subscription: SubscriptionRow;
  commitment: CommitmentRow;
  accountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectName: string | null;
  projectColor: string | null;
};

export type SubscriptionView = SubscriptionRow & {
  name: string;
  /** Stored status as last persisted; `derivedStatus` is what it is today. */
  derivedStatus: SubscriptionStatus;
  statusLabel: string;
  commitmentStatus: CommitmentStatus;
  amount: number;
  currency: string;
  billingCycle: BillingCycle;
  billingLabel: string;
  intervalCount: number;
  intervalUnit: CommitmentRow["intervalUnit"];
  nextRenewalDate: Day | null;
  daysUntilRenewal: number | null;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  reminderOffsets: number[] | null;
  baseCurrency: string;
  baseAmount: number | null;
  monthlyEquivalent: number;
  monthlyEquivalentBase: number | null;
  annualCost: number;
  annualCostBase: number | null;
  nextOccurrenceId: string | null;
  lastPayment: { occurrenceId: string; dueDate: Day; paidOn: Day | null; paidAmount: number | null; currency: string; transactionId: string | null } | null;
  links: { self: string; commitment: string; transactions: string };
};

/**
 * Subscriptions: a commitment (schedule + renewal amount) plus the
 * subscription facts (plan, purchase, expiry, cancellation deadline, status).
 *
 * CONTRACT (the AI capture pipeline depends on this signature — keep it):
 *   create(ctx, input, { exec?, purchaseTransactionId? })
 *     → { subscription, commitment }
 *     When `purchaseTransactionId` is given, that existing expense is linked as
 *     the first paid occurrence (renewal history) instead of creating another
 *     expense — no duplicate spending.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(AuditService) protected readonly audit: AuditService,
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<SubscriptionRow> {
    const [row] = await exec
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.id, id), eq(subscriptions.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Subscription");
  }

  async create(
    ctx: WorkspaceContext,
    raw: SubscriptionInput,
    options: { exec?: Executor; purchaseTransactionId?: string | null } = {},
  ): Promise<{ subscription: SubscriptionRow; commitment: CommitmentRow }> {
    const input = subscriptionInput.parse(raw);
    return runIn(options.exec, async (tx) => {
      const ws = ctx.workspaceId;
      await assertInWorkspace(tx, financialAccounts, ws, [input.recordPurchase?.accountId], "Account");
      await assertInWorkspace(tx, files, ws, [input.attachmentFileId], "Attachment");

      let purchase: TransactionRow | null = null;
      if (options.purchaseTransactionId) {
        purchase = await this.transactions.get(ctx, options.purchaseTransactionId, tx);
        if (purchase.status === "void") throw conflict("The purchase transaction was voided", "transaction_void");
        const [linked] = await tx
          .select({ id: commitmentOccurrences.id })
          .from(commitmentOccurrences)
          .where(eq(commitmentOccurrences.transactionId, purchase.id))
          .limit(1);
        if (linked) throw conflict("That transaction already settles another payment", "transaction_already_linked", { occurrenceId: linked.id });
      }
      const recordPurchase = purchase ? null : (input.recordPurchase ?? null);
      const purchaseDate = input.purchaseDate ?? purchase?.date ?? recordPurchase?.date ?? null;
      const purchaseOccurrenceDate = purchase || recordPurchase ? (input.purchaseDate ?? purchase?.date ?? recordPurchase?.date ?? null) : null;
      if (purchaseOccurrenceDate && purchaseOccurrenceDate >= input.nextRenewalDate) {
        throw unprocessable("The next renewal date must come after the purchase", "invalid_renewal_date");
      }

      const name = input.name?.trim() || defaultSubscriptionName(input.provider, input.planName);
      const commitment = await this.commitments.insert(
        tx,
        ctx,
        {
          kind: "subscription",
          direction: "out",
          name,
          payee: input.provider,
          counterpartyId: null,
          amount: input.amount,
          currency: input.currency,
          frequency: input.billingCycle,
          intervalCount: input.intervalCount,
          intervalUnit: input.intervalUnit ?? null,
          startDate: anchorStart({ ...input, intervalUnit: input.intervalUnit ?? null }),
          endDate: null,
          nextDueDate: input.nextRenewalDate,
          accountId: input.accountId ?? null,
          categoryId: input.categoryId ?? null,
          projectId: input.projectId ?? null,
          liabilityId: null,
          autoPay: input.autoRenew,
          reminderOffsets: input.reminderOffsets ?? null,
          notes: null,
        },
        { status: commitmentStatusFor(input.status) },
      );

      const subscriptionId = uuidv7();
      if (purchaseOccurrenceDate) {
        const occurrenceId = uuidv7();
        if (!purchase && recordPurchase) {
          const { transaction } = await this.transactions.create(
            ctx,
            {
              type: "expense",
              accountId: recordPurchase.accountId ?? input.accountId ?? null,
              amount: recordPurchase.amount ?? input.amount,
              currency: input.currency,
              date: recordPurchase.date,
              merchant: input.provider,
              categoryId: input.categoryId ?? null,
              projectId: input.projectId ?? null,
              description: name,
              // The invoice attached to the subscription is the purchase's receipt too.
              attachmentFileIds: input.attachmentFileId ? [input.attachmentFileId] : undefined,
            },
            { exec: tx, metadata: { origin: "subscription_purchase", commitmentId: commitment.id, occurrenceId, subscriptionId } },
          );
          purchase = transaction;
        }
        const paid = purchase as TransactionRow;
        const paidAmount =
          paid.currency === commitment.currency ? paid.amount : await this.fx.tryConvert(paid.amount, paid.currency, commitment.currency, paid.date, ws, tx);
        await tx.insert(commitmentOccurrences).values({
          id: occurrenceId,
          workspaceId: ws,
          commitmentId: commitment.id,
          dueDate: purchaseOccurrenceDate,
          amount: paidAmount ?? commitment.amount,
          currency: commitment.currency,
          status: "paid",
          transactionId: paid.id,
          paidOn: paid.date,
          paidAmount,
          note: "Purchase",
        });
      }

      const [subscription] = await tx
        .insert(subscriptions)
        .values({
          id: subscriptionId,
          workspaceId: ws,
          commitmentId: commitment.id,
          provider: input.provider,
          planName: input.planName ?? null,
          purchaseDate,
          startDate: input.startDate,
          trialEndsOn: input.trialEndsOn ?? null,
          expiryDate: input.expiryDate ?? null,
          cancellationDeadline: input.cancellationDeadline ?? null,
          autoRenew: input.autoRenew,
          status: input.status,
          externalProviderId: input.externalProviderId ?? null,
          attachmentFileId: input.attachmentFileId ?? null,
          cancelledAt: input.status === "cancelled" || input.status === "cancellation_pending" ? new Date() : null,
          notes: input.notes ?? null,
        })
        .returning();
      if (!subscription) throw new Error("Subscription was not created");

      await this.audit.record(tx, ctx, {
        action: "subscription.created",
        entityType: "subscription",
        entityId: subscription.id,
        after: { subscription, commitment, purchaseTransactionId: purchase?.id ?? null },
      });
      return { subscription, commitment };
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof subscriptionUpdate>) {
    const changes = subscriptionUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const commitment = await this.commitments.get(ctx, before.commitmentId, tx);
      await assertInWorkspace(tx, files, ctx.workspaceId, [changes.attachmentFileId], "Attachment");

      const provider = changes.provider ?? before.provider;
      const planName = changes.planName !== undefined ? changes.planName : before.planName;
      const name =
        changes.name?.trim() ||
        (commitment.name === defaultSubscriptionName(before.provider, before.planName) ? defaultSubscriptionName(provider, planName) : undefined);

      const commitmentChanges: CommitmentChanges = {
        name,
        payee: changes.provider,
        amount: changes.amount,
        currency: changes.currency,
        frequency: changes.billingCycle,
        intervalCount: changes.intervalCount,
        intervalUnit: changes.intervalUnit,
        nextDueDate: changes.nextRenewalDate,
        accountId: changes.accountId,
        categoryId: changes.categoryId,
        projectId: changes.projectId,
        autoPay: changes.autoRenew,
        reminderOffsets: changes.reminderOffsets,
      } as CommitmentChanges;
      // A form resends every field; only a real change re-anchors the schedule
      // (re-anchoring replaces the scheduled occurrence and its reminders).
      const unit = (value: CommitmentRow["intervalUnit"] | undefined) => value ?? null;
      const scheduleTouched =
        (changes.billingCycle !== undefined && changes.billingCycle !== commitment.frequency) ||
        (changes.intervalCount !== undefined &&
          changes.intervalCount !== commitment.intervalCount &&
          (changes.billingCycle ?? commitment.frequency) === "custom") ||
        (changes.intervalUnit !== undefined &&
          unit(changes.intervalUnit) !== unit(commitment.intervalUnit) &&
          (changes.billingCycle ?? commitment.frequency) === "custom") ||
        (changes.nextRenewalDate !== undefined && changes.nextRenewalDate !== (commitment.status === "active" ? commitment.nextDueDate : null)) ||
        (changes.startDate !== undefined && changes.startDate !== before.startDate);
      if (!scheduleTouched) {
        commitmentChanges.frequency = undefined;
        commitmentChanges.intervalCount = undefined;
        commitmentChanges.intervalUnit = undefined;
        commitmentChanges.nextDueDate = undefined;
      }
      if (scheduleTouched) {
        const billingCycle = (changes.billingCycle ?? commitment.frequency) as BillingCycle;
        commitmentChanges.startDate = anchorStart({
          billingCycle,
          intervalCount: changes.intervalCount ?? commitment.intervalCount,
          intervalUnit: changes.intervalUnit !== undefined ? changes.intervalUnit : commitment.intervalUnit,
          startDate: changes.startDate ?? before.startDate ?? commitment.startDate,
          nextRenewalDate: changes.nextRenewalDate ?? commitment.nextDueDate ?? commitment.startDate,
        });
      }
      if (changes.status && changes.status !== before.status) {
        commitmentChanges.status = commitmentStatusFor(changes.status);
      }
      await this.commitments.applyUpdate(tx, ctx, commitment, commitmentChanges);

      const patch: Partial<SubscriptionRow> = {};
      const fields = [
        "provider",
        "planName",
        "purchaseDate",
        "startDate",
        "trialEndsOn",
        "expiryDate",
        "cancellationDeadline",
        "autoRenew",
        "status",
        "externalProviderId",
        "attachmentFileId",
        "notes",
      ] as const;
      for (const field of fields) {
        if (changes[field] !== undefined) (patch as Record<string, unknown>)[field] = changes[field];
      }
      if (changes.status && changes.status !== before.status) {
        const cancelling = changes.status === "cancelled" || changes.status === "cancellation_pending";
        patch.cancelledAt = cancelling ? (before.cancelledAt ?? new Date()) : changes.status === "expired" ? before.cancelledAt : null;
      }
      const [after] = Object.keys(patch).length ? await tx.update(subscriptions).set(patch).where(eq(subscriptions.id, id)).returning() : [before];
      await this.audit.record(tx, ctx, { action: "subscription.updated", entityType: "subscription", entityId: id, before: { ...before, commitment }, after });
    });
    return this.detail(ctx, id);
  }

  /**
   * Stops renewals. Access continues until the expiry date, so the status is
   * "cancellation pending" while that is still ahead and "cancelled" once it
   * is not. Paid history stays; only the expiry notice keeps coming.
   */
  async cancel(ctx: WorkspaceContext, id: string, raw: SubscriptionCancelInput = {}) {
    const input = subscriptionCancelInput.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      if (before.status === "cancelled" || before.status === "expired") throw conflict("This subscription is already cancelled", "already_cancelled");
      const commitment = await this.commitments.get(ctx, before.commitmentId, tx);
      const today = todayFor(ctx);
      const accessEnds = input.effectiveDate ?? before.expiryDate ?? (commitment.status === "active" ? commitment.nextDueDate : null) ?? today;
      const status: SubscriptionStatus = accessEnds > today ? "cancellation_pending" : "cancelled";
      await this.commitments.setStatus(tx, ctx, commitment, "ended");
      const [after] = await tx
        .update(subscriptions)
        .set({ status, cancelledAt: new Date(), expiryDate: accessEnds })
        .where(eq(subscriptions.id, id))
        .returning();
      await this.audit.record(tx, ctx, {
        action: "subscription.cancelled",
        entityType: "subscription",
        entityId: id,
        before,
        after: { ...after, reason: input.reason ?? null },
      });
    });
    return this.detail(ctx, id);
  }

  async pause(ctx: WorkspaceContext, id: string) {
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      if (before.status === "paused") return;
      if (before.status === "cancelled" || before.status === "expired") throw conflict("A cancelled subscription cannot be paused", "cancelled");
      const commitment = await this.commitments.get(ctx, before.commitmentId, tx);
      await this.commitments.setStatus(tx, ctx, commitment, "paused");
      const [after] = await tx.update(subscriptions).set({ status: "paused" }).where(eq(subscriptions.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "subscription.paused", entityType: "subscription", entityId: id, before, after });
    });
    return this.detail(ctx, id);
  }

  /** Resumes a paused subscription, or reactivates a cancelled one. */
  async resume(ctx: WorkspaceContext, id: string) {
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const commitment = await this.commitments.get(ctx, before.commitmentId, tx);
      if (commitment.status === "active" && !["paused", "cancelled", "cancellation_pending", "expired"].includes(before.status)) return;
      const resumed = await this.commitments.setStatus(tx, ctx, commitment, "active");
      const status = currentSubscriptionStatus({ ...before, status: "active" }, resumed, todayFor(ctx));
      const [after] = await tx.update(subscriptions).set({ status, cancelledAt: null }).where(eq(subscriptions.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "subscription.resumed", entityType: "subscription", entityId: id, before, after });
    });
    return this.detail(ctx, id);
  }

  /** Deleted when it has no payment history; otherwise cancelled and kept. */
  async remove(ctx: WorkspaceContext, id: string) {
    const subscription = await this.get(ctx, id);
    return this.commitments.remove(ctx, subscription.commitmentId);
  }

  // ------------------------------------------------------------------ reads

  private async joined(ctx: WorkspaceContext, where: SQL[], exec: Executor = db): Promise<JoinedSubscription[]> {
    return exec
      .select({
        subscription: subscriptions,
        commitment: commitments,
        accountName: financialAccounts.name,
        categoryName: categories.name,
        categoryIcon: categories.icon,
        categoryColor: categories.color,
        projectName: projects.name,
        projectColor: projects.color,
      })
      .from(subscriptions)
      .innerJoin(commitments, eq(commitments.id, subscriptions.commitmentId))
      .leftJoin(financialAccounts, eq(financialAccounts.id, commitments.accountId))
      .leftJoin(categories, eq(categories.id, commitments.categoryId))
      .leftJoin(projects, eq(projects.id, commitments.projectId))
      .where(and(eq(subscriptions.workspaceId, ctx.workspaceId), ...where))
      .orderBy(asc(commitments.nextDueDate), asc(commitments.name));
  }

  private async views(ctx: WorkspaceContext, rows: JoinedSubscription[], exec: Executor = db): Promise<SubscriptionView[]> {
    const today = todayFor(ctx);
    const converter = new BaseConverter(this.fx, ctx, today, exec);
    const ids = rows.map((row) => row.commitment.id);
    const occurrences = ids.length
      ? await exec
          .select()
          .from(commitmentOccurrences)
          .where(and(inArray(commitmentOccurrences.commitmentId, ids), inArray(commitmentOccurrences.status, ["scheduled", "paid"])))
          .orderBy(asc(commitmentOccurrences.dueDate))
      : [];
    const nextBy = new Map<string, OccurrenceRow>();
    const lastPaidBy = new Map<string, OccurrenceRow>();
    for (const o of occurrences) {
      if (o.status === "scheduled" && !nextBy.has(o.commitmentId)) nextBy.set(o.commitmentId, o);
      if (o.status === "paid") lastPaidBy.set(o.commitmentId, o);
    }
    return Promise.all(
      rows.map(async ({ subscription: s, commitment: c, ...names }) => {
        const schedule = scheduleOf(c);
        const monthly = monthlyEquivalent(c.amount, schedule);
        const yearly = annualized(c.amount, schedule);
        const derivedStatus = currentSubscriptionStatus(s, c, today);
        const nextRenewalDate = c.status === "active" ? c.nextDueDate : null;
        const lastPaid = lastPaidBy.get(c.id);
        return {
          ...s,
          name: c.name,
          derivedStatus,
          statusLabel: SUBSCRIPTION_STATUS_LABELS[derivedStatus],
          commitmentStatus: c.status,
          amount: c.amount,
          currency: c.currency,
          billingCycle: c.frequency as BillingCycle,
          billingLabel: frequencyLabel(c),
          intervalCount: c.intervalCount,
          intervalUnit: c.intervalUnit,
          nextRenewalDate,
          daysUntilRenewal: nextRenewalDate ? diffDays(today, nextRenewalDate) : null,
          accountId: c.accountId,
          accountName: names.accountName,
          categoryId: c.categoryId,
          categoryName: names.categoryName,
          categoryIcon: names.categoryIcon,
          categoryColor: names.categoryColor,
          projectId: c.projectId,
          projectName: names.projectName,
          projectColor: names.projectColor,
          reminderOffsets: c.reminderOffsets,
          baseCurrency: ctx.baseCurrency,
          baseAmount: await converter.convert(c.amount, c.currency),
          monthlyEquivalent: monthly,
          monthlyEquivalentBase: await converter.convert(monthly, c.currency),
          annualCost: yearly,
          annualCostBase: await converter.convert(yearly, c.currency),
          nextOccurrenceId: c.status === "active" ? (nextBy.get(c.id)?.id ?? null) : null,
          lastPayment: lastPaid
            ? {
                occurrenceId: lastPaid.id,
                dueDate: lastPaid.dueDate,
                paidOn: lastPaid.paidOn,
                paidAmount: lastPaid.paidAmount,
                currency: lastPaid.currency,
                transactionId: lastPaid.transactionId,
              }
            : null,
          links: {
            self: links.subscription(s.id),
            commitment: links.commitment(c.id),
            transactions: links.transactions({ period: "all_time", commitmentId: c.id }),
          },
        };
      }),
    );
  }

  async list(ctx: WorkspaceContext, raw: SubscriptionQuery = {}) {
    const query = subscriptionQuery.parse(raw);
    const where: SQL[] = [];
    if (query.billingCycle?.length) where.push(inArray(commitments.frequency, query.billingCycle));
    if (query.projectId) where.push(eq(commitments.projectId, query.projectId));
    if (query.categoryId) where.push(eq(commitments.categoryId, query.categoryId));
    if (query.accountId) where.push(eq(commitments.accountId, query.accountId));
    if (query.autoRenew !== undefined) where.push(eq(subscriptions.autoRenew, query.autoRenew));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      where.push(
        or(
          ilike(commitments.name, needle),
          ilike(subscriptions.provider, needle),
          ilike(subscriptions.planName, needle),
          ilike(subscriptions.notes, needle),
          ilike(projects.name, needle),
          ilike(categories.name, needle),
          ilike(financialAccounts.name, needle),
        ) as SQL,
      );
    }
    const rows = await this.joined(ctx, where);
    const scheduleBy = new Map(rows.map((row) => [row.subscription.id, scheduleOf(row.commitment)]));
    let items = await this.views(ctx, rows);
    if (query.status?.length) {
      const wanted = new Set(query.status);
      items = items.filter((item) => wanted.has(item.derivedStatus));
    }
    if (query.minAmount !== undefined) items = items.filter((item) => item.baseAmount !== null && item.baseAmount >= (query.minAmount as number));
    if (query.maxAmount !== undefined) items = items.filter((item) => item.baseAmount !== null && item.baseAmount <= (query.maxAmount as number));
    if (query.renewingIn) {
      const from = `${query.renewingIn}-01`;
      const to = endOfMonth(from);
      items = items.filter((item) => {
        if (!item.nextRenewalDate || item.nextRenewalDate > to) return false;
        if (item.nextRenewalDate >= from) return true;
        const schedule = scheduleBy.get(item.id) as Schedule;
        return dueDatesBetween(schedule, maxDay(from, addDays(item.nextRenewalDate, 1)), to, 1).length > 0;
      });
    }
    const byRenewal = (a: SubscriptionView, b: SubscriptionView) => (a.nextRenewalDate ?? "9999-12-31").localeCompare(b.nextRenewalDate ?? "9999-12-31");
    const sorters: Record<typeof query.sort, (a: SubscriptionView, b: SubscriptionView) => number> = {
      renewal_asc: (a, b) => byRenewal(a, b) || a.name.localeCompare(b.name),
      amount_desc: (a, b) => (b.baseAmount ?? -1) - (a.baseAmount ?? -1),
      monthly_desc: (a, b) => (b.monthlyEquivalentBase ?? -1) - (a.monthlyEquivalentBase ?? -1),
      name_asc: (a, b) => a.name.localeCompare(b.name),
    };
    items.sort(sorters[query.sort]);
    return { items, total: items.length, baseCurrency: ctx.baseCurrency };
  }

  /** The subscription with its renewal history, price changes and next renewals. */
  async detail(ctx: WorkspaceContext, id: string) {
    const [row] = await this.joined(ctx, [eq(subscriptions.id, id)]);
    const joined = assertFound(row, "Subscription");
    const [view] = await this.views(ctx, [joined]);
    const history = (await this.commitments.history(ctx, [joined.commitment.id])).get(joined.commitment.id) ?? [];
    const priceChanges = history
      .filter((o) => o.priceChange)
      .map((o) => ({
        occurrenceId: o.id,
        dueDate: o.dueDate,
        paidOn: o.paidOn,
        currency: o.currency,
        previousOccurrenceId: o.priceChange?.previousOccurrenceId ?? null,
        previousTransactionId: o.priceChange?.previousTransactionId ?? null,
        transactionId: o.transactionId,
        previous: o.priceChange?.previous ?? 0,
        current: o.priceChange?.current ?? 0,
        difference: o.priceChange?.difference ?? 0,
        percent: o.priceChange?.percent ?? null,
        direction: o.priceChange?.direction ?? "increase",
      }));
    return {
      ...(view as SubscriptionView),
      commitment: joined.commitment,
      renewals: [...history].reverse(),
      priceChanges: priceChanges.reverse(),
      stats: occurrenceStats(history, joined.commitment),
      upcomingRenewals: projectDueDates(joined.commitment, 3),
    };
  }

  /** Costs in the base currency; what cannot be converted is listed, never dropped. */
  async analytics(ctx: WorkspaceContext) {
    const today = todayFor(ctx);
    const horizon = addDays(today, 30);
    const rows = await this.joined(ctx, []);
    const scheduleBy = new Map(rows.map((row) => [row.subscription.id, scheduleOf(row.commitment)]));
    const all = await this.views(ctx, rows);
    const active = all.filter((item) => ACTIVE_SUBSCRIPTION_STATUSES.has(item.derivedStatus) && item.commitmentStatus === "active");

    const monthly = new Totals();
    const annual = new Totals();
    type Group = { count: number; monthly: number; annual: number };
    const group = <K extends string>(map: Map<K, Group & Record<string, unknown>>, key: K, extra: Record<string, unknown>, item: SubscriptionView) => {
      const entry = map.get(key) ?? ({ ...extra, count: 0, monthly: 0, annual: 0 } as Group & Record<string, unknown>);
      entry.count += 1;
      entry.monthly += item.monthlyEquivalentBase ?? 0;
      entry.annual += item.annualCostBase ?? 0;
      map.set(key, entry);
    };
    const byProject = new Map<string, Group & Record<string, unknown>>();
    const byCategory = new Map<string, Group & Record<string, unknown>>();
    const byCycle = new Map<string, Group & Record<string, unknown>>();
    const upcomingItems: Array<{
      subscriptionId: string;
      name: string;
      date: Day;
      amount: number;
      currency: string;
      baseAmount: number | null;
      autoRenew: boolean;
    }> = [];
    const upcomingTotal = new Totals();
    const overdue = new Totals();
    let overdueCount = 0;
    const converter = new BaseConverter(this.fx, ctx, today);

    for (const item of active) {
      monthly.add(item.monthlyEquivalentBase, item.monthlyEquivalent, item.currency);
      annual.add(item.annualCostBase, item.annualCost, item.currency);
      group(byProject, item.projectId ?? "none", { projectId: item.projectId, projectName: item.projectName }, item);
      group(byCategory, item.categoryId ?? "none", { categoryId: item.categoryId, categoryName: item.categoryName }, item);
      group(byCycle, item.billingCycle, { billingCycle: item.billingCycle }, item);
      if (!item.nextRenewalDate) continue;
      if (item.nextRenewalDate < today) {
        overdueCount += 1;
        overdue.add(item.baseAmount, item.amount, item.currency);
      }
      const schedule = scheduleBy.get(item.id) as Schedule;
      for (const date of dueDatesBetween(schedule, maxDay(today, item.nextRenewalDate), horizon)) {
        const baseAmount = await converter.convert(item.amount, item.currency, date);
        upcomingItems.push({
          subscriptionId: item.id,
          name: item.name,
          date,
          amount: item.amount,
          currency: item.currency,
          baseAmount,
          autoRenew: item.autoRenew,
        });
        upcomingTotal.add(baseAmount, item.amount, item.currency);
      }
    }
    upcomingItems.sort((a, b) => a.date.localeCompare(b.date));
    const yearly = active.filter((item) => item.billingCycle === "yearly");
    const yearlyTotal = new Totals();
    for (const item of yearly) yearlyTotal.add(item.baseAmount, item.amount, item.currency);
    const byStatus = Object.fromEntries(Object.keys(SUBSCRIPTION_STATUS_LABELS).map((status) => [status, 0])) as Record<SubscriptionStatus, number>;
    for (const item of all) byStatus[item.derivedStatus] += 1;
    const sortGroups = (map: Map<string, Group & Record<string, unknown>>) => [...map.values()].sort((a, b) => b.monthly - a.monthly);

    return {
      baseCurrency: ctx.baseCurrency,
      asOf: today,
      totalCount: all.length,
      activeCount: active.length,
      byStatus,
      monthlyTotal: monthly.total,
      annualTotal: annual.total,
      annualCommitments: {
        count: yearly.length,
        total: yearlyTotal.total,
        unconverted: yearlyTotal.unconvertedList(),
        items: yearly
          .map((item) => ({
            subscriptionId: item.id,
            name: item.name,
            amount: item.amount,
            currency: item.currency,
            baseAmount: item.baseAmount,
            nextRenewalDate: item.nextRenewalDate,
            autoRenew: item.autoRenew,
          }))
          .sort((a, b) => (a.nextRenewalDate ?? "9999").localeCompare(b.nextRenewalDate ?? "9999")),
      },
      upcoming30: {
        from: today,
        to: horizon,
        count: upcomingItems.length,
        total: upcomingTotal.total,
        unconverted: upcomingTotal.unconvertedList(),
        items: upcomingItems,
      },
      overdue: { count: overdueCount, total: overdue.total, unconverted: overdue.unconvertedList() },
      byProject: sortGroups(byProject),
      byCategory: sortGroups(byCategory),
      byBillingCycle: BILLING_CYCLES.map((cycle) => byCycle.get(cycle)).filter((entry): entry is Group & Record<string, unknown> => Boolean(entry)),
      unconverted: active
        .filter((item) => item.baseAmount === null)
        .map((item) => ({
          subscriptionId: item.id,
          name: item.name,
          amount: item.amount,
          currency: item.currency,
          monthlyEquivalent: item.monthlyEquivalent,
          annualCost: item.annualCost,
        })),
    };
  }

  /**
   * Persists derived statuses (renewal due, expired, back to active after a
   * renewal) for the reminder scan. Returns what changed.
   */
  async refreshStatuses(ctx: WorkspaceContext, today: Day = todayFor(ctx)) {
    const rows = await db
      .select({ subscription: subscriptions, commitment: commitments })
      .from(subscriptions)
      .innerJoin(commitments, eq(commitments.id, subscriptions.commitmentId))
      .where(and(eq(subscriptions.workspaceId, ctx.workspaceId), ne(subscriptions.status, "paused")))
      .orderBy(desc(subscriptions.createdAt));
    const changed: Array<{ id: string; from: SubscriptionStatus; to: SubscriptionStatus }> = [];
    for (const { subscription, commitment } of rows) {
      const status = currentSubscriptionStatus(subscription, commitment, today);
      if (status === subscription.status) continue;
      await db.transaction(async (tx) => {
        const [after] = await tx
          .update(subscriptions)
          .set({ status })
          .where(and(eq(subscriptions.id, subscription.id), eq(subscriptions.status, subscription.status)))
          .returning();
        if (!after) return;
        await this.audit.record(tx, ctx, {
          action: "subscription.status_changed",
          entityType: "subscription",
          entityId: subscription.id,
          before: { status: subscription.status },
          after: { status },
        });
        changed.push({ id: subscription.id, from: subscription.status, to: status });
      });
    }
    return changed;
  }
}
