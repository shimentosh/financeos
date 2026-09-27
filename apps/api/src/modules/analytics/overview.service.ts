import { addDays, diffDays, previousRange, receivableState, startOfMonth } from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { goalContributions, goals, inboxItems, integrationConnections, liabilities, projects, receivables, transactions } from "../../db/schema/index.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { FxService } from "../ledger/fx.service.js";
import { PlanningCalendarService } from "../planning/calendar.service.js";
import { NetWorthService } from "../wealth/net-worth.service.js";
import { AnalyticsService } from "./analytics.service.js";

/** The dashboard's single read model: one request, every section. */
@Injectable()
export class OverviewService {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(FxService) private readonly fx: FxService,
    @Inject(NetWorthService) private readonly netWorthService: NetWorthService,
    @Inject(PlanningCalendarService) private readonly calendar: PlanningCalendarService,
  ) {}

  private async toBase(ctx: WorkspaceContext, amount: number, currency: string) {
    return currency === ctx.baseCurrency ? amount : this.fx.tryConvert(amount, currency, ctx.baseCurrency, todayFor(ctx), ctx.workspaceId);
  }

  /** Net worth from the wealth module, with its completeness warnings. */
  private async netWorth(ctx: WorkspaceContext) {
    const data = await this.netWorthService.summary(ctx);
    return {
      value: data.netWorth,
      previous: data.previous,
      change: data.change,
      changePct: data.changePercent,
      complete: data.complete,
      warnings: data.warnings.map((w) => ({ code: w.code, message: w.message })),
      assets: data.assets.total,
      liabilities: data.liabilities.total,
      trend: data.trend,
    };
  }

  async overview(ctx: WorkspaceContext) {
    const today = todayFor(ctx);
    const month = this.analytics.monthRange(ctx);
    const monthToDate = { from: month.from, to: today };
    const [compare, series, topCategories, attention, accounts, netWorth] = await Promise.all([
      this.analytics.compare(ctx, month),
      this.analytics.monthly(ctx, 12),
      this.analytics.byCategory(ctx, month),
      this.analytics.attention(ctx),
      this.accounts.list(ctx),
      this.netWorth(ctx),
    ]);

    const liquid = accounts.filter((a) => a.includeInNetWorth && !a.isLiability);
    const cash = {
      total: liquid.reduce((sum, a) => sum + Math.max(0, a.baseBalance ?? 0), 0),
      accounts: liquid.length,
      unconverted: accounts.filter((a) => a.baseBalance === null).length,
    };

    // Upcoming commitments in the next 14 days, overdue ones first, from the
    // planning calendar (which knows subscriptions and projected dates).
    const schedule = await this.calendar.upcoming(ctx, { days: 14, includeOverdue: true });
    const upcoming = schedule.items
      .filter((item) => item.status === "scheduled" || item.status === "overdue" || item.status === "projected")
      .sort((a, b) => Number(b.status === "overdue") - Number(a.status === "overdue") || a.date.localeCompare(b.date))
      .slice(0, 10)
      .map((item) => ({
        id: item.key,
        date: item.date,
        name: item.name,
        kind: item.kind,
        amount: item.amount,
        currency: item.currency,
        baseAmount: item.baseAmount,
        autoPay: item.autoPay,
        overdue: item.status === "overdue",
        direction: item.direction,
        href: item.href,
      }));

    // Receivables and payables outstanding.
    const openReceivables = await db
      .select({
        receivable: receivables,
        paid: sql<string>`coalesce((select sum(t.amount) from ${transactions} t where t.receivable_id = "receivable"."id" and t.status = 'posted' and t.direction = 'in'), 0)`,
      })
      .from(receivables)
      .where(and(eq(receivables.workspaceId, ctx.workspaceId), ne(receivables.status, "cancelled")));
    let receivableOutstanding = 0;
    let receivableOverdue = 0;
    let receivableCount = 0;
    for (const { receivable, paid } of openReceivables) {
      const state = receivableState({ amount: receivable.amount, paid: Number(paid), dueDate: receivable.dueDate, today });
      if (state.remaining <= 0) continue;
      const base = (await this.toBase(ctx, state.remaining, receivable.currency)) ?? 0;
      receivableOutstanding += base;
      receivableCount++;
      if (state.state === "overdue") receivableOverdue += base;
    }
    const openPayables = await db
      .select({
        liability: liabilities,
        moved: sql<string>`coalesce((select sum(case when t.direction = 'out' then t.amount when t.type = 'loan' then -t.amount else 0 end) from ${transactions} t where t.liability_id = "liability"."id" and t.status = 'posted'), 0)`,
      })
      .from(liabilities)
      .where(and(eq(liabilities.workspaceId, ctx.workspaceId), eq(liabilities.status, "active")));
    let payableOutstanding = 0;
    let payableCount = 0;
    for (const { liability, moved } of openPayables) {
      const outstanding = liability.openingOutstanding - Number(moved);
      if (outstanding <= 0) continue;
      payableOutstanding += (await this.toBase(ctx, outstanding, liability.currency)) ?? 0;
      payableCount++;
    }

    // Goals: current = linked account balance, or starting amount + contributions.
    const goalRows = await db
      .select({
        goal: goals,
        contributed: sql<string>`coalesce((select sum(${goalContributions.amount}) from ${goalContributions} where "goal_contribution"."goal_id" = "goal"."id"), 0)`,
      })
      .from(goals)
      .where(and(eq(goals.workspaceId, ctx.workspaceId), eq(goals.status, "active")))
      .orderBy(desc(goals.priority), asc(goals.targetDate))
      .limit(4);
    const goalList = goalRows.map(({ goal, contributed }) => {
      const linked = goal.linkedAccountId ? accounts.find((a) => a.id === goal.linkedAccountId) : null;
      const current = linked ? linked.balance : goal.startingAmount + Number(contributed);
      return {
        id: goal.id,
        name: goal.name,
        kind: goal.kind,
        current,
        target: goal.targetAmount,
        currency: goal.currency,
        targetDate: goal.targetDate,
        progress: goal.targetAmount ? Math.min(100, Math.round((current / goal.targetAmount) * 1000) / 10) : 0,
        href: goal.kind === "dream_asset" ? `/goals/dream-assets?focus=${goal.id}` : `/goals?focus=${goal.id}`,
      };
    });

    const insightRows = await db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workspaceId, ctx.workspaceId),
          eq(inboxItems.status, "open"),
          inArray(inboxItems.kind, ["anomaly", "observation", "price_change", "recurring_candidate", "forecast_warning", "budget_warning"]),
        ),
      )
      .orderBy(desc(inboxItems.createdAt))
      .limit(4);

    const connections = await db.select().from(integrationConnections).where(eq(integrationConnections.workspaceId, ctx.workspaceId));
    const failing = connections.filter((c) => c.status === "error" || c.status === "needs_attention");

    let business: {
      revenue: number;
      revenueChangePct: number | null;
      burn: number;
      projects: Array<{ id: string; name: string; color: string | null; revenue: number; cost: number; net: number; budgetUsed: number | null; href: string }>;
    } | null = null;
    if (ctx.workspaceKind === "business") {
      const threeMonths = { from: startOfMonth(addDays(month.from, -85)), to: addDays(month.from, -1) };
      const burnRows = await this.analytics.summary(ctx, threeMonths);
      const months = Math.max(1, Math.round(diffDays(threeMonths.from, threeMonths.to) / 30.4));
      const projectRows = await db.execute<{
        id: string;
        name: string;
        color: string | null;
        budget: string | null;
        revenue: string;
        cost: string;
        lifetime_cost: string;
      }>(sql`
        select p.id, p.name, p.color, p.budget_amount::text as budget,
          coalesce(sum(case when t.date >= ${monthToDate.from} and t.type = 'income' then t.base_amount when t.date >= ${monthToDate.from} and t.type = 'refund' and t.direction = 'out' then -t.base_amount else 0 end), 0)::text as revenue,
          coalesce(sum(case when t.date >= ${monthToDate.from} and t.type = 'expense' then t.base_amount when t.date >= ${monthToDate.from} and t.type = 'refund' and t.direction = 'in' then -t.base_amount else 0 end), 0)::text as cost,
          coalesce(sum(case when t.type = 'expense' then t.base_amount when t.type = 'refund' and t.direction = 'in' then -t.base_amount else 0 end), 0)::text as lifetime_cost
        from ${projects} p left join ${transactions} t on t.project_id = p.id and t.status = 'posted'
        where p.workspace_id = ${ctx.workspaceId} and p.status in ('active', 'paused')
        group by p.id order by sum(case when t.date >= ${monthToDate.from} then t.base_amount else 0 end) desc nulls last limit 6
      `);
      business = {
        revenue: compare.current.income,
        revenueChangePct: compare.incomeChangePct,
        burn: Math.round(burnRows.expenses / months),
        projects: projectRows.rows.map((row) => {
          const revenue = Number(row.revenue);
          const cost = Number(row.cost);
          const budget = row.budget ? Number(row.budget) : null;
          return {
            id: row.id,
            name: row.name,
            color: row.color,
            revenue,
            cost,
            net: revenue - cost,
            budgetUsed: budget ? Math.round((Number(row.lifetime_cost) / budget) * 1000) / 10 : null,
            href: `/business/projects/${row.id}`,
          };
        }),
      };
    }

    let forecast: { horizonDays: number; endBalance: number; lowest: { date: string; balance: number }; belowThreshold: boolean } | null = null;
    try {
      const projection = await this.analytics.forecast(ctx, 30);
      forecast = { horizonDays: 30, endBalance: projection.endBalance, lowest: projection.lowest, belowThreshold: projection.belowThreshold };
    } catch {
      forecast = null;
    }

    return {
      asOf: today,
      baseCurrency: ctx.baseCurrency,
      workspaceKind: ctx.workspaceKind,
      netWorth,
      cash,
      month: {
        from: month.from,
        to: month.to,
        income: compare.current.income,
        expenses: compare.current.expenses,
        net: compare.current.net,
        savingsRate: compare.current.rate,
        incomeChangePct: compare.incomeChangePct,
        expenseChangePct: compare.expenseChangePct,
        previous: previousRange(month),
      },
      series,
      topCategories: topCategories.slice(0, 6),
      business,
      upcoming,
      receivables: { outstanding: receivableOutstanding, overdue: receivableOverdue, count: receivableCount, href: "/wealth/receivables" },
      payables: { outstanding: payableOutstanding, count: payableCount, href: "/wealth/liabilities?view=payables" },
      goals: goalList,
      insights: insightRows.map((item) => ({
        id: item.id,
        kind: item.kind,
        severity: item.severity,
        title: item.title,
        body: item.body,
        href:
          (item.data.href as string | undefined) ??
          (item.data.transactionIds?.length ? `/transactions?ids=${item.data.transactionIds.join(",")}&period=all_time` : null),
      })),
      integrations: {
        total: connections.length,
        healthy: connections.filter((c) => c.status === "connected").length,
        failing: failing.length,
        lastSyncedAt: connections.reduce<string | null>(
          (latest, c) => (c.lastSyncedAt && (!latest || c.lastSyncedAt.toISOString() > latest) ? c.lastSyncedAt.toISOString() : latest),
          null,
        ),
        items: connections
          .slice(0, 5)
          .map((c) => ({ id: c.id, name: c.name, provider: c.provider, status: c.status, lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null })),
      },
      attention: {
        drafts: attention.drafts,
        uncategorized: attention.uncategorized,
        duplicates: attention.duplicates,
        overdueCommitments: attention.overdueCommitments,
        overdueReceivables: attention.overdueReceivables,
      },
      forecast,
    };
  }
}
