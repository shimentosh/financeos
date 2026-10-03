import { type Day, formatMoney, type ReceivableState, receivableInput, receivablePaymentInput, receivableState, receivableUpdate } from "@financeos/core";
import { type ReceivableQuery, receivableQuery } from "@financeos/core/contracts/wealth-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, ne, or, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { contextFor, todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { categories, counterparties, financialAccounts, inboxItems, projects, receivables, transactions, workspaces } from "../../db/schema/index.js";
import { CounterpartiesService } from "../ledger/catalog.service.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { EventsService } from "../system/events.service.js";
import { InboxService, NotificationsService } from "../system/notify.service.js";
import { linkedTransactionColumns } from "./assets.service.js";
import { LiabilitiesService } from "./liabilities.service.js";
import { mapSeries, RateBook, restate } from "./support.js";

export type ReceivableRow = typeof receivables.$inferSelect;
export type DatedPayment = { date: Day; amount: number; transactionId: string };
export type ReceivableWithPayments = {
  row: ReceivableRow;
  /** Money received against it, in its currency (refunds negative), oldest first. */
  payments: DatedPayment[];
  unconverted: number;
};
export type AgingBucket = "current" | "0-30" | "31-60" | "61-90" | "90+";

export type ReceivableView = ReceivableRow & {
  /** The status column; `status` is the state computed from payments and the due date. */
  storedStatus: ReceivableRow["status"];
  status: ReceivableState;
  paid: number;
  remaining: number;
  daysOverdue: number;
  baseAmount: number | null;
  baseRemaining: number | null;
  projectName: string | null;
  categoryName: string | null;
  lastPaymentDate: Day | null;
  /** Null once paid or cancelled. */
  agingBucket: AgingBucket | null;
  unconvertedPayments: number;
};

/** Overdue reminders go out once each at these ages. */
export const OVERDUE_MILESTONES = [1, 7, 30] as const;
export const RECEIVABLES_JOB = "wealth.receivables-overdue";

export function agingBucket(state: ReceivableState, daysOverdue: number): AgingBucket | null {
  if (state === "paid" || state === "cancelled") return null;
  if (state !== "overdue") return "current";
  if (daysOverdue <= 30) return "0-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

/** What was still owed on a past day; null before it was issued. */
export function receivableRemainingAsOf(item: ReceivableWithPayments, asOf: Day): number | null {
  if (item.row.issueDate > asOf) return null;
  const paid = item.payments.filter((payment) => payment.date <= asOf).reduce((acc, payment) => acc + payment.amount, 0);
  return Math.max(0, item.row.amount - paid);
}

@Injectable()
export class ReceivablesService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(CounterpartiesService) private readonly counterparties: CounterpartiesService,
    @Inject(FxService) private readonly fx: FxService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(LiabilitiesService) private readonly liabilities: LiabilitiesService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<ReceivableRow> {
    const [row] = await exec
      .select()
      .from(receivables)
      .where(and(eq(receivables.id, id), eq(receivables.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Receivable");
  }

  /**
   * Payments: `income` (invoices) and `debt_payment` in (money lent) linked to
   * the receivable; a `refund` out linked to it gives money back. The lending
   * itself (`loan` out) is not a payment.
   */
  async withPayments(ctx: WorkspaceContext, rows: ReceivableRow[], exec: Executor = db): Promise<ReceivableWithPayments[]> {
    if (!rows.length) return [];
    const linked = await exec
      .select({
        id: transactions.id,
        receivableId: transactions.receivableId,
        type: transactions.type,
        direction: transactions.direction,
        amount: transactions.amount,
        currency: transactions.currency,
        baseAmount: transactions.baseAmount,
        baseCurrency: transactions.baseCurrency,
        date: transactions.date,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          inArray(
            transactions.receivableId,
            rows.map((row) => row.id),
          ),
          eq(transactions.status, "posted"),
          inArray(transactions.type, ["income", "debt_payment", "refund"]),
        ),
      )
      .orderBy(asc(transactions.date), asc(transactions.createdAt));
    const rates = new RateBook(this.fx, ctx.workspaceId, exec);
    return mapSeries(rows, async (row) => {
      const payments: DatedPayment[] = [];
      let unconverted = 0;
      for (const tx of linked.filter((candidate) => candidate.receivableId === row.id)) {
        const sign = tx.direction === "in" ? 1 : tx.type === "refund" ? -1 : 0;
        if (sign === 0) continue;
        const restated = await restate(tx, row.currency, rates);
        if (!restated) {
          unconverted += 1;
          continue;
        }
        payments.push({ date: tx.date, amount: sign * restated.amount, transactionId: tx.id });
      }
      return { row, payments, unconverted };
    });
  }

  private async views(ctx: WorkspaceContext, rows: ReceivableRow[], exec: Executor = db, day: Day = todayFor(ctx)): Promise<ReceivableView[]> {
    if (!rows.length) return [];
    const rates = new RateBook(this.fx, ctx.workspaceId, exec);
    const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id)))];
    const categoryIds = [...new Set(rows.map((row) => row.categoryId).filter((id): id is string => Boolean(id)))];
    const loaded = await this.withPayments(ctx, rows, exec);
    const projectRows = projectIds.length
      ? await exec.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
      : [];
    const categoryRows = categoryIds.length
      ? await exec.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, categoryIds))
      : [];
    const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
    const categoryNames = new Map(categoryRows.map((row) => [row.id, row.name]));
    return mapSeries(loaded, async ({ row, payments, unconverted }) => {
      const paid = payments.reduce((acc, payment) => acc + payment.amount, 0);
      const state = receivableState({ amount: row.amount, paid, dueDate: row.dueDate, cancelled: row.status === "cancelled", today: day });
      return {
        ...row,
        storedStatus: row.status,
        status: state.state,
        paid,
        remaining: state.remaining,
        daysOverdue: state.daysOverdue,
        baseAmount: await rates.convert(row.amount, row.currency, ctx.baseCurrency, day),
        baseRemaining: await rates.convert(state.remaining, row.currency, ctx.baseCurrency, day),
        projectName: projectNames.get(row.projectId ?? "") ?? null,
        categoryName: categoryNames.get(row.categoryId ?? "") ?? null,
        lastPaymentDate: [...payments].reverse().find((payment) => payment.amount > 0)?.date ?? null,
        agingBucket: agingBucket(state.state, state.daysOverdue),
        unconvertedPayments: unconverted,
      };
    });
  }

  /** Receivable views, filtered in the database by the given fields first. */
  async find(
    ctx: WorkspaceContext,
    filter: { ids?: string[]; kinds?: ReceivableRow["kind"][]; counterpartyId?: string | null; projectId?: string | null; q?: string } = {},
    exec: Executor = db,
    day?: Day,
  ): Promise<ReceivableView[]> {
    const where: Array<SQL | undefined> = [
      eq(receivables.workspaceId, ctx.workspaceId),
      filter.ids?.length ? inArray(receivables.id, filter.ids) : undefined,
      filter.kinds?.length ? inArray(receivables.kind, filter.kinds) : undefined,
      filter.counterpartyId ? eq(receivables.counterpartyId, filter.counterpartyId) : undefined,
      filter.projectId ? eq(receivables.projectId, filter.projectId) : undefined,
    ];
    if (filter.q) {
      const needle = `%${filter.q.replace(/[%_]/g, "\\$&")}%`;
      where.push(or(ilike(receivables.title, needle), ilike(receivables.counterpartyName, needle), ilike(receivables.reference, needle)));
    }
    const rows = await exec
      .select()
      .from(receivables)
      .where(and(...where))
      .orderBy(asc(receivables.dueDate), desc(receivables.issueDate));
    return this.views(ctx, rows, exec, day);
  }

  /** Receivables with computed state, filters, and totals by status and age. */
  async list(ctx: WorkspaceContext, raw: ReceivableQuery = {}) {
    const query = receivableQuery.parse(raw);
    let items = await this.find(ctx, { kinds: query.kind, counterpartyId: query.counterpartyId, projectId: query.projectId, q: query.q });
    if (query.status?.length) items = items.filter((item) => query.status?.includes(item.status));
    if (query.overdue !== undefined) items = items.filter((item) => (item.status === "overdue") === query.overdue);
    return { items, totals: this.totals(ctx, items), unconvertible: this.unconvertible(items) };
  }

  private unconvertible(items: ReceivableView[]) {
    return items
      .filter((item) => item.baseRemaining === null)
      .map((item) => ({ id: item.id, title: item.title, currency: item.currency, remaining: item.remaining }));
  }

  private totals(ctx: WorkspaceContext, items: ReceivableView[]) {
    const byStatus: Record<ReceivableState, { count: number; amount: number; outstanding: number }> = {
      pending: { count: 0, amount: 0, outstanding: 0 },
      partially_paid: { count: 0, amount: 0, outstanding: 0 },
      overdue: { count: 0, amount: 0, outstanding: 0 },
      paid: { count: 0, amount: 0, outstanding: 0 },
      cancelled: { count: 0, amount: 0, outstanding: 0 },
    };
    const aging: Record<AgingBucket, number> = { current: 0, "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    let outstanding = 0;
    for (const item of items) {
      const bucket = byStatus[item.status];
      bucket.count += 1;
      bucket.amount += item.baseAmount ?? 0;
      if (item.status === "cancelled") continue;
      bucket.outstanding += item.baseRemaining ?? 0;
      outstanding += item.baseRemaining ?? 0;
      if (item.agingBucket) aging[item.agingBucket] += item.baseRemaining ?? 0;
    }
    return {
      currency: ctx.baseCurrency,
      count: items.length,
      outstanding,
      overdueAmount: byStatus.overdue.outstanding,
      overdueCount: byStatus.overdue.count,
      byStatus,
      aging,
    };
  }

  async detail(ctx: WorkspaceContext, id: string) {
    const [view] = await this.find(ctx, { ids: [id] });
    if (!view) await this.get(ctx, id);
    return { ...(view as ReceivableView), transactions: await this.linkedTransactions(ctx, id) };
  }

  linkedTransactions(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    return exec
      .select(linkedTransactionColumns)
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.receivableId, id), ne(transactions.status, "void")))
      .orderBy(desc(transactions.date), desc(transactions.createdAt));
  }

  private async checkCategory(exec: Executor, ctx: WorkspaceContext, categoryId: string | null | undefined) {
    if (!categoryId) return;
    await assertInWorkspace(exec, categories, ctx.workspaceId, [categoryId], "Category");
    const [category] = await exec.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId));
    if (category?.kind !== "income") throw unprocessable("A receivable's category must be an income category", "category_kind_mismatch");
  }

  /** Stores the computed state when it changed; resolves overdue reminders once settled. */
  private async persistStatus(tx: Executor, ctx: WorkspaceContext, id: string, day?: Day) {
    const [view] = await this.find(ctx, { ids: [id] }, tx, day);
    if (!view) return view;
    if (view.status !== view.storedStatus) await tx.update(receivables).set({ status: view.status }).where(eq(receivables.id, id));
    if (view.status === "paid" || view.status === "cancelled") {
      await this.inbox.resolveForEntity(ctx.workspaceId, id, ["receivable_overdue"], ctx.userId, tx);
    }
    return view;
  }

  /** Invoices, and money lent (`lentFromAccountId` records it leaving that account as a `loan` out). */
  async create(ctx: WorkspaceContext, raw: z.input<typeof receivableInput>) {
    const input = receivableInput.parse(raw);
    if (input.lentFromAccountId && input.kind === "invoice") {
      throw unprocessable("Money lent is a loan receivable, not an invoice", "invalid_kind");
    }
    if (input.dueDate && input.dueDate < input.issueDate) throw unprocessable("The due date is before the issue date", "invalid_due_date");
    const id = await db.transaction(async (tx) => {
      await assertInWorkspace(tx, counterparties, ctx.workspaceId, [input.counterpartyId], "Counterparty");
      await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.lentFromAccountId], "Account");
      await this.checkCategory(tx, ctx, input.categoryId);
      const { lentFromAccountId, ...fields } = input;
      const counterpartyId =
        fields.counterpartyId ??
        (await this.counterparties.findOrCreate(tx, ctx.workspaceId, fields.counterpartyName, fields.kind === "invoice" ? "customer" : "person"))?.id ??
        null;
      const [row] = await tx
        .insert(receivables)
        .values({ workspaceId: ctx.workspaceId, ...fields, counterpartyId, source: "manual" })
        .returning();
      const receivable = assertFound(row, "Receivable");
      let lendingTransactionId: string | null = null;
      if (lentFromAccountId) {
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "loan",
            direction: "out",
            accountId: lentFromAccountId,
            amount: receivable.amount,
            currency: receivable.currency,
            date: receivable.issueDate,
            receivableId: receivable.id,
            counterpartyId,
            projectId: receivable.projectId,
            description: `Lent to ${receivable.counterpartyName}: ${receivable.title}`,
          },
          { exec: tx, metadata: { receivableId: receivable.id } },
        );
        lendingTransactionId = transaction.id;
      }
      await this.persistStatus(tx, ctx, receivable.id);
      await this.audit.record(tx, ctx, {
        action: "receivable.created",
        entityType: "receivable",
        entityId: receivable.id,
        after: { ...receivable, lendingTransactionId },
      });
      return receivable.id;
    });
    return this.detail(ctx, id);
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof receivableUpdate>) {
    const input = receivableUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      await assertInWorkspace(tx, counterparties, ctx.workspaceId, [input.counterpartyId], "Counterparty");
      await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
      await this.checkCategory(tx, ctx, input.categoryId);
      const [current] = await this.find(ctx, { ids: [id] }, tx);
      if (input.currency && input.currency !== before.currency) {
        const [used] = await this.linkedTransactions(ctx, id, tx).limit(1);
        if (used) throw conflict("The currency of a receivable with payments cannot change", "currency_locked");
      }
      if (input.amount !== undefined && current && input.amount < current.paid) {
        throw unprocessable(`${current.paid} has already been received; the amount cannot be less`, "amount_below_paid");
      }
      const issueDate = input.issueDate ?? before.issueDate;
      const dueDate = input.dueDate === undefined ? before.dueDate : input.dueDate;
      if (dueDate && dueDate < issueDate) throw unprocessable("The due date is before the issue date", "invalid_due_date");
      const { status, ...fields } = input;
      if (fields.counterpartyName && fields.counterpartyId === undefined && fields.counterpartyName !== before.counterpartyName) {
        fields.counterpartyId =
          (
            await this.counterparties.findOrCreate(
              tx,
              ctx.workspaceId,
              fields.counterpartyName,
              (fields.kind ?? before.kind) === "invoice" ? "customer" : "person",
            )
          )?.id ?? null;
      }
      // Cancelling is stored; "pending" un-cancels and the state is recomputed.
      const changes = { ...fields, ...(status ? { status } : {}) };
      if (Object.keys(changes).length) await tx.update(receivables).set(changes).where(eq(receivables.id, id));
      await this.persistStatus(tx, ctx, id);
      await this.audit.record(tx, ctx, { action: "receivable.updated", entityType: "receivable", entityId: id, before, after: await this.get(ctx, id, tx) });
    });
    return this.detail(ctx, id);
  }

  async remove(ctx: WorkspaceContext, id: string, options: { voidLinked?: boolean } = {}) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const linked = await this.linkedTransactions(ctx, id, tx);
      if (linked.length && !options.voidLinked) {
        throw conflict(
          `${before.title} has ${linked.length} linked transaction${linked.length === 1 ? "" : "s"}. Void them too, or cancel it instead.`,
          "has_transactions",
          linked.map((row) => ({ path: "transactionId", message: row.id })),
        );
      }
      for (const row of linked) await this.transactions.void(ctx, row.id, `Receivable ${before.title} deleted`, { exec: tx });
      await this.inbox.resolveForEntity(ctx.workspaceId, id, ["receivable_overdue"], ctx.userId, tx);
      await tx.delete(receivables).where(eq(receivables.id, id));
      await this.audit.record(tx, ctx, {
        action: "receivable.deleted",
        entityType: "receivable",
        entityId: id,
        before,
        after: { voidedTransactionIds: linked.map((row) => row.id) },
      });
      return { deleted: true, voidedTransactionIds: linked.map((row) => row.id) };
    });
  }

  /**
   * Records money received. An invoice is paid by `income` (revenue on a cash
   * basis, in the invoice's category and project); money lent is collected by
   * a `debt_payment` in. Both link the receivable.
   */
  async pay(ctx: WorkspaceContext, id: string, raw: z.input<typeof receivablePaymentInput>) {
    const input = receivablePaymentInput.parse(raw);
    const transactionId = await db.transaction(async (tx) => {
      const receivable = await this.get(ctx, id, tx);
      if (receivable.status === "cancelled") throw conflict(`${receivable.title} is cancelled`, "receivable_cancelled");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.accountId], "Account");
      const [before] = await this.find(ctx, { ids: [id] }, tx);
      const remaining = before?.remaining ?? 0;
      if (remaining <= 0) throw conflict(`${receivable.title} is already paid`, "already_paid");
      if (input.amount > remaining) {
        throw unprocessable(`That is more than the ${remaining} still owed`, "payment_exceeds_remaining");
      }
      const invoice = receivable.kind === "invoice";
      const { transaction } = await this.transactions.create(
        ctx,
        {
          type: invoice ? "income" : "debt_payment",
          direction: "in",
          accountId: input.accountId,
          amount: input.amount,
          currency: receivable.currency,
          date: input.date,
          receivableId: id,
          counterpartyId: receivable.counterpartyId,
          projectId: receivable.projectId,
          categoryId: invoice ? receivable.categoryId : null,
          reference: input.reference ?? null,
          description: `Payment: ${receivable.title}`,
          notes: input.note ?? null,
          attachmentFileIds: input.attachmentFileIds,
        },
        { exec: tx, metadata: { receivableId: id } },
      );
      const after = await this.persistStatus(tx, ctx, id);
      await this.audit.record(tx, ctx, {
        action: "receivable.payment_recorded",
        entityType: "receivable",
        entityId: id,
        before: { paid: before?.paid, status: before?.status },
        after: { paid: after?.paid, status: after?.status, transactionId: transaction.id, amount: input.amount },
      });
      return transaction.id;
    });
    return { transaction: await this.transactions.get(ctx, transactionId), receivable: await this.detail(ctx, id) };
  }

  /**
   * The daily overdue pass for one workspace: stores computed states, and for
   * each overdue receivable that reached a new milestone (1, 7, 30 days)
   * opens an inbox item, notifies members and publishes `invoice.overdue` —
   * once per receivable per milestone, however often it runs.
   */
  async scanOverdue(workspaceId: string, asOf?: Day) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace) return { checked: 0, overdue: 0, notified: 0, statusesUpdated: 0, liabilityStatusesUpdated: 0 };
    const ctx = contextFor(workspace, { userId: null, actorType: "system" });
    const day = asOf ?? todayFor(ctx);
    const items = await this.find(ctx, {}, db, day);
    let statusesUpdated = 0;
    let notified = 0;
    let overdue = 0;

    for (const item of items) {
      if (item.status !== item.storedStatus) {
        await db.update(receivables).set({ status: item.status }).where(eq(receivables.id, item.id));
        statusesUpdated += 1;
      }
      if (item.status === "paid" || item.status === "cancelled") {
        await this.inbox.resolveForEntity(ctx.workspaceId, item.id, ["receivable_overdue"], null);
        continue;
      }
      if (item.status !== "overdue") continue;
      overdue += 1;
      const milestone = [...OVERDUE_MILESTONES].reverse().find((m) => item.daysOverdue >= m);
      if (!milestone) continue;
      const key = (m: number) => `receivable_overdue:${item.id}:${m}`;
      const created = await db.transaction(async (tx) => {
        const [seen] = await tx
          .select({ id: inboxItems.id })
          .from(inboxItems)
          .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.dedupeKey, key(milestone))))
          .limit(1);
        if (seen) return false;
        // One open reminder per receivable: the new milestone supersedes the last.
        for (const earlier of OVERDUE_MILESTONES.filter((m) => m < milestone)) {
          await this.inbox.resolveByKey(ctx.workspaceId, key(earlier), null, tx);
        }
        const owed = formatMoney(item.remaining, item.currency);
        const what = item.kind === "invoice" ? `${item.title}${item.reference ? ` (${item.reference})` : ""}` : item.title;
        const title = `${what} is ${item.daysOverdue} day${item.daysOverdue === 1 ? "" : "s"} overdue`;
        const body = `${item.counterpartyName} still owes ${owed}, due ${item.dueDate}.`;
        const severity = milestone >= 30 ? ("critical" as const) : ("warning" as const);
        const href = `/wealth/receivables?focus=${item.id}`;
        await this.inbox.upsert(
          {
            workspaceId: ctx.workspaceId,
            kind: "receivable_overdue",
            severity,
            title,
            body,
            data: { receivableId: item.id, amount: item.remaining, currency: item.currency, daysOverdue: item.daysOverdue, milestone, href },
            entityType: "receivable",
            entityId: item.id,
            dedupeKey: key(milestone),
          },
          tx,
        );
        await this.notifications.notify(
          {
            workspaceId: ctx.workspaceId,
            kind: "receivable_overdue",
            severity,
            title,
            body,
            link: href,
            entityType: "receivable",
            entityId: item.id,
            dedupeKey: key(milestone),
          },
          tx,
        );
        await this.events.publish(tx, ctx, "invoice.overdue", {
          receivableId: item.id,
          kind: item.kind,
          title: item.title,
          counterpartyId: item.counterpartyId,
          counterpartyName: item.counterpartyName,
          dueDate: item.dueDate,
          daysOverdue: item.daysOverdue,
          milestone,
          remaining: item.remaining,
          currency: item.currency,
          projectId: item.projectId,
        });
        return true;
      });
      if (created) notified += 1;
    }

    const liabilityStatusesUpdated = await this.liabilities.syncStatuses(ctx);
    return { checked: items.length, overdue, notified, statusesUpdated, liabilityStatusesUpdated };
  }
}
