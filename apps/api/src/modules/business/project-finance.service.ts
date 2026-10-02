import { addMonths, type Day, eachMonth, endOfMonth, monthKey, monthlyEquivalent, projectMetrics, startOfMonth } from "@expensewise/core";
import { type FinanceRangeQuery, financeRangeQuery } from "@expensewise/core/contracts/business-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNotNull, lte, ne, type SQL, sql } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { categories, commitments, counterparties, type projects, transactions } from "../../db/schema/index.js";
import { ProjectsService } from "../ledger/catalog.service.js";
import { FxService } from "../ledger/fx.service.js";
import { LiabilitiesService, PAYABLE_KINDS } from "../wealth/liabilities.service.js";
import { ReceivablesService } from "../wealth/receivables.service.js";
import { RateBook, share } from "../wealth/support.js";
import { type Drill, type Figure, figure, type ResolvedRange, resolveRange, txDrill } from "./drill.js";

export type ProjectRow = typeof projects.$inferSelect;

/** Cost groups for the project profile, keyed by category name. */
export const COST_GROUPS = [
  {
    group: "operating",
    label: "Operating",
    names: [
      "operations",
      "office",
      "software",
      "legal",
      "accounting",
      "equipment",
      "travel",
      "payment processing fees",
      "rent",
      "bills & utilities",
      "fees & charges",
      "subscriptions",
      "insurance",
      "utilities",
    ],
  },
  { group: "development", label: "Development", names: ["development", "contractors", "r&d"] },
  { group: "ai_api", label: "AI/API", names: ["ai & apis"] },
  { group: "hosting", label: "Hosting", names: ["hosting"] },
  { group: "marketing", label: "Marketing", names: ["marketing", "advertising"] },
  { group: "payroll", label: "Payroll", names: ["payroll"] },
  { group: "other", label: "Other", names: [] },
] as const;
export type CostGroup = (typeof COST_GROUPS)[number]["group"];

type CategoryInfo = { id: string; name: string; parentId: string | null };

function groupFor(category: CategoryInfo | undefined, byId: Map<string, CategoryInfo>): CostGroup {
  const candidates = [category?.name, category?.parentId ? byId.get(category.parentId)?.name : undefined];
  for (const name of candidates) {
    if (!name) continue;
    const key = name.trim().toLowerCase();
    const match = COST_GROUPS.find((entry) => (entry.names as readonly string[]).includes(key));
    if (match) return match.group;
  }
  return "other";
}

/** P&L sums by project from posted transactions. */
type Flow = { projectId: string | null; type: string; direction: string; categoryId: string | null; total: number };

function revenueOf(rows: Flow[]) {
  return rows.reduce((acc, r) => acc + (r.type === "income" ? r.total : r.type === "refund" && r.direction === "out" ? -r.total : 0), 0);
}
function costOf(rows: Flow[]) {
  return rows.reduce((acc, r) => acc + (r.type === "expense" ? r.total : r.type === "refund" && r.direction === "in" ? -r.total : 0), 0);
}
function equityOf(rows: Flow[], direction: "in" | "out") {
  return rows.reduce((acc, r) => acc + (r.type === "equity" && r.direction === direction ? r.total : 0), 0);
}

type RecurringItem = {
  commitmentId: string;
  name: string;
  kind: string;
  amount: number;
  currency: string;
  frequency: string;
  nextDueDate: Day | null;
  /** Monthly equivalent in the commitment's currency. */
  monthly: number;
  /** In the base currency; null when no exchange rate exists. */
  baseMonthly: number | null;
};

/**
 * The financial picture of projects: what each earned and cost (actual,
 * posted transactions only), how fast it spends, and — clearly separated —
 * estimates built on those actuals (runway, recurring commitments).
 */
@Injectable()
export class ProjectFinanceService {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(ReceivablesService) private readonly receivables: ReceivablesService,
    @Inject(LiabilitiesService) private readonly liabilities: LiabilitiesService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  private posted(ctx: WorkspaceContext, extra: Array<SQL | undefined>) {
    return and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.status, "posted"), ...extra);
  }

  private async flows(ctx: WorkspaceContext, range: { from: Day | null; to: Day }, projectId?: string, byCategory = true): Promise<Flow[]> {
    const rows = await db
      .select({
        projectId: transactions.projectId,
        type: transactions.type,
        direction: transactions.direction,
        categoryId: byCategory ? transactions.categoryId : sql<string | null>`null`,
        total: sql<string>`coalesce(sum(${transactions.baseAmount}), 0)`,
      })
      .from(transactions)
      .where(
        this.posted(ctx, [
          inArray(transactions.type, ["income", "expense", "refund", "equity"]),
          projectId ? eq(transactions.projectId, projectId) : undefined,
          range.from ? gte(transactions.date, range.from) : undefined,
          lte(transactions.date, range.to),
        ]),
      )
      .groupBy(transactions.projectId, transactions.type, transactions.direction, ...(byCategory ? [transactions.categoryId] : []));
    return rows.map((row) => ({ ...row, total: Number(row.total) }));
  }

  /** One project's revenue per month and category within the range, refunds paid out netted. */
  private async revenueMonths(ctx: WorkspaceContext, range: { from: Day | null; to: Day }, projectId: string) {
    const month = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
    const rows = await db
      .select({
        month,
        categoryId: transactions.categoryId,
        type: transactions.type,
        direction: transactions.direction,
        total: sql<string>`coalesce(sum(${transactions.baseAmount}), 0)`,
      })
      .from(transactions)
      .where(
        this.posted(ctx, [
          inArray(transactions.type, ["income", "refund"]),
          eq(transactions.projectId, projectId),
          range.from ? gte(transactions.date, range.from) : undefined,
          lte(transactions.date, range.to),
        ]),
      )
      .groupBy(month, transactions.categoryId, transactions.type, transactions.direction);
    return rows.map((row) => ({ ...row, total: Number(row.total) }));
  }

  /** Revenue and cost per month for the last 12 months (this month included). */
  private async monthly(ctx: WorkspaceContext, projectId?: string) {
    const day = todayFor(ctx);
    const from = addMonths(startOfMonth(day), -11);
    const to = endOfMonth(day);
    const month = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
    const rows = await db
      .select({
        projectId: transactions.projectId,
        month,
        type: transactions.type,
        direction: transactions.direction,
        total: sql<string>`coalesce(sum(${transactions.baseAmount}), 0)`,
      })
      .from(transactions)
      .where(
        this.posted(ctx, [
          inArray(transactions.type, ["income", "expense", "refund"]),
          projectId ? eq(transactions.projectId, projectId) : isNotNull(transactions.projectId),
          gte(transactions.date, from),
          lte(transactions.date, to),
        ]),
      )
      .groupBy(transactions.projectId, month, transactions.type, transactions.direction);
    return { months: eachMonth(from, to), rows: rows.map((row) => ({ ...row, categoryId: null, total: Number(row.total) })) };
  }

  private async firstActivity(ctx: WorkspaceContext, projectIds: string[]) {
    if (!projectIds.length) return new Map<string, Day>();
    const rows = await db
      .select({ projectId: transactions.projectId, first: sql<string>`min(${transactions.date})::text` })
      .from(transactions)
      .where(this.posted(ctx, [inArray(transactions.projectId, projectIds)]))
      .groupBy(transactions.projectId);
    return new Map(rows.map((row) => [row.projectId as string, row.first]));
  }

  private async recurring(ctx: WorkspaceContext, projectIds: string[]) {
    const result = new Map<string, { out: RecurringItem[]; in: RecurringItem[] }>();
    if (!projectIds.length) return result;
    const rows = await db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.workspaceId, ctx.workspaceId),
          eq(commitments.status, "active"),
          inArray(commitments.projectId, projectIds),
          ne(commitments.frequency, "once"),
        ),
      )
      .orderBy(asc(commitments.name));
    const rates = new RateBook(this.fx, ctx.workspaceId);
    const day = todayFor(ctx);
    for (const row of rows) {
      const monthly = monthlyEquivalent(row.amount, row);
      const item: RecurringItem = {
        commitmentId: row.id,
        name: row.name,
        kind: row.kind,
        amount: row.amount,
        currency: row.currency,
        frequency: row.frequency,
        nextDueDate: row.nextDueDate,
        monthly,
        baseMonthly: await rates.convert(monthly, row.currency, ctx.baseCurrency, day),
      };
      const entry = result.get(row.projectId as string) ?? { out: [], in: [] };
      entry[row.direction].push(item);
      result.set(row.projectId as string, entry);
    }
    return result;
  }

  private async categoryIndex(ctx: WorkspaceContext) {
    const rows = await db
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.workspaceId, ctx.workspaceId));
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Complete months used for the burn rate: the last three, not before the project began. */
  private burnMonths(day: Day, start: Day | null): string[] {
    const current = startOfMonth(day);
    return [3, 2, 1].map((back) => monthKey(addMonths(current, -back))).filter((month) => !start || month >= monthKey(start));
  }

  private recurringSummary(items: RecurringItem[], projectId: string, direction: "in" | "out") {
    return {
      amount: items.reduce((acc, item) => acc + (item.baseMonthly ?? 0), 0),
      items,
      unconvertible: items
        .filter((item) => item.baseMonthly === null)
        .map((item) => ({ commitmentId: item.commitmentId, name: item.name, currency: item.currency, monthly: item.monthly })),
      drill: { target: "commitments", query: { projectId, direction, status: "active" } } as Drill,
    };
  }

  private budgetAndRunway(
    project: ProjectRow,
    lifetime: Flow[],
    burn: { monthlyCost: number[]; monthlyNet: number[] },
    capitalInvested: number,
    receivables: number,
    payables: number,
    recurringMonthly: number,
  ) {
    const metrics = projectMetrics({
      revenue: revenueOf(lifetime),
      cost: costOf(lifetime),
      capitalInvested,
      budget: project.budgetAmount ?? null,
      monthlyCost: burn.monthlyCost,
      monthlyNet: burn.monthlyNet,
      receivables,
      payables,
      recurringMonthly,
    });
    const reason =
      project.budgetAmount === null
        ? "No budget is set for this project."
        : burn.monthlyCost.length === 0
          ? "No complete month of spending yet."
          : metrics.monthlyBurn <= 0
            ? "No spending in the recent complete months."
            : null;
    return { metrics, reason };
  }

  /** Everything known about one project's money, actual and estimated. */
  async profile(ctx: WorkspaceContext, projectId: string, raw: FinanceRangeQuery = {}) {
    const project = await this.projects.get(ctx, projectId);
    const range = resolveRange(ctx, financeRangeQuery.parse(raw), "lifetime");
    const day = todayFor(ctx);
    const lifetimeRange = { from: null, to: day };
    const [flows, lifetime, series, first, recurring, byId, receivableViews, payableViews, vendors, revenueRows] = await Promise.all([
      this.flows(ctx, range, projectId),
      this.flows(ctx, lifetimeRange, projectId, false),
      this.monthly(ctx, projectId),
      this.firstActivity(ctx, [projectId]),
      this.recurring(ctx, [projectId]),
      this.categoryIndex(ctx),
      this.receivables.find(ctx, { projectId }),
      this.liabilities.find(ctx, { kinds: PAYABLE_KINDS, projectId }),
      this.topVendors(ctx, range, projectId),
      this.revenueMonths(ctx, range, projectId),
    ]);

    const drillRange = { from: range.from, to: range.to };
    const revenue = revenueOf(flows);
    const cost = costOf(flows);
    const capital = equityOf(flows, "in");
    const drawings = equityOf(flows, "out");

    // Cost by category (net of refunds), then by group.
    const byCategory = new Map<string | null, number>();
    for (const row of flows) {
      const value = row.type === "expense" ? row.total : row.type === "refund" && row.direction === "in" ? -row.total : 0;
      if (value) byCategory.set(row.categoryId, (byCategory.get(row.categoryId) ?? 0) + value);
    }
    const costByCategory = [...byCategory.entries()]
      .map(([categoryId, amount]) => {
        const category = categoryId ? byId.get(categoryId) : undefined;
        return {
          categoryId,
          name: category?.name ?? "Uncategorized",
          group: groupFor(category, byId),
          amount,
          share: share(amount, cost),
          drill: txDrill(drillRange, ["expense", "refund"], { projectId, categoryId }),
        };
      })
      .sort((a, b) => b.amount - a.amount);
    // Revenue by category (net of refunds paid out).
    const byRevenueCategory = new Map<string | null, number>();
    for (const row of flows) {
      const value = row.type === "income" ? row.total : row.type === "refund" && row.direction === "out" ? -row.total : 0;
      if (value) byRevenueCategory.set(row.categoryId, (byRevenueCategory.get(row.categoryId) ?? 0) + value);
    }
    const revenueByCategory = [...byRevenueCategory.entries()]
      .map(([categoryId, amount]) => ({
        categoryId,
        name: (categoryId ? byId.get(categoryId)?.name : undefined) ?? "Uncategorized",
        amount,
        share: share(amount, revenue),
        drill: txDrill(drillRange, ["income", "refund"], { projectId, categoryId }),
      }))
      .sort((a, b) => b.amount - a.amount);
    // Revenue per profit month (newest first), each with its categories.
    const revenueMonthMap = new Map<string, Map<string | null, number>>();
    for (const row of revenueRows) {
      const value = row.type === "income" ? row.total : row.direction === "out" ? -row.total : 0;
      if (!value) continue;
      const categoriesInMonth = revenueMonthMap.get(row.month) ?? new Map<string | null, number>();
      categoriesInMonth.set(row.categoryId, (categoriesInMonth.get(row.categoryId) ?? 0) + value);
      revenueMonthMap.set(row.month, categoriesInMonth);
    }
    const revenueByMonth = [...revenueMonthMap.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, categoriesInMonth]) => {
        const monthRange = { from: `${month}-01`, to: endOfMonth(`${month}-01`) };
        return {
          month,
          amount: [...categoriesInMonth.values()].reduce((acc, value) => acc + value, 0),
          drill: txDrill(monthRange, ["income", "refund"], { projectId }),
          categories: [...categoriesInMonth.entries()]
            .map(([categoryId, amount]) => ({
              categoryId,
              name: (categoryId ? byId.get(categoryId)?.name : undefined) ?? "Uncategorized",
              amount,
              drill: txDrill(monthRange, ["income", "refund"], { projectId, categoryId }),
            }))
            .sort((a, b) => b.amount - a.amount),
        };
      });
    const costByGroup = COST_GROUPS.map((entry) => {
      const members = costByCategory.filter((row) => row.group === entry.group);
      const amount = members.reduce((acc, row) => acc + row.amount, 0);
      return {
        group: entry.group,
        label: entry.label,
        amount,
        share: share(amount, cost),
        categoryIds: members.map((row) => row.categoryId).filter((id): id is string => Boolean(id)),
        drill: txDrill(drillRange, ["expense", "refund"], { projectId }),
      };
    }).filter((row) => row.amount !== 0);

    const monthly = series.months.map((month) => {
      const rows = series.rows.filter((row) => row.month === month);
      const monthRange = { from: `${month}-01`, to: endOfMonth(`${month}-01`) };
      const r = revenueOf(rows);
      const c = costOf(rows);
      return {
        month,
        revenue: r,
        cost: c,
        net: r - c,
        drill: { revenue: txDrill(monthRange, ["income", "refund"], { projectId }), cost: txDrill(monthRange, ["expense", "refund"], { projectId }) },
      };
    });
    const start = project.startDate ?? first.get(projectId) ?? null;
    const burnMonths = this.burnMonths(day, start);
    const burnRows = monthly.filter((row) => burnMonths.includes(row.month));
    const burn = { monthlyCost: burnRows.map((row) => row.cost), monthlyNet: burnRows.map((row) => row.cost - row.revenue) };

    const openReceivables = receivableViews.filter((item) => item.status !== "cancelled" && item.status !== "paid");
    const openPayables = payableViews.filter((item) => item.status !== "cancelled" && item.status !== "paid_off");
    const receivablesOutstanding = openReceivables.reduce((acc, item) => acc + (item.baseRemaining ?? 0), 0);
    const payablesOutstanding = openPayables.reduce((acc, item) => acc + Math.max(0, item.baseOutstanding ?? 0), 0);
    const recurringItems = recurring.get(projectId) ?? { out: [], in: [] };
    const recurringCost = this.recurringSummary(recurringItems.out, projectId, "out");
    const recurringRevenue = this.recurringSummary(recurringItems.in, projectId, "in");
    const { metrics, reason } = this.budgetAndRunway(
      project,
      lifetime,
      burn,
      equityOf(lifetime, "in"),
      receivablesOutstanding,
      payablesOutstanding,
      recurringCost.amount,
    );
    const burnDrill = burnMonths.length
      ? txDrill({ from: `${burnMonths[0]}-01`, to: endOfMonth(`${burnMonths.at(-1)}-01`) }, ["expense", "refund"], { projectId })
      : txDrill(drillRange, ["expense", "refund"], { projectId });

    const warnings: string[] = [];
    const unconvertedReceivables = openReceivables.filter((item) => item.baseRemaining === null).length;
    const unconvertedPayables = openPayables.filter((item) => item.baseOutstanding === null).length;
    if (unconvertedReceivables) warnings.push(`${unconvertedReceivables} receivable(s) have no exchange rate to ${ctx.baseCurrency} and are left out.`);
    if (unconvertedPayables) warnings.push(`${unconvertedPayables} payable(s) have no exchange rate to ${ctx.baseCurrency} and are left out.`);
    if (recurringCost.unconvertible.length)
      warnings.push(`${recurringCost.unconvertible.length} recurring commitment(s) have no exchange rate and are left out.`);

    return {
      project: {
        id: project.id,
        name: project.name,
        code: project.code,
        status: project.status,
        color: project.color,
        isDefault: project.isDefault,
        startDate: project.startDate,
        endDate: project.endDate,
        budgetAmount: project.budgetAmount,
      },
      currency: ctx.baseCurrency,
      range,
      actual: {
        revenue: figure(revenue, txDrill(drillRange, ["income", "refund"], { projectId })),
        cost: figure(cost, txDrill(drillRange, ["expense", "refund"], { projectId })),
        netContribution: figure(revenue - cost, txDrill(drillRange, ["income", "expense", "refund"], { projectId })),
        margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
        capitalInvested: figure(capital, txDrill(drillRange, ["equity"], { projectId })),
        ownerDrawings: figure(drawings, txDrill(drillRange, ["equity"], { projectId })),
        costByGroup,
        costByCategory,
        revenueByCategory,
        revenueByMonth,
        topVendors: vendors,
        monthly,
        burn: {
          /** Average monthly cost over the listed complete months. */
          monthlyBurn: figure(metrics.monthlyBurn, burnDrill),
          /** Average monthly cost − revenue; positive when losing money. */
          netBurn: figure(metrics.netBurn, burnDrill),
          months: burnMonths,
        },
        budget:
          project.budgetAmount === null
            ? null
            : {
                amount: project.budgetAmount,
                spent: figure(metrics.cost, txDrill({ to: day }, ["expense", "refund"], { projectId })),
                utilization: metrics.budgetUsed,
                remaining: metrics.budgetRemaining,
              },
        lifetime: {
          revenue: figure(metrics.revenue, txDrill({ to: day }, ["income", "refund"], { projectId })),
          cost: figure(metrics.cost, txDrill({ to: day }, ["expense", "refund"], { projectId })),
          netContribution: metrics.netContribution,
          capitalInvested: figure(metrics.capitalInvested, txDrill({ to: day }, ["equity"], { projectId })),
        },
        receivables: {
          outstanding: receivablesOutstanding,
          overdue: openReceivables.filter((item) => item.status === "overdue").reduce((acc, item) => acc + (item.baseRemaining ?? 0), 0),
          count: openReceivables.length,
          overdueCount: openReceivables.filter((item) => item.status === "overdue").length,
          drill: { target: "receivables", query: { projectId } } as Drill,
        },
        payables: {
          outstanding: payablesOutstanding,
          overdue: openPayables.filter((item) => item.status === "overdue").reduce((acc, item) => acc + Math.max(0, item.baseOutstanding ?? 0), 0),
          count: openPayables.length,
          overdueCount: openPayables.filter((item) => item.status === "overdue").length,
          drill: { target: "payables", query: { projectId } } as Drill,
        },
      },
      estimated: {
        /** Months until the budget runs out at the actual monthly burn. Null when either is unknown. */
        runwayMonths: metrics.runwayMonths,
        runwayBasis: metrics.runwayMonths === null ? null : "Budget remaining ÷ average monthly cost of the last complete months",
        runwayUnavailableReason: metrics.runwayMonths === null ? reason : null,
        /** Active commitments attributed to the project, as a monthly equivalent (scheduled, not yet spent). */
        recurringMonthlyCost: recurringCost,
        /** Expected recurring income from commitments (not actual revenue). */
        expectedRecurringRevenue: recurringRevenue,
      },
      warnings,
    };
  }

  private async topVendors(ctx: WorkspaceContext, range: ResolvedRange, projectId: string, limit = 5) {
    const amount = sql<string>`coalesce(sum(case when ${transactions.type} = 'expense' then ${transactions.baseAmount} else -${transactions.baseAmount} end), 0)`;
    const rows = await db
      .select({
        counterpartyId: transactions.counterpartyId,
        name: counterparties.name,
        merchant: sql<string | null>`max(${transactions.merchant})`,
        amount,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
      .where(
        this.posted(ctx, [
          eq(transactions.projectId, projectId),
          sql`(${transactions.type} = 'expense' or (${transactions.type} = 'refund' and ${transactions.direction} = 'in'))`,
          range.from ? gte(transactions.date, range.from) : undefined,
          lte(transactions.date, range.to),
        ]),
      )
      .groupBy(transactions.counterpartyId, counterparties.name)
      .orderBy(sql`${amount} desc`)
      .limit(limit);
    return rows.map((row) => ({
      counterpartyId: row.counterpartyId,
      name: row.name ?? row.merchant ?? "Unknown vendor",
      amount: Number(row.amount),
      count: row.count,
      drill: row.counterpartyId
        ? txDrill(range, ["expense", "refund"], { projectId, counterpartyId: row.counterpartyId })
        : txDrill(range, ["expense", "refund"], { projectId }),
    }));
  }

  /** Every active project side by side, with the transactions not assigned to one. */
  async overview(ctx: WorkspaceContext, raw: FinanceRangeQuery = {}) {
    const range = resolveRange(ctx, financeRangeQuery.parse(raw), "lifetime");
    const day = todayFor(ctx);
    const list = await this.projects.list(ctx);
    const ids = list.map((project) => project.id);
    const [flows, lifetime, series, first, recurring, receivableViews, payableViews] = await Promise.all([
      this.flows(ctx, range, undefined, false),
      this.flows(ctx, { from: null, to: day }, undefined, false),
      this.monthly(ctx),
      this.firstActivity(ctx, ids),
      this.recurring(ctx, ids),
      this.receivables.find(ctx, {}),
      this.liabilities.find(ctx, { kinds: PAYABLE_KINDS }),
    ]);
    const drillRange = { from: range.from, to: range.to };
    const rows = list.map((project) => {
      const mine = flows.filter((row) => row.projectId === project.id);
      const revenue = revenueOf(mine);
      const cost = costOf(mine);
      const capital = equityOf(mine, "in");
      const start = project.startDate ?? first.get(project.id) ?? null;
      const months = this.burnMonths(day, start);
      const monthRows = months.map((month) => {
        const rowsForMonth = series.rows.filter((row) => row.projectId === project.id && row.month === month);
        return { cost: costOf(rowsForMonth), revenue: revenueOf(rowsForMonth) };
      });
      const receivablesOutstanding = receivableViews
        .filter((item) => item.projectId === project.id && item.status !== "cancelled" && item.status !== "paid")
        .reduce((acc, item) => acc + (item.baseRemaining ?? 0), 0);
      const payablesOutstanding = payableViews
        .filter((item) => item.projectId === project.id && item.status !== "cancelled" && item.status !== "paid_off")
        .reduce((acc, item) => acc + Math.max(0, item.baseOutstanding ?? 0), 0);
      const recurringCost = (recurring.get(project.id)?.out ?? []).reduce((acc, item) => acc + (item.baseMonthly ?? 0), 0);
      const lifetimeMine = lifetime.filter((row) => row.projectId === project.id);
      const { metrics } = this.budgetAndRunway(
        project,
        lifetimeMine,
        { monthlyCost: monthRows.map((m) => m.cost), monthlyNet: monthRows.map((m) => m.cost - m.revenue) },
        equityOf(lifetimeMine, "in"),
        receivablesOutstanding,
        payablesOutstanding,
        recurringCost,
      );
      return {
        project: {
          id: project.id,
          name: project.name,
          code: project.code,
          status: project.status,
          color: project.color,
          isDefault: project.isDefault,
          budgetAmount: project.budgetAmount,
        },
        actual: {
          revenue: figure(revenue, txDrill(drillRange, ["income", "refund"], { projectId: project.id })),
          cost: figure(cost, txDrill(drillRange, ["expense", "refund"], { projectId: project.id })),
          netContribution: revenue - cost,
          margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
          capitalInvested: figure(capital, txDrill(drillRange, ["equity"], { projectId: project.id })),
          monthlyBurn: metrics.monthlyBurn,
          netBurn: metrics.netBurn,
          budget:
            project.budgetAmount === null
              ? null
              : { amount: project.budgetAmount, spent: metrics.cost, utilization: metrics.budgetUsed, remaining: metrics.budgetRemaining },
          receivablesOutstanding,
          payablesOutstanding,
        },
        estimated: { runwayMonths: metrics.runwayMonths, recurringMonthlyCost: recurringCost },
      };
    });
    const unassigned = flows.filter((row) => row.projectId === null);
    const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
    return {
      currency: ctx.baseCurrency,
      range,
      projects: rows.sort((a, b) => b.actual.cost.amount + b.actual.revenue.amount - (a.actual.cost.amount + a.actual.revenue.amount)),
      unassigned: {
        revenue: figure(revenueOf(unassigned), txDrill(drillRange, ["income", "refund"], { projectId: null })),
        cost: figure(costOf(unassigned), txDrill(drillRange, ["expense", "refund"], { projectId: null })),
      },
      totals: {
        revenue: sum((row) => row.actual.revenue.amount),
        cost: sum((row) => row.actual.cost.amount),
        netContribution: sum((row) => row.actual.netContribution),
        capitalInvested: sum((row) => row.actual.capitalInvested.amount),
        monthlyBurn: sum((row) => row.actual.monthlyBurn),
        receivablesOutstanding: sum((row) => row.actual.receivablesOutstanding),
        payablesOutstanding: sum((row) => row.actual.payablesOutstanding),
        recurringMonthlyCost: sum((row) => row.estimated.recurringMonthlyCost),
      },
    };
  }
}

export type ProjectProfile = Awaited<ReturnType<ProjectFinanceService["profile"]>>;
export type ProjectOverview = Awaited<ReturnType<ProjectFinanceService["overview"]>>;
export type { Figure };
