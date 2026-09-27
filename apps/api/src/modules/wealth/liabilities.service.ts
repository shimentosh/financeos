import {
  addDays,
  type Day,
  type DebtFlow,
  diffDays,
  type LiabilityKind,
  liabilityInput,
  liabilityOutstanding,
  liabilityUpdate,
  uuidv7,
} from "@expensewise/core";
import {
  type LiabilityPaymentRequest,
  type LiabilityQuery,
  liabilityPaymentRequest,
  liabilityQuery,
  type PayablesQuery,
  payablesQuery,
} from "@expensewise/core/contracts/wealth-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { categories, commitments, counterparties, financialAccounts, liabilities, projects, transactions } from "../../db/schema/index.js";
import { CounterpartiesService, type CounterpartyRow } from "../ledger/catalog.service.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { CommitmentsService } from "../planning/commitments.service.js";
import { AuditService } from "../system/audit.service.js";
import { linkedTransactionColumns } from "./assets.service.js";
import { dayOf, ensureCategory, mapSeries, RateBook, restate } from "./support.js";

export type LiabilityRow = typeof liabilities.$inferSelect;
export type LiabilityStatus = LiabilityRow["status"];
export type DatedDebtFlow = DebtFlow & { date: Day; transactionId: string };
export type LiabilityWithFlows = {
  row: LiabilityRow;
  /** Posted loan / debt_payment / expense transactions linked to it, in its currency, oldest first. */
  flows: DatedDebtFlow[];
  /** Interest expenses recorded with its payments (not part of the outstanding). */
  interestPaid: number;
  unconverted: number;
};

export type LiabilityView = LiabilityRow & {
  /** The status column; `status` is recomputed from payments and the due date. */
  storedStatus: LiabilityStatus;
  outstanding: number;
  paid: number;
  borrowed: number;
  /** Everything owed over its life: opening outstanding plus later borrowing. */
  total: number;
  interestPaid: number;
  baseOutstanding: number | null;
  daysOverdue: number;
  lastPaymentDate: Day | null;
  /** Display name: the counterparty's name, or the free-text name. */
  counterparty: string | null;
  categoryName: string | null;
  projectName: string | null;
  unconvertedFlows: number;
};

/** Kinds shown on the Payables page: bills and debts owed to people and businesses. */
export const PAYABLE_KINDS: LiabilityKind[] = ["payable", "personal_debt", "business_debt"];

const COUNTERPARTY_KIND: Record<LiabilityKind, CounterpartyRow["kind"]> = {
  payable: "vendor",
  business_debt: "vendor",
  personal_debt: "person",
  loan: "institution",
  mortgage: "institution",
  credit: "institution",
  other: "other",
};

/** paid_off and overdue follow from the numbers; only `cancelled` is a decision. */
export function liabilityStatusFor(row: Pick<LiabilityRow, "status" | "dueDate">, outstanding: number, day: Day): LiabilityStatus {
  if (row.status === "cancelled") return "cancelled";
  if (outstanding <= 0) return "paid_off";
  if (row.dueDate && row.dueDate < day) return "overdue";
  return "active";
}

export function liabilityStart(row: LiabilityRow, timezone: string): Day {
  return row.startDate ?? dayOf(row.createdAt, timezone);
}

/** Outstanding on a past day; null when the debt did not exist yet. */
export function liabilityOutstandingAsOf(item: LiabilityWithFlows, asOf: Day, timezone: string): number | null {
  const start = liabilityStart(item.row, timezone);
  const flows = item.flows.filter((flow) => flow.date <= asOf);
  if (start > asOf && !flows.length) return null;
  return liabilityOutstanding(start <= asOf ? item.row.openingOutstanding : 0, flows).outstanding;
}

@Injectable()
export class LiabilitiesService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(CounterpartiesService) private readonly counterparties: CounterpartiesService,
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<LiabilityRow> {
    const [row] = await exec
      .select()
      .from(liabilities)
      .where(and(eq(liabilities.id, id), eq(liabilities.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Liability");
  }

  /** Loads each liability's posted flows and interest, restated in its currency. */
  async withFlows(ctx: WorkspaceContext, rows: LiabilityRow[], exec: Executor = db): Promise<LiabilityWithFlows[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const metaLiability = sql<string>`${transactions.metadata}->>'liabilityId'`;
    const linked = await exec
      .select({
        id: transactions.id,
        liabilityId: transactions.liabilityId,
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
          inArray(transactions.liabilityId, ids),
          eq(transactions.status, "posted"),
          inArray(transactions.type, ["loan", "debt_payment", "expense"]),
        ),
      )
      .orderBy(asc(transactions.date), asc(transactions.createdAt));
    const interest = await exec
      .select({
        liabilityId: metaLiability,
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
          eq(transactions.status, "posted"),
          eq(transactions.type, "expense"),
          isNull(transactions.liabilityId),
          inArray(metaLiability, ids),
        ),
      );
    const rates = new RateBook(this.fx, ctx.workspaceId, exec);
    return mapSeries(rows, async (row) => {
      const flows: DatedDebtFlow[] = [];
      let unconverted = 0;
      for (const tx of linked.filter((candidate) => candidate.liabilityId === row.id)) {
        const restated = await restate(tx, row.currency, rates);
        if (!restated) {
          unconverted += 1;
          continue;
        }
        flows.push({ type: tx.type as DebtFlow["type"], direction: tx.direction, amount: restated.amount, date: tx.date, transactionId: tx.id });
      }
      let interestPaid = 0;
      for (const tx of interest.filter((candidate) => candidate.liabilityId === row.id)) {
        const restated = await restate(tx, row.currency, rates);
        if (restated) interestPaid += restated.amount;
        else unconverted += 1;
      }
      return { row, flows, interestPaid, unconverted };
    });
  }

  private async views(ctx: WorkspaceContext, rows: LiabilityRow[], exec: Executor = db): Promise<LiabilityView[]> {
    if (!rows.length) return [];
    const day = todayFor(ctx);
    const rates = new RateBook(this.fx, ctx.workspaceId, exec);
    const loaded = await this.withFlows(ctx, rows, exec);
    const names = await this.names(ctx, rows, exec);
    return mapSeries(loaded, async ({ row, flows, interestPaid, unconverted }) => {
      const state = liabilityOutstanding(row.openingOutstanding, flows);
      const status = liabilityStatusFor(row, state.outstanding, day);
      const lastPayment = [...flows].reverse().find((flow) => flow.direction === "out");
      return {
        ...row,
        storedStatus: row.status,
        status,
        outstanding: state.outstanding,
        paid: state.paid,
        borrowed: state.borrowed,
        total: row.openingOutstanding + state.borrowed,
        interestPaid,
        baseOutstanding: await rates.convert(state.outstanding, row.currency, ctx.baseCurrency, day),
        daysOverdue: status === "overdue" && row.dueDate ? diffDays(row.dueDate, day) : 0,
        lastPaymentDate: lastPayment?.date ?? null,
        counterparty: names.counterparties.get(row.counterpartyId ?? "") ?? row.counterpartyName ?? null,
        categoryName: names.categories.get(row.categoryId ?? "") ?? null,
        projectName: names.projects.get(row.projectId ?? "") ?? null,
        unconvertedFlows: unconverted,
      };
    });
  }

  private async names(ctx: WorkspaceContext, rows: LiabilityRow[], exec: Executor) {
    const pick = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => Boolean(value)))];
    const counterpartyIds = pick(rows.map((row) => row.counterpartyId));
    const categoryIds = pick(rows.map((row) => row.categoryId));
    const projectIds = pick(rows.map((row) => row.projectId));
    const ws = ctx.workspaceId;
    const cps = counterpartyIds.length
      ? await exec
          .select({ id: counterparties.id, name: counterparties.name })
          .from(counterparties)
          .where(and(eq(counterparties.workspaceId, ws), inArray(counterparties.id, counterpartyIds)))
      : [];
    const cats = categoryIds.length
      ? await exec
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(and(eq(categories.workspaceId, ws), inArray(categories.id, categoryIds)))
      : [];
    const projs = projectIds.length
      ? await exec
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.workspaceId, ws), inArray(projects.id, projectIds)))
      : [];
    return {
      counterparties: new Map(cps.map((row) => [row.id, row.name])),
      categories: new Map(cats.map((row) => [row.id, row.name])),
      projects: new Map(projs.map((row) => [row.id, row.name])),
    };
  }

  /** Liability views for the workspace (all, or filtered in the database first). */
  async find(
    ctx: WorkspaceContext,
    filter: { kinds?: LiabilityKind[]; projectId?: string | null; counterpartyId?: string | null; ids?: string[] } = {},
    exec: Executor = db,
  ) {
    const rows = await exec
      .select()
      .from(liabilities)
      .where(
        and(
          eq(liabilities.workspaceId, ctx.workspaceId),
          filter.kinds?.length ? inArray(liabilities.kind, filter.kinds) : undefined,
          filter.projectId ? eq(liabilities.projectId, filter.projectId) : undefined,
          filter.counterpartyId ? eq(liabilities.counterpartyId, filter.counterpartyId) : undefined,
          filter.ids?.length ? inArray(liabilities.id, filter.ids) : undefined,
        ),
      )
      .orderBy(asc(liabilities.dueDate), asc(liabilities.name));
    return this.views(ctx, rows, exec);
  }

  /** All liabilities with computed status and outstanding, grouped by kind, with totals. */
  async list(ctx: WorkspaceContext, raw: LiabilityQuery = {}) {
    const query = liabilityQuery.parse(raw);
    let items = await this.find(ctx, { kinds: query.kind, projectId: query.projectId, counterpartyId: query.counterpartyId });
    if (query.status?.length) items = items.filter((item) => query.status?.includes(item.status));
    const open = items.filter((item) => item.status !== "cancelled");
    const groups = new Map<string, { kind: string; count: number; outstanding: number; overdueCount: number }>();
    for (const item of open) {
      const group = groups.get(item.kind) ?? { kind: item.kind, count: 0, outstanding: 0, overdueCount: 0 };
      group.count += 1;
      group.outstanding += Math.max(0, item.baseOutstanding ?? 0);
      if (item.status === "overdue") group.overdueCount += 1;
      groups.set(item.kind, group);
    }
    const overdue = open.filter((item) => item.status === "overdue");
    return {
      items,
      groups: [...groups.values()].sort((a, b) => b.outstanding - a.outstanding),
      totals: {
        currency: ctx.baseCurrency,
        count: open.length,
        outstanding: open.reduce((acc, item) => acc + Math.max(0, item.baseOutstanding ?? 0), 0),
        overdueCount: overdue.length,
        overdueOutstanding: overdue.reduce((acc, item) => acc + Math.max(0, item.baseOutstanding ?? 0), 0),
      },
      unconvertible: items
        .filter((item) => item.baseOutstanding === null)
        .map((item) => ({ id: item.id, name: item.name, currency: item.currency, outstanding: item.outstanding })),
    };
  }

  /** Bills and debts owed to people and businesses, with what is paid and left. */
  async payables(ctx: WorkspaceContext, raw: PayablesQuery = {}) {
    const query = payablesQuery.parse(raw);
    const day = todayFor(ctx);
    let views = await this.find(ctx, { kinds: PAYABLE_KINDS, projectId: query.projectId, counterpartyId: query.counterpartyId });
    if (query.status?.length) views = views.filter((item) => query.status?.includes(item.status));
    if (query.overdue !== undefined) views = views.filter((item) => (item.status === "overdue") === query.overdue);
    const items = views.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      counterpartyId: item.counterpartyId,
      counterparty: item.counterparty,
      dueDate: item.dueDate,
      currency: item.currency,
      amount: item.total,
      paid: item.paid,
      remaining: Math.max(0, item.outstanding),
      baseRemaining: item.baseOutstanding === null ? null : Math.max(0, item.baseOutstanding),
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      projectId: item.projectId,
      projectName: item.projectName,
      status: item.status,
      daysOverdue: item.daysOverdue,
      lastPaymentDate: item.lastPaymentDate,
      notes: item.notes,
    }));
    const open = items.filter((item) => item.status !== "cancelled" && item.status !== "paid_off");
    const soon = addDays(day, 30);
    const sum = (list: typeof items) => list.reduce((acc, item) => acc + (item.baseRemaining ?? 0), 0);
    return {
      items,
      totals: {
        currency: ctx.baseCurrency,
        count: open.length,
        remaining: sum(open),
        overdue: sum(open.filter((item) => item.status === "overdue")),
        overdueCount: open.filter((item) => item.status === "overdue").length,
        dueNext30Days: sum(open.filter((item) => item.status !== "overdue" && item.dueDate !== null && item.dueDate <= soon)),
      },
      unconvertible: items
        .filter((item) => item.baseRemaining === null)
        .map((item) => ({ id: item.id, name: item.name, currency: item.currency, remaining: item.remaining })),
    };
  }

  async detail(ctx: WorkspaceContext, id: string) {
    const row = await this.get(ctx, id);
    const [view] = await this.views(ctx, [row]);
    const [linked, schedules] = await Promise.all([
      this.linkedTransactions(ctx, id),
      db
        .select({
          id: commitments.id,
          name: commitments.name,
          kind: commitments.kind,
          amount: commitments.amount,
          currency: commitments.currency,
          frequency: commitments.frequency,
          nextDueDate: commitments.nextDueDate,
          status: commitments.status,
          autoPay: commitments.autoPay,
        })
        .from(commitments)
        .where(and(eq(commitments.workspaceId, ctx.workspaceId), eq(commitments.liabilityId, id))),
    ]);
    const nextDueDate =
      schedules
        .filter((schedule) => schedule.status === "active" && schedule.nextDueDate)
        .map((schedule) => schedule.nextDueDate as string)
        .sort()[0] ?? null;
    return { ...(view as LiabilityView), transactions: linked, commitments: schedules, nextDueDate };
  }

  /** Transactions for the liability: those linked to it, and the interest paid with them. */
  linkedTransactions(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    return exec
      .select(linkedTransactionColumns)
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          ne(transactions.status, "void"),
          or(eq(transactions.liabilityId, id), sql`${transactions.metadata}->>'liabilityId' = ${id}`),
        ),
      )
      .orderBy(desc(transactions.date), desc(transactions.createdAt));
  }

  private async checkCategory(exec: Executor, ctx: WorkspaceContext, categoryId: string | null | undefined) {
    if (!categoryId) return;
    await assertInWorkspace(exec, categories, ctx.workspaceId, [categoryId], "Category");
    const [category] = await exec.select({ kind: categories.kind }).from(categories).where(eq(categories.id, categoryId));
    if (category?.kind !== "expense") throw unprocessable("A liability's category must be an expense category", "category_kind_mismatch");
  }

  /** Stores the computed status when it changed. */
  private async persistStatus(tx: Executor, ctx: WorkspaceContext, id: string) {
    const [view] = await this.find(ctx, { ids: [id] }, tx);
    if (view && view.status !== view.storedStatus) {
      await tx.update(liabilities).set({ status: view.status }).where(eq(liabilities.id, id));
    }
    return view;
  }

  /** Stores computed statuses for the whole workspace (daily job). Returns how many changed. */
  async syncStatuses(ctx: WorkspaceContext, exec: Executor = db): Promise<number> {
    const views = await this.find(ctx, {}, exec);
    let changed = 0;
    for (const view of views) {
      if (view.status === view.storedStatus) continue;
      await exec
        .update(liabilities)
        .set({ status: view.status })
        .where(and(eq(liabilities.id, view.id), eq(liabilities.workspaceId, ctx.workspaceId)));
      changed += 1;
    }
    return changed;
  }

  /**
   * Adds a liability. `receivedIntoAccountId` records the borrowed principal
   * as a `loan` in; the stored opening outstanding is then reduced by the
   * principal (never below zero) so the outstanding is what was stated, not
   * twice it. `schedule` creates a loan-payment commitment.
   */
  async create(ctx: WorkspaceContext, raw: z.input<typeof liabilityInput>) {
    const input = liabilityInput.parse(raw);
    const day = todayFor(ctx);
    const id = await db.transaction(async (tx) => {
      await assertInWorkspace(tx, counterparties, ctx.workspaceId, [input.counterpartyId], "Counterparty");
      await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.accountId, input.receivedIntoAccountId], "Account");
      await this.checkCategory(tx, ctx, input.categoryId);
      const { receivedIntoAccountId, schedule, ...fields } = input;
      let counterpartyId = fields.counterpartyId ?? null;
      let counterpartyName = fields.counterpartyName ?? null;
      if (counterpartyId && !counterpartyName) {
        const [cp] = await tx.select({ name: counterparties.name }).from(counterparties).where(eq(counterparties.id, counterpartyId));
        counterpartyName = cp?.name ?? null;
      } else if (!counterpartyId && counterpartyName) {
        counterpartyId = (await this.counterparties.findOrCreate(tx, ctx.workspaceId, counterpartyName, COUNTERPARTY_KIND[fields.kind]))?.id ?? null;
      }
      const openingOutstanding = receivedIntoAccountId ? Math.max(0, fields.openingOutstanding - fields.principal) : fields.openingOutstanding;
      const [row] = await tx
        .insert(liabilities)
        .values({ workspaceId: ctx.workspaceId, ...fields, counterpartyId, counterpartyName, openingOutstanding })
        .returning();
      const liability = assertFound(row, "Liability");

      let borrowingTransactionId: string | null = null;
      if (receivedIntoAccountId) {
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "loan",
            direction: "in",
            accountId: receivedIntoAccountId,
            amount: liability.principal,
            currency: liability.currency,
            date: liability.startDate ?? day,
            liabilityId: liability.id,
            counterpartyId,
            projectId: liability.projectId,
            description: `Borrowed: ${liability.name}`,
          },
          { exec: tx, metadata: { liabilityId: liability.id } },
        );
        borrowingTransactionId = transaction.id;
      }

      let commitmentId: string | null = null;
      if (schedule) {
        // Planning owns commitments; this fails the whole creation if it cannot be made.
        const commitment = await this.commitments.create(
          ctx,
          {
            kind: "loan_payment",
            direction: "out",
            name: `${liability.name.slice(0, 108)} installment`,
            payee: counterpartyName,
            counterpartyId,
            amount: schedule.amount,
            currency: liability.currency,
            frequency: schedule.frequency,
            startDate: schedule.firstDueDate,
            accountId: liability.accountId ?? receivedIntoAccountId ?? null,
            projectId: liability.projectId,
            liabilityId: liability.id,
            autoPay: schedule.autoPay,
          },
          { exec: tx },
        );
        commitmentId = commitment.id;
      }

      await this.persistStatus(tx, ctx, liability.id);
      await this.audit.record(tx, ctx, {
        action: "liability.created",
        entityType: "liability",
        entityId: liability.id,
        after: { ...liability, borrowingTransactionId, commitmentId },
      });
      return liability.id;
    });
    return this.detail(ctx, id);
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof liabilityUpdate>) {
    const input = liabilityUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      await assertInWorkspace(tx, counterparties, ctx.workspaceId, [input.counterpartyId], "Counterparty");
      await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.accountId], "Account");
      await this.checkCategory(tx, ctx, input.categoryId);
      if (input.currency && input.currency !== before.currency) {
        const [used] = await this.linkedTransactions(ctx, id, tx).limit(1);
        if (used) throw conflict("The currency of a liability with transactions cannot change", "currency_locked");
      }
      const { status, ...fields } = input;
      if (fields.counterpartyName && fields.counterpartyId === undefined && fields.counterpartyName !== before.counterpartyName) {
        fields.counterpartyId =
          (await this.counterparties.findOrCreate(tx, ctx.workspaceId, fields.counterpartyName, COUNTERPARTY_KIND[fields.kind ?? before.kind]))?.id ?? null;
      }
      // Only cancelling is stored as a decision; any other status un-cancels
      // and is then recomputed from the numbers.
      const changes = { ...fields, ...(status ? { status: status === "cancelled" ? ("cancelled" as const) : ("active" as const) } : {}) };
      if (Object.keys(changes).length) await tx.update(liabilities).set(changes).where(eq(liabilities.id, id));
      await this.persistStatus(tx, ctx, id);
      await this.audit.record(tx, ctx, { action: "liability.updated", entityType: "liability", entityId: id, before, after: await this.get(ctx, id, tx) });
    });
    return this.detail(ctx, id);
  }

  async remove(ctx: WorkspaceContext, id: string, options: { voidLinked?: boolean } = {}) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const linked = await this.linkedTransactions(ctx, id, tx);
      if (linked.length && !options.voidLinked) {
        throw conflict(
          `${before.name} has ${linked.length} linked transaction${linked.length === 1 ? "" : "s"}. Void them too, or cancel the liability instead.`,
          "has_transactions",
          linked.map((row) => ({ path: "transactionId", message: row.id })),
        );
      }
      for (const row of linked) await this.transactions.void(ctx, row.id, `Liability ${before.name} deleted`, { exec: tx });
      await tx.delete(liabilities).where(eq(liabilities.id, id));
      await this.audit.record(tx, ctx, {
        action: "liability.deleted",
        entityType: "liability",
        entityId: id,
        before,
        after: { voidedTransactionIds: linked.map((row) => row.id) },
      });
      return { deleted: true, voidedTransactionIds: linked.map((row) => row.id) };
    });
  }

  /**
   * Records a payment. The principal part reduces the outstanding: a
   * `debt_payment` out linked to the liability (or, for a payable, an
   * `expense` in its category — paying a bill is when its cost is recognised).
   * The interest part is a separate `expense` in the "Interest" category,
   * linked through metadata only, so it never reduces the outstanding.
   */
  async pay(ctx: WorkspaceContext, id: string, raw: LiabilityPaymentRequest) {
    const input = liabilityPaymentRequest.parse(raw);
    const result = await db.transaction(async (tx) => {
      const liability = await this.get(ctx, id, tx);
      if (liability.status === "cancelled") throw conflict(`${liability.name} is cancelled`, "liability_cancelled");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.accountId], "Account");
      const [before] = await this.views(ctx, [liability], tx);
      const outstanding = Math.max(0, before?.outstanding ?? 0);
      const principal = input.amount - input.interest;
      if (principal > outstanding) {
        throw unprocessable(
          `The principal part (${principal}) is more than the outstanding ${outstanding}. Record the difference as interest or pay less.`,
          "payment_exceeds_outstanding",
        );
      }
      const recordAs = input.recordAs === "auto" ? (liability.kind === "payable" ? "expense" : "debt_payment") : input.recordAs;
      const paymentGroup = uuidv7();
      let principalTransactionId: string | null = null;
      let interestTransactionId: string | null = null;
      if (principal > 0) {
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: recordAs,
            direction: "out",
            accountId: input.accountId,
            amount: principal,
            currency: liability.currency,
            date: input.date,
            liabilityId: id,
            counterpartyId: liability.counterpartyId,
            projectId: liability.projectId,
            categoryId: recordAs === "expense" ? liability.categoryId : null,
            description: `Payment: ${liability.name}`,
            notes: input.note ?? null,
            attachmentFileIds: input.attachmentFileIds,
          },
          { exec: tx, metadata: { liabilityId: id, liabilityPayment: true, paymentGroup } },
        );
        principalTransactionId = transaction.id;
      }
      if (input.interest > 0) {
        const interestCategory = await ensureCategory(tx, ctx, this.audit, { name: "Interest", kind: "expense", icon: "trending-up", color: "red" });
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "expense",
            direction: "out",
            accountId: input.accountId,
            amount: input.interest,
            currency: liability.currency,
            date: input.date,
            categoryId: interestCategory,
            counterpartyId: liability.counterpartyId,
            projectId: liability.projectId,
            description: `Interest: ${liability.name}`,
            notes: input.note ?? null,
            attachmentFileIds: principal > 0 ? undefined : input.attachmentFileIds,
          },
          { exec: tx, metadata: { liabilityId: id, interest: true, paymentGroup, principalTransactionId } },
        );
        interestTransactionId = transaction.id;
      }
      const after = await this.persistStatus(tx, ctx, id);
      await this.audit.record(tx, ctx, {
        action: "liability.payment_recorded",
        entityType: "liability",
        entityId: id,
        before: { outstanding: before?.outstanding, status: before?.status },
        after: {
          outstanding: after?.outstanding,
          status: after?.status,
          principal,
          interest: input.interest,
          principalTransactionId,
          interestTransactionId,
          recordAs,
        },
      });
      return { principal, interest: input.interest, principalTransactionId, interestTransactionId };
    });
    return { ...result, liability: await this.detail(ctx, id) };
  }
}
