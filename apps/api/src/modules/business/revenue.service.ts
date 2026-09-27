import { addMonths, type Day, eachMonth, endOfMonth, monthlyEquivalent, percentChange, previousRange, startOfMonth } from "@expensewise/core";
import { type FinanceRangeQuery, financeRangeQuery } from "@expensewise/core/contracts/business-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte, ne, type SQL, sql } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { categories, commitments, counterparties, integrationConnections, projects, transactions } from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { RateBook, share } from "../wealth/support.js";
import { resolveRange, txDrill } from "./drill.js";

const SOURCE_LABELS: Record<string, string> = {
  manual: "Entered by hand",
  screenshot: "Screenshot capture",
  receipt: "Receipt capture",
  text: "Text capture",
  voice: "Voice capture",
  csv: "CSV import",
  excel: "Excel import",
  pdf: "PDF import",
  integration: "Integration",
  webhook: "Webhook",
  api: "API",
  recurring: "Recurring",
  system: "System",
};

/** At most this many months in the monthly series. */
const MAX_MONTHS = 36;

/**
 * Revenue on a cash basis: posted `income` less refunds paid out to
 * customers, in the base currency. Expected recurring revenue from
 * commitments is reported separately and labelled as expected.
 */
@Injectable()
export class RevenueService {
  constructor(@Inject(FxService) private readonly fx: FxService) {}

  private where(ctx: WorkspaceContext, from: Day | null, to: Day): SQL {
    return and(
      eq(transactions.workspaceId, ctx.workspaceId),
      eq(transactions.status, "posted"),
      sql`(${transactions.type} = 'income' or (${transactions.type} = 'refund' and ${transactions.direction} = 'out'))`,
      from ? gte(transactions.date, from) : undefined,
      lte(transactions.date, to),
    ) as SQL;
  }

  private readonly net =
    sql<string>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.baseAmount} else -${transactions.baseAmount} end), 0)`;

  private async totals(ctx: WorkspaceContext, from: Day | null, to: Day) {
    const [row] = await db
      .select({
        gross: sql<string>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.baseAmount} else 0 end), 0)`,
        refunds: sql<string>`coalesce(sum(case when ${transactions.type} = 'refund' then ${transactions.baseAmount} else 0 end), 0)`,
        count: sql<number>`count(*) filter (where ${transactions.type} = 'income')::int`,
        first: sql<string | null>`min(${transactions.date})::text`,
      })
      .from(transactions)
      .where(this.where(ctx, from, to));
    const gross = Number(row?.gross ?? 0);
    const refunds = Number(row?.refunds ?? 0);
    return { gross, refunds, net: gross - refunds, count: row?.count ?? 0, first: row?.first ?? null };
  }

  async analytics(ctx: WorkspaceContext, raw: FinanceRangeQuery = {}) {
    const resolved = resolveRange(ctx, financeRangeQuery.parse(raw), "last_12_months");
    const current = await this.totals(ctx, resolved.from, resolved.to);
    const from = resolved.from ?? current.first ?? resolved.to;
    const range = { from, to: resolved.to };
    const previous = previousRange(range);
    const prior = await this.totals(ctx, previous.from, previous.to);
    const where = this.where(ctx, range.from, range.to);
    const revenueTypes: ["income", "refund"] = ["income", "refund"];

    const month = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
    const [monthRows, projectRows, sourceRows, customerRows, categoryRows] = await Promise.all([
      db.select({ month, amount: this.net }).from(transactions).where(where).groupBy(month),
      db
        .select({ id: transactions.projectId, name: projects.name, amount: this.net, count: sql<number>`count(*)::int` })
        .from(transactions)
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .where(where)
        .groupBy(transactions.projectId, projects.name),
      db
        .select({
          source: transactions.source,
          connectionId: transactions.connectionId,
          name: integrationConnections.name,
          provider: integrationConnections.provider,
          amount: this.net,
          count: sql<number>`count(*)::int`,
        })
        .from(transactions)
        .leftJoin(integrationConnections, eq(integrationConnections.id, transactions.connectionId))
        .where(where)
        .groupBy(transactions.source, transactions.connectionId, integrationConnections.name, integrationConnections.provider),
      db
        .select({
          id: transactions.counterpartyId,
          name: counterparties.name,
          merchant: sql<string | null>`max(${transactions.merchant})`,
          amount: this.net,
          count: sql<number>`count(*)::int`,
        })
        .from(transactions)
        .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
        .where(where)
        .groupBy(transactions.counterpartyId, counterparties.name),
      db
        .select({ id: transactions.categoryId, name: categories.name, amount: this.net, count: sql<number>`count(*)::int` })
        .from(transactions)
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(where)
        .groupBy(transactions.categoryId, categories.name),
    ]);

    const total = current.net;
    const sorted = <T extends { amount: number }>(rows: T[]) => rows.sort((a, b) => b.amount - a.amount);
    let monthFrom = range.from;
    if (eachMonth(monthFrom, range.to, 10_000).length > MAX_MONTHS) monthFrom = addMonths(startOfMonth(range.to), -(MAX_MONTHS - 1));
    const byMonthMap = new Map(monthRows.map((row) => [row.month, Number(row.amount)]));
    const byMonth = eachMonth(monthFrom, range.to).map((key) => {
      const monthRange = { from: `${key}-01`, to: endOfMonth(`${key}-01`) };
      return { month: key, amount: byMonthMap.get(key) ?? 0, drill: txDrill(monthRange, revenueTypes) };
    });

    return {
      currency: ctx.baseCurrency,
      range,
      previousRange: previous,
      totals: {
        /** Income less refunds paid out. */
        revenue: current.net,
        gross: current.gross,
        refunds: current.refunds,
        transactionCount: current.count,
        previous: prior.net,
        change: current.net - prior.net,
        changePercent: percentChange(prior.net, current.net),
        drill: txDrill(range, revenueTypes),
        previousDrill: txDrill(previous, revenueTypes),
      },
      byMonth,
      byProject: sorted(
        projectRows.map((row) => ({
          projectId: row.id,
          name: row.name ?? "No project",
          amount: Number(row.amount),
          count: row.count,
          share: share(Number(row.amount), total),
          drill: txDrill(range, revenueTypes, { projectId: row.id }),
        })),
      ),
      bySource: sorted(
        sourceRows.map((row) => ({
          source: row.source,
          connectionId: row.connectionId,
          provider: row.provider,
          label: row.name ?? SOURCE_LABELS[row.source] ?? row.source,
          amount: Number(row.amount),
          count: row.count,
          share: share(Number(row.amount), total),
          drill: txDrill(range, revenueTypes, { source: row.source }),
        })),
      ),
      byCustomer: sorted(
        customerRows.map((row) => ({
          counterpartyId: row.id,
          name: row.name ?? row.merchant ?? "No customer",
          amount: Number(row.amount),
          count: row.count,
          share: share(Number(row.amount), total),
          drill: row.id ? txDrill(range, revenueTypes, { counterpartyId: row.id }) : txDrill(range, revenueTypes),
        })),
      ),
      byCategory: sorted(
        categoryRows.map((row) => ({
          categoryId: row.id,
          name: row.name ?? "Uncategorized",
          amount: Number(row.amount),
          count: row.count,
          share: share(Number(row.amount), total),
          drill: txDrill(range, revenueTypes, { categoryId: row.id }),
        })),
      ),
      expectedRecurring: await this.expectedRecurring(ctx),
    };
  }

  /**
   * Recurring income the workspace expects (active `in` commitments), as a
   * monthly equivalent. Expected, not received: it is never mixed into the
   * actual revenue figures.
   */
  private async expectedRecurring(ctx: WorkspaceContext) {
    const rows = await db
      .select()
      .from(commitments)
      .where(
        and(eq(commitments.workspaceId, ctx.workspaceId), eq(commitments.status, "active"), eq(commitments.direction, "in"), ne(commitments.frequency, "once")),
      )
      .orderBy(asc(commitments.name));
    const rates = new RateBook(this.fx, ctx.workspaceId);
    const day = todayFor(ctx);
    const items = await Promise.all(
      rows.map(async (row) => {
        const monthly = monthlyEquivalent(row.amount, row);
        return {
          commitmentId: row.id,
          name: row.name,
          kind: row.kind,
          projectId: row.projectId,
          amount: row.amount,
          currency: row.currency,
          frequency: row.frequency,
          nextDueDate: row.nextDueDate,
          monthly,
          baseMonthly: await rates.convert(monthly, row.currency, ctx.baseCurrency, day),
        };
      }),
    );
    const monthly = items.reduce((acc, item) => acc + (item.baseMonthly ?? 0), 0);
    return {
      label: "expected" as const,
      monthly,
      annualized: monthly * 12,
      items,
      unconvertible: items
        .filter((item) => item.baseMonthly === null)
        .map((item) => ({ commitmentId: item.commitmentId, name: item.name, currency: item.currency, monthly: item.monthly })),
      drill: { target: "commitments" as const, query: { direction: "in", status: "active" } },
    };
  }
}
