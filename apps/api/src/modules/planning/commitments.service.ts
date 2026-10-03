import {
  addDays,
  annualized,
  COMMITMENT_KIND_LABELS,
  type CommitmentInput,
  commitmentInput,
  commitmentUpdate,
  type Day,
  deriveSubscriptionStatus,
  detectPriceChange,
  diffDays,
  FREQUENCY_LABELS,
  followingDueDate,
  maxDay,
  monthlyEquivalent,
  nextDueOnOrAfter,
  type PriceChange,
  type SubscriptionStatus,
} from "@financeos/core";
import { type CommitmentQuery, commitmentQuery } from "@financeos/core/contracts/planning-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, notFound, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import {
  categories,
  commitmentOccurrences,
  commitments,
  counterparties,
  financialAccounts,
  liabilities,
  projects,
  subscriptions,
  transactions,
} from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { AuditService } from "../system/audit.service.js";
import { InboxService } from "../system/notify.service.js";
import {
  BaseConverter,
  type CommitmentRow,
  firstDueDate,
  links,
  type OccurrenceRow,
  reminderOffsetsFor,
  runIn,
  scheduleOf,
  Totals,
} from "./planning.shared.js";

export type { CommitmentRow, OccurrenceRow } from "./planning.shared.js";

export type CommitmentParsed = z.output<typeof commitmentInput>;
export type CommitmentChanges = z.output<typeof commitmentUpdate>;
export type CommitmentStatus = CommitmentRow["status"];
export type JoinedCommitment = Awaited<ReturnType<CommitmentsService["joined"]>>[number];

export type CommitmentView = CommitmentRow & {
  kindLabel: string;
  frequencyLabel: string;
  accountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectName: string | null;
  projectColor: string | null;
  counterpartyName: string | null;
  liabilityName: string | null;
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  baseCurrency: string;
  /** `amount` in the base currency at today's rate; null when no rate exists. */
  baseAmount: number | null;
  monthlyEquivalent: number;
  monthlyEquivalentBase: number | null;
  annualized: number;
  annualizedBase: number | null;
  nextOccurrence: { id: string; dueDate: Day; amount: number; currency: string; status: OccurrenceRow["status"] } | null;
  daysUntilDue: number | null;
  /** The next payment's due date has passed without it being recorded. */
  overdue: boolean;
  effectiveReminderOffsets: number[];
  links: { self: string; commitment: string; subscription: string | null; transactions: string };
};

export type OccurrenceTransaction = {
  id: string;
  type: string;
  direction: string;
  status: string;
  date: Day;
  amount: number;
  currency: string;
  baseAmount: number | null;
  baseCurrency: string | null;
  accountId: string | null;
  accountName: string | null;
  merchant: string | null;
  source: string;
  /** Created by recording this payment (undo voids it) rather than linked. */
  createdByPayment: boolean;
  href: string;
};

export type OccurrenceView = OccurrenceRow & {
  overdue: boolean;
  daysUntil: number;
  transaction: OccurrenceTransaction | null;
  /** Versus the previous paid occurrence, when the amount changed. */
  priceChange: (PriceChange & { previousOccurrenceId: string; previousTransactionId: string | null }) | null;
};

/** Metadata tag on transactions created by recording a commitment payment. */
export const PAYMENT_ORIGIN = "commitment_payment";

function rowAsInput(row: CommitmentRow): CommitmentParsed {
  return {
    kind: row.kind,
    direction: row.direction,
    name: row.name,
    payee: row.payee,
    counterpartyId: row.counterpartyId,
    amount: row.amount,
    currency: row.currency,
    frequency: row.frequency,
    intervalCount: row.intervalCount,
    intervalUnit: row.intervalUnit,
    startDate: row.startDate,
    endDate: row.endDate,
    nextDueDate: row.nextDueDate,
    accountId: row.accountId,
    categoryId: row.categoryId,
    projectId: row.projectId,
    liabilityId: row.liabilityId,
    autoPay: row.autoPay,
    reminderOffsets: row.reminderOffsets,
    notes: row.notes,
  };
}

export function frequencyLabel(row: Pick<CommitmentRow, "frequency" | "intervalCount" | "intervalUnit">): string {
  if (row.frequency !== "custom") return FREQUENCY_LABELS[row.frequency];
  const unit = row.intervalUnit ?? "month";
  return row.intervalCount === 1 ? `Every ${unit}` : `Every ${row.intervalCount} ${unit}s`;
}

const SCHEDULE_FIELDS = ["frequency", "intervalCount", "intervalUnit", "startDate", "endDate"] as const;

/**
 * Financial commitments: scheduled future obligations (and expected income).
 * A commitment is a promise, not money moving: each due instance is an
 * occurrence row, and paying one links (or creates) the transaction.
 *
 * CONTRACT (other modules depend on these signatures — keep them):
 *   create(ctx, input, { exec? }) → CommitmentRow
 *     Validates references, computes nextDueDate from the schedule, materialises
 *     the next occurrence, audits. Used by wealth (loan installment schedules)
 *     and business (salary/payroll commitments).
 */
@Injectable()
export class CommitmentsService {
  constructor(
    @Inject(AuditService) protected readonly audit: AuditService,
    @Inject(FxService) private readonly fx: FxService,
    @Inject(InboxService) private readonly inbox: InboxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<CommitmentRow> {
    const [row] = await exec
      .select()
      .from(commitments)
      .where(and(eq(commitments.id, id), eq(commitments.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Commitment");
  }

  async create(ctx: WorkspaceContext, raw: CommitmentInput, options: { exec?: Executor } = {}): Promise<CommitmentRow> {
    const input = commitmentInput.parse(raw);
    return runIn(options.exec, async (tx) => {
      const row = await this.insert(tx, ctx, input);
      await this.audit.record(tx, ctx, { action: "commitment.created", entityType: "commitment", entityId: row.id, after: row });
      return row;
    });
  }

  /**
   * Inserts a parsed commitment and materialises its next occurrence. No
   * audit: callers record the action they performed (a commitment, a
   * subscription, a loan schedule).
   */
  async insert(tx: Executor, ctx: WorkspaceContext, input: CommitmentParsed, options: { status?: CommitmentStatus } = {}): Promise<CommitmentRow> {
    await this.validate(tx, ctx, input);
    const intervalUnit = input.frequency === "custom" ? (input.intervalUnit ?? "month") : (input.intervalUnit ?? null);
    const schedule = {
      frequency: input.frequency,
      intervalCount: input.intervalCount,
      intervalUnit,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
    };
    const wanted = options.status ?? "active";
    const nextDueDate = wanted === "ended" ? null : (input.nextDueDate ?? firstDueDate(schedule, todayFor(ctx)));
    const status: CommitmentStatus = wanted === "active" && !nextDueDate ? "ended" : wanted;

    const [row] = await tx
      .insert(commitments)
      .values({
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        direction: input.direction,
        name: input.name,
        payee: input.payee ?? null,
        counterpartyId: input.counterpartyId ?? null,
        amount: input.amount,
        currency: input.currency,
        frequency: input.frequency,
        intervalCount: input.intervalCount,
        intervalUnit,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        nextDueDate,
        accountId: input.accountId ?? null,
        categoryId: input.categoryId ?? null,
        projectId: input.projectId ?? null,
        liabilityId: input.liabilityId ?? null,
        autoPay: input.autoPay,
        status,
        reminderOffsets: input.reminderOffsets?.length ? input.reminderOffsets : null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    if (!row) throw new Error("Commitment was not created");
    if (row.status === "active" && row.nextDueDate) await this.materialise(tx, row, row.nextDueDate);
    return row;
  }

  private async validate(
    tx: Executor,
    ctx: WorkspaceContext,
    input: Pick<
      CommitmentParsed,
      "direction" | "accountId" | "categoryId" | "projectId" | "counterpartyId" | "liabilityId" | "startDate" | "endDate" | "nextDueDate"
    >,
  ) {
    const ws = ctx.workspaceId;
    await assertInWorkspace(tx, financialAccounts, ws, [input.accountId], "Account");
    await assertInWorkspace(tx, categories, ws, [input.categoryId], "Category");
    await assertInWorkspace(tx, projects, ws, [input.projectId], "Project");
    await assertInWorkspace(tx, counterparties, ws, [input.counterpartyId], "Counterparty");
    await assertInWorkspace(tx, liabilities, ws, [input.liabilityId], "Liability");
    if (input.categoryId) {
      const [category] = await tx.select({ kind: categories.kind }).from(categories).where(eq(categories.id, input.categoryId));
      const expected = input.direction === "in" ? "income" : "expense";
      if (category && category.kind !== expected) {
        throw unprocessable(
          expected === "income" ? "Expected income needs an income category" : "That is an income category; choose an expense category",
          "category_kind_mismatch",
        );
      }
    }
    if (input.endDate && input.endDate < input.startDate) throw unprocessable("The end date is before the start date", "invalid_dates");
    if (input.nextDueDate && input.endDate && input.nextDueDate > input.endDate) {
      throw unprocessable("The next due date is after the end date", "invalid_dates");
    }
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof commitmentUpdate>): Promise<CommitmentRow> {
    const changes = commitmentUpdate.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const after = await this.applyUpdate(tx, ctx, before, changes);
      if (after.status !== before.status) await this.syncSubscriptionStatus(tx, ctx, after);
      await this.audit.record(tx, ctx, { action: "commitment.updated", entityType: "commitment", entityId: id, before, after });
      return after;
    });
  }

  /**
   * Keeps a subscription's own status in step when its commitment is paused,
   * resumed or ended through the commitment routes.
   */
  private async syncSubscriptionStatus(tx: Executor, ctx: WorkspaceContext, commitment: CommitmentRow) {
    const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.commitmentId, commitment.id)).limit(1);
    if (!subscription) return;
    const stopped = subscription.status === "cancelled" || subscription.status === "cancellation_pending" || subscription.status === "expired";
    let status = subscription.status;
    let cancelledAt = subscription.cancelledAt;
    if (commitment.status === "paused") status = "paused";
    else if (commitment.status === "ended") {
      if (!stopped) {
        status = "cancelled";
        cancelledAt = new Date();
      }
    } else if (stopped || subscription.status === "paused") {
      status = deriveSubscriptionStatus(
        {
          name: commitment.name,
          status: "active",
          autoRenew: subscription.autoRenew,
          nextRenewalDate: commitment.nextDueDate,
          expiryDate: subscription.expiryDate,
          cancellationDeadline: subscription.cancellationDeadline,
          trialEndsOn: subscription.trialEndsOn,
        },
        todayFor(ctx),
      );
      cancelledAt = null;
    }
    if (status === subscription.status && cancelledAt === subscription.cancelledAt) return;
    await tx.update(subscriptions).set({ status, cancelledAt }).where(eq(subscriptions.id, subscription.id));
    await this.audit.record(tx, ctx, {
      action: "subscription.status_changed",
      entityType: "subscription",
      entityId: subscription.id,
      before: { status: subscription.status },
      after: { status },
    });
  }

  /**
   * Applies changes. A new amount carries to the scheduled occurrences; a new
   * schedule (or an explicit next due date) replaces the unpaid scheduled
   * occurrences while paid history stays as it was.
   */
  async applyUpdate(tx: Executor, ctx: WorkspaceContext, before: CommitmentRow, changes: CommitmentChanges): Promise<CommitmentRow> {
    const { status, ...fields } = changes;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<CommitmentParsed>;
    const merged: CommitmentParsed = { ...rowAsInput(before), ...defined };
    await this.validate(tx, ctx, { ...merged, nextDueDate: defined.nextDueDate ?? null });
    const intervalUnit = merged.frequency === "custom" ? (merged.intervalUnit ?? "month") : (merged.intervalUnit ?? null);
    const scheduleChanged = SCHEDULE_FIELDS.some((key) => {
      const value = key === "intervalUnit" ? intervalUnit : (merged[key] ?? null);
      return key in defined && value !== before[key];
    });
    const explicitNext = defined.nextDueDate !== undefined && defined.nextDueDate !== null && defined.nextDueDate !== before.nextDueDate;

    const [row] = await tx
      .update(commitments)
      .set({
        kind: merged.kind,
        direction: merged.direction,
        name: merged.name,
        payee: merged.payee ?? null,
        counterpartyId: merged.counterpartyId ?? null,
        amount: merged.amount,
        currency: merged.currency,
        frequency: merged.frequency,
        intervalCount: merged.intervalCount,
        intervalUnit,
        startDate: merged.startDate,
        endDate: merged.endDate ?? null,
        accountId: merged.accountId ?? null,
        categoryId: merged.categoryId ?? null,
        projectId: merged.projectId ?? null,
        liabilityId: merged.liabilityId ?? null,
        autoPay: merged.autoPay,
        reminderOffsets: merged.reminderOffsets?.length ? merged.reminderOffsets : null,
        notes: merged.notes ?? null,
      })
      .where(eq(commitments.id, before.id))
      .returning();
    let current = row as CommitmentRow;

    if (current.amount !== before.amount || current.currency !== before.currency) {
      await tx
        .update(commitmentOccurrences)
        .set({ amount: current.amount, currency: current.currency })
        .where(and(eq(commitmentOccurrences.commitmentId, before.id), eq(commitmentOccurrences.status, "scheduled")));
    }

    if (current.status === "active" && (scheduleChanged || explicitNext)) {
      await tx
        .delete(commitmentOccurrences)
        .where(
          and(eq(commitmentOccurrences.commitmentId, before.id), eq(commitmentOccurrences.status, "scheduled"), isNull(commitmentOccurrences.transactionId)),
        );
      const next = explicitNext ? (defined.nextDueDate as Day) : await this.nextAfterSettled(tx, current, todayFor(ctx));
      if (next) await this.materialise(tx, current, next);
      const [rescheduled] = await tx
        .update(commitments)
        .set({ nextDueDate: next, status: next ? "active" : "ended" })
        .where(eq(commitments.id, before.id))
        .returning();
      current = rescheduled as CommitmentRow;
    }

    if (status && status !== current.status) current = await this.setStatus(tx, ctx, current, status);
    return current;
  }

  /** The first scheduled date after the last paid or skipped one (or from today when none). */
  private async nextAfterSettled(tx: Executor, row: CommitmentRow, today: Day): Promise<Day | null> {
    const [settled] = await tx
      .select({ dueDate: commitmentOccurrences.dueDate })
      .from(commitmentOccurrences)
      .where(and(eq(commitmentOccurrences.commitmentId, row.id), inArray(commitmentOccurrences.status, ["paid", "skipped"])))
      .orderBy(desc(commitmentOccurrences.dueDate))
      .limit(1);
    const schedule = scheduleOf(row);
    if (!settled) return firstDueDate(schedule, today);
    return followingDueDate(schedule, settled.dueDate);
  }

  async pause(ctx: WorkspaceContext, id: string) {
    return this.changeStatus(ctx, id, "paused", "commitment.paused");
  }

  async resume(ctx: WorkspaceContext, id: string) {
    return this.changeStatus(ctx, id, "active", "commitment.resumed");
  }

  async end(ctx: WorkspaceContext, id: string) {
    return this.changeStatus(ctx, id, "ended", "commitment.ended");
  }

  private async changeStatus(ctx: WorkspaceContext, id: string, status: CommitmentStatus, action: string) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const after = await this.setStatus(tx, ctx, before, status);
      if (after !== before) {
        await this.syncSubscriptionStatus(tx, ctx, after);
        await this.audit.record(tx, ctx, { action, entityType: "commitment", entityId: id, before, after });
      }
      return after;
    });
  }

  /**
   * Pause keeps everything as it is but silences it. End cancels the
   * scheduled occurrences (paid history stays). Resume drops payments that
   * fell due while paused and schedules the next one from today.
   */
  async setStatus(tx: Executor, ctx: WorkspaceContext, row: CommitmentRow, status: CommitmentStatus): Promise<CommitmentRow> {
    if (status === row.status) return row;
    if (status === "paused") {
      const [updated] = await tx.update(commitments).set({ status: "paused" }).where(eq(commitments.id, row.id)).returning();
      return updated as CommitmentRow;
    }
    if (status === "ended") {
      await tx
        .update(commitmentOccurrences)
        .set({ status: "cancelled" })
        .where(and(eq(commitmentOccurrences.commitmentId, row.id), eq(commitmentOccurrences.status, "scheduled")));
      const [updated] = await tx.update(commitments).set({ status: "ended", nextDueDate: null }).where(eq(commitments.id, row.id)).returning();
      await this.inbox.resolveForEntity(ctx.workspaceId, row.id, ["renewal"], ctx.userId, tx);
      return updated as CommitmentRow;
    }

    const today = todayFor(ctx);
    await tx
      .delete(commitmentOccurrences)
      .where(
        and(
          eq(commitmentOccurrences.commitmentId, row.id),
          eq(commitmentOccurrences.status, "scheduled"),
          lt(commitmentOccurrences.dueDate, today),
          isNull(commitmentOccurrences.transactionId),
        ),
      );
    let next = (await this.nextScheduled(tx, row.id))?.dueDate ?? null;
    if (!next) {
      const [settled] = await tx
        .select({ dueDate: commitmentOccurrences.dueDate })
        .from(commitmentOccurrences)
        .where(and(eq(commitmentOccurrences.commitmentId, row.id), inArray(commitmentOccurrences.status, ["paid", "skipped"])))
        .orderBy(desc(commitmentOccurrences.dueDate))
        .limit(1);
      const schedule = scheduleOf(row);
      next =
        row.frequency === "once" ? (settled ? null : row.startDate) : nextDueOnOrAfter(schedule, settled ? maxDay(today, addDays(settled.dueDate, 1)) : today);
    }
    if (!next) throw unprocessable("This schedule has no more due dates. Change its end date to resume it.", "schedule_ended");
    const [updated] = await tx.update(commitments).set({ status: "active", nextDueDate: next }).where(eq(commitments.id, row.id)).returning();
    await this.materialise(tx, updated as CommitmentRow, next);
    return updated as CommitmentRow;
  }

  /** Deletes a commitment without payment history; one with history is ended instead. */
  async remove(ctx: WorkspaceContext, id: string): Promise<{ deleted: boolean; ended: boolean }> {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const [history] = await tx
        .select({ id: commitmentOccurrences.id })
        .from(commitmentOccurrences)
        .where(and(eq(commitmentOccurrences.commitmentId, id), or(eq(commitmentOccurrences.status, "paid"), isNotNull(commitmentOccurrences.transactionId))))
        .limit(1);
      const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.commitmentId, id)).limit(1);
      if (history) {
        const after = await this.setStatus(tx, ctx, before, "ended");
        if (subscription && subscription.status !== "cancelled" && subscription.status !== "expired") {
          await tx.update(subscriptions).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(subscriptions.id, subscription.id));
        }
        await this.audit.record(tx, ctx, { action: "commitment.ended", entityType: "commitment", entityId: id, before, after });
        return { deleted: false, ended: true };
      }
      await tx.delete(commitments).where(eq(commitments.id, id));
      await this.inbox.resolveForEntity(ctx.workspaceId, id, ["renewal", "price_change"], ctx.userId, tx);
      await this.audit.record(tx, ctx, { action: "commitment.deleted", entityType: "commitment", entityId: id, before: { ...before, subscription } });
      return { deleted: true, ended: false };
    });
  }

  // ------------------------------------------------------------ occurrences

  /** The scheduled occurrence for a due date, created when missing (idempotent). */
  async materialise(tx: Executor, row: CommitmentRow, dueDate: Day): Promise<OccurrenceRow> {
    const [inserted] = await tx
      .insert(commitmentOccurrences)
      .values({
        workspaceId: row.workspaceId,
        commitmentId: row.id,
        dueDate,
        amount: row.amount,
        currency: row.currency,
        status: "scheduled",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const [existing] = await tx
      .select()
      .from(commitmentOccurrences)
      .where(and(eq(commitmentOccurrences.commitmentId, row.id), eq(commitmentOccurrences.dueDate, dueDate)))
      .limit(1);
    if (existing?.status === "cancelled") {
      const [revived] = await tx
        .update(commitmentOccurrences)
        .set({ status: "scheduled", amount: row.amount, currency: row.currency })
        .where(eq(commitmentOccurrences.id, existing.id))
        .returning();
      return revived as OccurrenceRow;
    }
    return assertFound(existing, "Occurrence");
  }

  async nextScheduled(exec: Executor, commitmentId: string): Promise<OccurrenceRow | null> {
    const [row] = await exec
      .select()
      .from(commitmentOccurrences)
      .where(and(eq(commitmentOccurrences.commitmentId, commitmentId), eq(commitmentOccurrences.status, "scheduled")))
      .orderBy(asc(commitmentOccurrences.dueDate))
      .limit(1);
    return row ?? null;
  }

  /**
   * Points `nextDueDate` at the earliest unsettled occurrence, materialising
   * the following due date when nothing is scheduled. A schedule with no
   * further dates (a paid one-off, a passed end date) ends.
   */
  async syncNext(tx: Executor, ctx: WorkspaceContext, id: string): Promise<CommitmentRow> {
    const row = await this.get(ctx, id, tx);
    if (row.status !== "active") return row;
    let next = (await this.nextScheduled(tx, row.id))?.dueDate ?? null;
    if (!next) {
      const [latest] = await tx
        .select({ dueDate: commitmentOccurrences.dueDate })
        .from(commitmentOccurrences)
        .where(eq(commitmentOccurrences.commitmentId, row.id))
        .orderBy(desc(commitmentOccurrences.dueDate))
        .limit(1);
      const schedule = scheduleOf(row);
      next = latest ? followingDueDate(schedule, latest.dueDate) : firstDueDate(schedule, todayFor(ctx));
      if (next) await this.materialise(tx, row, next);
    }
    const status: CommitmentStatus = next ? "active" : "ended";
    if (next === row.nextDueDate && status === row.status) return row;
    const [updated] = await tx.update(commitments).set({ nextDueDate: next, status }).where(eq(commitments.id, row.id)).returning();
    return updated as CommitmentRow;
  }

  // ------------------------------------------------------------------ reads

  joined(exec: Executor, where: SQL | undefined) {
    return exec
      .select({
        commitment: commitments,
        accountName: financialAccounts.name,
        categoryName: categories.name,
        categoryIcon: categories.icon,
        categoryColor: categories.color,
        projectName: projects.name,
        projectColor: projects.color,
        counterpartyName: counterparties.name,
        liabilityName: liabilities.name,
        subscriptionId: subscriptions.id,
        subscriptionStatus: subscriptions.status,
      })
      .from(commitments)
      .leftJoin(financialAccounts, eq(financialAccounts.id, commitments.accountId))
      .leftJoin(categories, eq(categories.id, commitments.categoryId))
      .leftJoin(projects, eq(projects.id, commitments.projectId))
      .leftJoin(counterparties, eq(counterparties.id, commitments.counterpartyId))
      .leftJoin(liabilities, eq(liabilities.id, commitments.liabilityId))
      .leftJoin(subscriptions, eq(subscriptions.commitmentId, commitments.id))
      .where(where)
      .orderBy(sql`${commitments.nextDueDate} asc nulls last`, asc(commitments.name));
  }

  async list(ctx: WorkspaceContext, raw: CommitmentQuery = {}) {
    const query = commitmentQuery.parse(raw);
    const where: SQL[] = [eq(commitments.workspaceId, ctx.workspaceId)];
    if (query.kind?.length) where.push(inArray(commitments.kind, query.kind));
    if (query.status?.length) where.push(inArray(commitments.status, query.status));
    if (query.direction) where.push(eq(commitments.direction, query.direction));
    if (query.projectId) where.push(eq(commitments.projectId, query.projectId));
    if (query.categoryId) where.push(eq(commitments.categoryId, query.categoryId));
    if (query.accountId) where.push(eq(commitments.accountId, query.accountId));
    if (query.subscriptions === "exclude") where.push(isNull(subscriptions.id));
    if (query.subscriptions === "only") where.push(isNotNull(subscriptions.id));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      where.push(
        or(ilike(commitments.name, needle), ilike(commitments.payee, needle), ilike(commitments.notes, needle), ilike(counterparties.name, needle)) as SQL,
      );
    }
    const rows = await this.joined(db, and(...where));
    const items = await this.views(ctx, rows);
    const monthlyOut = new Totals();
    const monthlyIn = new Totals();
    const annualOut = new Totals();
    const annualIn = new Totals();
    for (const item of items) {
      if (item.status !== "active") continue;
      const incoming = item.direction === "in";
      (incoming ? monthlyIn : monthlyOut).add(item.monthlyEquivalentBase, item.monthlyEquivalent, item.currency);
      (incoming ? annualIn : annualOut).add(item.annualizedBase, item.annualized, item.currency);
    }
    return {
      items,
      total: items.length,
      totals: {
        currency: ctx.baseCurrency,
        monthlyOut: monthlyOut.total,
        monthlyIn: monthlyIn.total,
        annualOut: annualOut.total,
        annualIn: annualIn.total,
        /** Active commitments with no exchange rate, per currency: monthly equivalent and annualized in that currency. */
        unconverted: [
          ...monthlyOut
            .unconvertedList()
            .map((u) => ({ currency: u.currency, monthly: u.amount, annual: annualOut.unconverted.get(u.currency) ?? 0, direction: "out" as const })),
          ...monthlyIn
            .unconvertedList()
            .map((u) => ({ currency: u.currency, monthly: u.amount, annual: annualIn.unconverted.get(u.currency) ?? 0, direction: "in" as const })),
        ],
      },
    };
  }

  async views(ctx: WorkspaceContext, rows: JoinedCommitment[], exec: Executor = db): Promise<CommitmentView[]> {
    const today = todayFor(ctx);
    const converter = new BaseConverter(this.fx, ctx, today, exec);
    const ids = rows.map((row) => row.commitment.id);
    const scheduled = ids.length
      ? await exec
          .select()
          .from(commitmentOccurrences)
          .where(and(inArray(commitmentOccurrences.commitmentId, ids), eq(commitmentOccurrences.status, "scheduled")))
          .orderBy(asc(commitmentOccurrences.dueDate))
      : [];
    const nextBy = new Map<string, OccurrenceRow>();
    for (const occurrence of scheduled) if (!nextBy.has(occurrence.commitmentId)) nextBy.set(occurrence.commitmentId, occurrence);

    return Promise.all(
      rows.map(async (row) => {
        const c = row.commitment;
        const schedule = scheduleOf(c);
        const monthly = monthlyEquivalent(c.amount, schedule);
        const yearly = annualized(c.amount, schedule);
        const next = c.status === "active" ? (nextBy.get(c.id) ?? null) : null;
        const due = next?.dueDate ?? (c.status === "active" ? c.nextDueDate : null);
        return {
          ...c,
          kindLabel: COMMITMENT_KIND_LABELS[c.kind],
          frequencyLabel: frequencyLabel(c),
          accountName: row.accountName,
          categoryName: row.categoryName,
          categoryIcon: row.categoryIcon,
          categoryColor: row.categoryColor,
          projectName: row.projectName,
          projectColor: row.projectColor,
          counterpartyName: row.counterpartyName,
          liabilityName: row.liabilityName,
          subscriptionId: row.subscriptionId,
          subscriptionStatus: row.subscriptionStatus,
          baseCurrency: ctx.baseCurrency,
          baseAmount: await converter.convert(c.amount, c.currency),
          monthlyEquivalent: monthly,
          monthlyEquivalentBase: await converter.convert(monthly, c.currency),
          annualized: yearly,
          annualizedBase: await converter.convert(yearly, c.currency),
          nextOccurrence: next ? { id: next.id, dueDate: next.dueDate, amount: next.amount, currency: next.currency, status: next.status } : null,
          daysUntilDue: due ? diffDays(today, due) : null,
          overdue: Boolean(due && due < today),
          effectiveReminderOffsets: reminderOffsetsFor(ctx, c),
          links: {
            self: row.subscriptionId ? links.subscription(row.subscriptionId) : links.commitment(c.id),
            commitment: links.commitment(c.id),
            subscription: row.subscriptionId ? links.subscription(row.subscriptionId) : null,
            transactions: links.transactions({ period: "all_time", commitmentId: c.id }),
          },
        };
      }),
    );
  }

  /** Every occurrence with its settling transaction and price changes, oldest first. */
  async history(ctx: WorkspaceContext, commitmentIds: string[], exec: Executor = db): Promise<Map<string, OccurrenceView[]>> {
    const result = new Map<string, OccurrenceView[]>();
    if (!commitmentIds.length) return result;
    const rows = await exec
      .select({
        occurrence: commitmentOccurrences,
        transaction: {
          id: transactions.id,
          type: transactions.type,
          direction: transactions.direction,
          status: transactions.status,
          date: transactions.date,
          amount: transactions.amount,
          currency: transactions.currency,
          baseAmount: transactions.baseAmount,
          baseCurrency: transactions.baseCurrency,
          accountId: transactions.accountId,
          merchant: transactions.merchant,
          source: transactions.source,
          metadata: transactions.metadata,
        },
        accountName: financialAccounts.name,
      })
      .from(commitmentOccurrences)
      .leftJoin(transactions, eq(transactions.id, commitmentOccurrences.transactionId))
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(eq(commitmentOccurrences.workspaceId, ctx.workspaceId), inArray(commitmentOccurrences.commitmentId, commitmentIds)))
      .orderBy(asc(commitmentOccurrences.dueDate));

    const today = todayFor(ctx);
    const lastPaid = new Map<string, OccurrenceRow>();
    for (const row of rows) {
      const o = row.occurrence;
      let priceChange: OccurrenceView["priceChange"] = null;
      if (o.status === "paid" && o.paidAmount !== null) {
        const previous = lastPaid.get(o.commitmentId);
        if (previous && previous.paidAmount !== null && previous.currency === o.currency) {
          const change = detectPriceChange(previous.paidAmount, o.paidAmount);
          if (change) priceChange = { ...change, previousOccurrenceId: previous.id, previousTransactionId: previous.transactionId };
        }
        lastPaid.set(o.commitmentId, o);
      }
      const t = row.transaction;
      const view: OccurrenceView = {
        ...o,
        overdue: o.status === "scheduled" && o.dueDate < today,
        daysUntil: diffDays(today, o.dueDate),
        transaction: t
          ? {
              id: t.id,
              type: t.type,
              direction: t.direction,
              status: t.status,
              date: t.date,
              amount: t.amount,
              currency: t.currency,
              baseAmount: t.baseAmount,
              baseCurrency: t.baseCurrency,
              accountId: t.accountId,
              accountName: row.accountName,
              merchant: t.merchant,
              source: t.source,
              createdByPayment: t.metadata?.origin === PAYMENT_ORIGIN && t.metadata?.occurrenceId === o.id,
              href: links.transaction(t.id),
            }
          : null,
        priceChange,
      };
      const list = result.get(o.commitmentId) ?? [];
      list.push(view);
      result.set(o.commitmentId, list);
    }
    return result;
  }

  /** The commitment with its occurrences (newest first) and the next projected due dates. */
  async detail(ctx: WorkspaceContext, id: string) {
    const [row] = await this.joined(db, and(eq(commitments.id, id), eq(commitments.workspaceId, ctx.workspaceId)));
    if (!row) throw notFound("Commitment");
    const [view] = await this.views(ctx, [row]);
    const occurrences = (await this.history(ctx, [id])).get(id) ?? [];
    return {
      ...(view as CommitmentView),
      occurrences: [...occurrences].reverse(),
      stats: occurrenceStats(occurrences, row.commitment),
      upcoming: projectDueDates(row.commitment, 6),
    };
  }
}

export function occurrenceStats(occurrences: OccurrenceView[], commitment: Pick<CommitmentRow, "currency">) {
  const paid = occurrences.filter((o) => o.status === "paid");
  return {
    paidCount: paid.length,
    skippedCount: occurrences.filter((o) => o.status === "skipped").length,
    scheduledCount: occurrences.filter((o) => o.status === "scheduled").length,
    /** In the commitment currency; payments in another currency are left out. */
    totalPaid: paid.reduce((total, o) => (o.currency === commitment.currency && o.paidAmount !== null ? total + o.paidAmount : total), 0),
    /** From the linked transactions, in the base currency. */
    totalPaidBase: paid.reduce((total, o) => (o.transaction && o.transaction.status !== "void" ? total + (o.transaction.baseAmount ?? 0) : total), 0),
    lastPaidOn: paid.reduce<Day | null>((latest, o) => (o.paidOn && (!latest || o.paidOn > latest) ? o.paidOn : latest), null),
    /** The transactions page listing every linked payment; null before the first one. */
    transactionsHref: links.payments(paid.map((o) => o.transactionId).filter((id): id is string => Boolean(id))),
  };
}

/** The next `count` due dates from the commitment's next due date on. */
export function projectDueDates(commitment: CommitmentRow, count: number): Array<{ date: Day; amount: number; currency: string }> {
  if (commitment.status !== "active" || !commitment.nextDueDate) return [];
  const schedule = scheduleOf(commitment);
  const dates: Day[] = [commitment.nextDueDate];
  while (dates.length < count) {
    const following = followingDueDate(schedule, dates[dates.length - 1] as Day);
    if (!following) break;
    dates.push(following);
  }
  return dates.map((date) => ({ date, amount: commitment.amount, currency: commitment.currency }));
}
