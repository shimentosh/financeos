import {
  type Day,
  type InvestmentFlow,
  type InvestmentMetrics,
  investmentFlowInput,
  investmentInput,
  investmentMetrics,
  investmentUpdate,
  valuationInput,
} from "@financeos/core";
import { type InvestmentQuery, investmentQuery } from "@financeos/core/contracts/wealth-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { financialAccounts, investments, investmentValuations, transactions } from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { linkedTransactionColumns } from "./assets.service.js";
import { dayOf, mapSeries, RateBook, restate } from "./support.js";

export type InvestmentRow = typeof investments.$inferSelect;
export type InvestmentValuationRow = typeof investmentValuations.$inferSelect;
export type DatedInvestmentFlow = InvestmentFlow & { date: Day; transactionId: string };
export type InvestmentWithFlows = {
  row: InvestmentRow;
  /** Posted `investment` transactions, restated in the investment's currency, oldest first. */
  flows: DatedInvestmentFlow[];
  /** Linked transactions left out because no exchange rate exists to restate them. */
  unconverted: number;
};

type BaseFigures = {
  value: number;
  costBasis: number;
  contributed: number;
  withdrawn: number;
  realizedGain: number;
  unrealizedGain: number | null;
};

export type InvestmentView = InvestmentRow & {
  /** In the investment's currency, from core `investmentMetrics`. */
  metrics: InvestmentMetrics;
  /** What net worth counts: the latest valuation, or the cost basis when there is none. */
  value: number;
  valueSource: "valuation" | "cost_basis";
  /** The same figures in the base currency at today's rate; null when no rate exists. */
  base: BaseFigures | null;
  /** Money moved after the latest valuation: the value may be out of date. */
  valuationOutdated: boolean;
  lastFlowDate: Day | null;
  flowCount: number;
  unconvertedFlows: number;
};

export type PortfolioTotals = {
  count: number;
  /** Investments with a valuation (the others count at cost basis). */
  valuedCount: number;
  contributed: number;
  withdrawn: number;
  costBasis: number;
  value: number;
  realizedGain: number;
  /** Over valued investments only. */
  unrealizedGain: number;
  /** Total return over contributions, valued investments only; null when none. */
  roi: number | null;
};

/** When a holding started: the opening date, or when it was added here. */
export function investmentStart(row: InvestmentRow, timezone: string): Day {
  return row.openedOn ?? dayOf(row.createdAt, timezone);
}

/**
 * An investment's value on a past day: the latest valuation on or before it,
 * else the cost basis invested by then. Null when it did not exist yet or had
 * been closed.
 */
export function investmentValueAsOf(
  item: InvestmentWithFlows,
  valuations: InvestmentValuationRow[],
  asOf: Day,
  timezone: string,
): { value: number; source: "valuation" | "cost_basis"; valuedAt: Day | null } | null {
  const start = investmentStart(item.row, timezone);
  const flows = item.flows.filter((flow) => flow.date <= asOf);
  const known = valuations.filter((valuation) => valuation.date <= asOf);
  if (start > asOf && !flows.length && !known.length) return null;
  if (item.row.status === "closed") {
    const closedOn = item.flows.at(-1)?.date ?? dayOf(item.row.updatedAt, timezone);
    if (closedOn <= asOf) return null;
  }
  const latest = known.at(-1);
  if (latest) return { value: latest.value, source: "valuation", valuedAt: latest.date };
  const metrics = investmentMetrics({ openingCostBasis: start <= asOf ? item.row.openingCostBasis : 0, flows, currentValue: null });
  return { value: metrics.costBasis, source: "cost_basis", valuedAt: null };
}

function portfolio(items: InvestmentView[]): PortfolioTotals {
  const totals: PortfolioTotals = {
    count: 0,
    valuedCount: 0,
    contributed: 0,
    withdrawn: 0,
    costBasis: 0,
    value: 0,
    realizedGain: 0,
    unrealizedGain: 0,
    roi: null,
  };
  let valuedContributed = 0;
  let valuedReturn = 0;
  for (const item of items) {
    totals.count += 1;
    if (!item.base) continue;
    totals.contributed += item.base.contributed;
    totals.withdrawn += item.base.withdrawn;
    totals.costBasis += item.base.costBasis;
    totals.value += item.base.value;
    totals.realizedGain += item.base.realizedGain;
    if (item.valueSource === "valuation") {
      totals.valuedCount += 1;
      totals.unrealizedGain += item.base.unrealizedGain ?? 0;
      valuedContributed += item.base.contributed;
      valuedReturn += item.base.value + item.base.withdrawn - item.base.contributed;
    }
  }
  totals.roi = valuedContributed > 0 ? Math.round((valuedReturn / valuedContributed) * 1000) / 10 : null;
  return totals;
}

@Injectable()
export class InvestmentsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<InvestmentRow> {
    const [row] = await exec
      .select()
      .from(investments)
      .where(and(eq(investments.id, id), eq(investments.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Investment");
  }

  /** Loads each investment's posted flows, restated in its own currency. */
  async withFlows(ctx: WorkspaceContext, rows: InvestmentRow[], exec: Executor = db): Promise<InvestmentWithFlows[]> {
    if (!rows.length) return [];
    const linked = await exec
      .select({
        id: transactions.id,
        investmentId: transactions.investmentId,
        direction: transactions.direction,
        amount: transactions.amount,
        currency: transactions.currency,
        baseAmount: transactions.baseAmount,
        baseCurrency: transactions.baseCurrency,
        date: transactions.date,
        costBasis: transactions.costBasis,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          inArray(
            transactions.investmentId,
            rows.map((row) => row.id),
          ),
          eq(transactions.status, "posted"),
          eq(transactions.type, "investment"),
        ),
      )
      .orderBy(asc(transactions.date), asc(transactions.createdAt));
    const rates = new RateBook(this.fx, ctx.workspaceId, exec);
    return mapSeries(rows, async (row) => {
      const flows: DatedInvestmentFlow[] = [];
      let unconverted = 0;
      for (const tx of linked.filter((candidate) => candidate.investmentId === row.id)) {
        const restated = await restate(tx, row.currency, rates);
        if (!restated) {
          unconverted += 1;
          continue;
        }
        flows.push({ direction: tx.direction, amount: restated.amount, costBasis: restated.costBasis, date: tx.date, transactionId: tx.id });
      }
      return { row, flows, unconverted };
    });
  }

  private async views(ctx: WorkspaceContext, rows: InvestmentRow[]): Promise<InvestmentView[]> {
    const day = todayFor(ctx);
    const rates = new RateBook(this.fx, ctx.workspaceId);
    const loaded = await this.withFlows(ctx, rows);
    return Promise.all(
      loaded.map(async ({ row, flows, unconverted }) => {
        const metrics = investmentMetrics({ openingCostBasis: row.openingCostBasis, flows, currentValue: row.currentValue });
        const value = row.currentValue ?? metrics.costBasis;
        const convert = (amount: number) => rates.convert(amount, row.currency, ctx.baseCurrency, day);
        const baseValue = await convert(value);
        const base: BaseFigures | null =
          baseValue === null
            ? null
            : {
                value: baseValue,
                costBasis: (await convert(metrics.costBasis)) ?? 0,
                contributed: (await convert(metrics.contributed)) ?? 0,
                withdrawn: (await convert(metrics.withdrawn)) ?? 0,
                realizedGain: (await convert(metrics.realizedGain)) ?? 0,
                unrealizedGain: metrics.unrealizedGain === null ? null : await convert(metrics.unrealizedGain),
              };
        const lastFlowDate = flows.at(-1)?.date ?? null;
        return {
          ...row,
          metrics,
          value,
          valueSource: row.currentValue === null ? ("cost_basis" as const) : ("valuation" as const),
          base,
          valuationOutdated: Boolean(row.valuedAt && lastFlowDate && lastFlowDate > row.valuedAt),
          lastFlowDate,
          flowCount: flows.length,
          unconvertedFlows: unconverted,
        };
      }),
    );
  }

  /** Holdings with metrics, portfolio totals by kind, and those that could not be converted. */
  async list(ctx: WorkspaceContext, raw: InvestmentQuery = {}) {
    const query = investmentQuery.parse(raw);
    const rows = await db
      .select()
      .from(investments)
      .where(
        and(
          eq(investments.workspaceId, ctx.workspaceId),
          query.status === "all" ? undefined : eq(investments.status, query.status),
          query.kind ? eq(investments.kind, query.kind) : undefined,
        ),
      )
      .orderBy(asc(investments.status), asc(investments.kind), asc(investments.name));
    const items = await this.views(ctx, rows);
    const kinds = [...new Set(items.map((item) => item.kind))];
    return {
      items,
      byKind: kinds.map((kind) => ({ kind, ...portfolio(items.filter((item) => item.kind === kind)) })).sort((a, b) => b.value - a.value),
      totals: { currency: ctx.baseCurrency, ...portfolio(items) },
      unconvertible: items.filter((item) => item.base === null).map((item) => ({ id: item.id, name: item.name, currency: item.currency, value: item.value })),
    };
  }

  async detail(ctx: WorkspaceContext, id: string) {
    const row = await this.get(ctx, id);
    const [view] = await this.views(ctx, [row]);
    const [valuations, flows] = await Promise.all([this.valuations(ctx, id), this.flows(ctx, id)]);
    return { ...(view as InvestmentView), valuations, flows };
  }

  /** Transactions linked to the investment, newest first. */
  async flows(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    await this.get(ctx, id, exec);
    return this.linkedTransactions(ctx, id, exec);
  }

  private linkedTransactions(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    return exec
      .select(linkedTransactionColumns)
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.investmentId, id), ne(transactions.status, "void")))
      .orderBy(desc(transactions.date), desc(transactions.createdAt));
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof investmentInput>) {
    const input = investmentInput.parse(raw);
    const day = todayFor(ctx);
    const valued = input.currentValue !== null && input.currentValue !== undefined;
    const valuedAt = valued ? (input.valuedAt ?? day) : null;
    if (valuedAt && valuedAt > day) throw unprocessable("A valuation cannot be dated in the future", "future_valuation");
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(investments)
        .values({ workspaceId: ctx.workspaceId, ...input, currentValue: valued ? input.currentValue : null, valuedAt })
        .returning();
      const investment = assertFound(row, "Investment");
      if (valued && valuedAt) {
        await tx.insert(investmentValuations).values({
          workspaceId: ctx.workspaceId,
          investmentId: investment.id,
          value: investment.currentValue as number,
          date: valuedAt,
          note: "Initial value",
        });
      }
      await this.audit.record(tx, ctx, { action: "investment.created", entityType: "investment", entityId: investment.id, after: investment });
      return investment.id;
    });
    return this.detail(ctx, id);
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof investmentUpdate>) {
    const input = investmentUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const { currentValue, valuedAt, ...fields } = input;
      const currencyChanged = fields.currency !== undefined && fields.currency !== before.currency;
      if (currencyChanged) {
        const [used] = await this.linkedTransactions(ctx, id, tx).limit(1);
        if (used) throw conflict("The currency of an investment with transactions cannot change", "currency_locked");
      }
      if (Object.keys(fields).length) await tx.update(investments).set(fields).where(eq(investments.id, id));
      const after = await this.get(ctx, id, tx);
      if (currencyChanged) {
        // Old valuations were in the old currency: the history restarts.
        await tx.delete(investmentValuations).where(eq(investmentValuations.investmentId, id));
        const value = currentValue ?? before.currentValue;
        if (value !== null) await this.recordValuation(tx, ctx, after, value, valuedAt ?? todayFor(ctx), "Currency changed");
        else await tx.update(investments).set({ currentValue: null, valuedAt: null }).where(eq(investments.id, id));
      } else if (typeof currentValue === "number" && (currentValue !== before.currentValue || valuedAt)) {
        await this.recordValuation(tx, ctx, after, currentValue, valuedAt ?? todayFor(ctx), null);
      }
      await this.audit.record(tx, ctx, { action: "investment.updated", entityType: "investment", entityId: id, before, after: await this.get(ctx, id, tx) });
    });
    return this.detail(ctx, id);
  }

  async remove(ctx: WorkspaceContext, id: string, options: { voidLinked?: boolean } = {}) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const linked = await this.linkedTransactions(ctx, id, tx);
      if (linked.length && !options.voidLinked) {
        throw conflict(
          `${before.name} has ${linked.length} linked transaction${linked.length === 1 ? "" : "s"}. Void them too, or close the investment instead.`,
          "has_transactions",
          linked.map((row) => ({ path: "transactionId", message: row.id })),
        );
      }
      for (const row of linked) await this.transactions.void(ctx, row.id, `Investment ${before.name} deleted`, { exec: tx });
      await tx.delete(investments).where(eq(investments.id, id));
      await this.audit.record(tx, ctx, {
        action: "investment.deleted",
        entityType: "investment",
        entityId: id,
        before,
        after: { voidedTransactionIds: linked.map((row) => row.id) },
      });
      return { deleted: true, voidedTransactionIds: linked.map((row) => row.id) };
    });
  }

  /**
   * A contribution (`out` of the account into the holding) or a withdrawal
   * (`in`), recorded as an `investment` transaction — never an expense or
   * income. A withdrawal may state the cost basis it releases; without one it
   * is treated as a return of capital.
   */
  async recordFlow(ctx: WorkspaceContext, id: string, raw: z.input<typeof investmentFlowInput>) {
    const input = investmentFlowInput.parse(raw);
    const transactionId = await db.transaction(async (tx) => {
      const investment = await this.get(ctx, id, tx);
      if (investment.status === "closed") throw conflict(`${investment.name} is closed. Reopen it to record money moving.`, "investment_closed");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.accountId], "Account");
      const costBasis = input.direction === "in" ? (input.costBasis ?? null) : null;
      if (costBasis !== null) {
        const [loaded] = await this.withFlows(ctx, [investment], tx);
        const invested = investmentMetrics({ openingCostBasis: investment.openingCostBasis, flows: loaded?.flows ?? [], currentValue: null }).costBasis;
        if (costBasis > invested) {
          throw unprocessable(`The cost basis released (${costBasis}) is more than what is still invested (${invested})`, "cost_basis_exceeded");
        }
      }
      const { transaction } = await this.transactions.create(
        ctx,
        {
          type: "investment",
          direction: input.direction,
          accountId: input.accountId,
          amount: input.amount,
          currency: investment.currency,
          date: input.date,
          investmentId: id,
          costBasis,
          description: input.direction === "out" ? `Contribution to ${investment.name}` : `Withdrawal from ${investment.name}`,
          notes: input.note ?? null,
          attachmentFileIds: input.attachmentFileIds,
        },
        { exec: tx, metadata: { investmentId: id } },
      );
      await this.audit.record(tx, ctx, {
        action: input.direction === "out" ? "investment.contribution" : "investment.withdrawal",
        entityType: "investment",
        entityId: id,
        after: { transactionId: transaction.id, amount: input.amount, currency: investment.currency, costBasis, date: input.date },
      });
      return transaction.id;
    });
    const transaction = await this.transactions.get(ctx, transactionId);
    return { transaction, investment: await this.detail(ctx, id) };
  }

  async valuations(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    await this.get(ctx, id, exec);
    return exec
      .select()
      .from(investmentValuations)
      .where(and(eq(investmentValuations.workspaceId, ctx.workspaceId), eq(investmentValuations.investmentId, id)))
      .orderBy(desc(investmentValuations.date), desc(investmentValuations.createdAt));
  }

  /** Every valuation of the given investments, oldest first (for net worth history). */
  allValuations(ctx: WorkspaceContext, investmentIds: string[], exec: Executor = db) {
    if (!investmentIds.length) return Promise.resolve([] as InvestmentValuationRow[]);
    return exec
      .select()
      .from(investmentValuations)
      .where(and(eq(investmentValuations.workspaceId, ctx.workspaceId), inArray(investmentValuations.investmentId, investmentIds)))
      .orderBy(asc(investmentValuations.date), asc(investmentValuations.createdAt));
  }

  private async recordValuation(tx: Executor, ctx: WorkspaceContext, investment: InvestmentRow, value: number, date: Day, note: string | null) {
    if (date > todayFor(ctx)) throw unprocessable("A valuation cannot be dated in the future", "future_valuation");
    const [row] = await tx.insert(investmentValuations).values({ workspaceId: ctx.workspaceId, investmentId: investment.id, value, date, note }).returning();
    await this.refreshCurrent(tx, investment.id);
    return row as InvestmentValuationRow;
  }

  private async refreshCurrent(tx: Executor, investmentId: string) {
    const [latest] = await tx
      .select()
      .from(investmentValuations)
      .where(eq(investmentValuations.investmentId, investmentId))
      .orderBy(desc(investmentValuations.date), desc(investmentValuations.createdAt))
      .limit(1);
    await tx
      .update(investments)
      .set({ currentValue: latest?.value ?? null, valuedAt: latest?.date ?? null })
      .where(eq(investments.id, investmentId));
  }

  async addValuation(ctx: WorkspaceContext, id: string, raw: z.input<typeof valuationInput>) {
    const input = valuationInput.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const valuation = await this.recordValuation(tx, ctx, before, input.value, input.date, input.note ?? null);
      const after = await this.get(ctx, id, tx);
      await this.audit.record(tx, ctx, { action: "investment.valued", entityType: "investment", entityId: id, before, after: { ...after, valuation } });
      return { valuation, investment: after };
    });
  }

  async removeValuation(ctx: WorkspaceContext, id: string, valuationId: string) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const [removed] = await tx
        .delete(investmentValuations)
        .where(and(eq(investmentValuations.id, valuationId), eq(investmentValuations.investmentId, id), eq(investmentValuations.workspaceId, ctx.workspaceId)))
        .returning();
      assertFound(removed, "Valuation");
      await this.refreshCurrent(tx, id);
      const after = await this.get(ctx, id, tx);
      await this.audit.record(tx, ctx, {
        action: "investment.valuation_deleted",
        entityType: "investment",
        entityId: id,
        before: { ...before, valuation: removed },
        after,
      });
      return { deleted: true, investment: after };
    });
  }
}
