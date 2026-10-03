import {
  addDays,
  addMonths,
  type CopilotFact,
  type CopilotSource,
  type Day,
  endOfMonth,
  formatMoney,
  minDay,
  normalizeName,
  previousRange,
  type Range,
  startOfMonth,
} from "@financeos/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { counterparties } from "../../db/schema/index.js";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { ProjectFinanceService } from "../business/project-finance.service.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { CategoriesService, ProjectsService } from "../ledger/catalog.service.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { BudgetsService } from "../planning/budgets.service.js";
import { PlanningCalendarService } from "../planning/calendar.service.js";
import { GoalsService } from "../planning/goals.service.js";
import { ACTIVE_SUBSCRIPTION_STATUSES, SubscriptionsService } from "../planning/subscriptions.service.js";
import { LiabilitiesService } from "../wealth/liabilities.service.js";
import { NetWorthService } from "../wealth/net-worth.service.js";
import { ReceivablesService } from "../wealth/receivables.service.js";

/**
 * What a query returns: compact JSON for the model (money already formatted,
 * so it never converts minor units itself), the exact figures to show beside
 * the answer, and the records they come from.
 */
export type QueryResult = { data: Record<string, unknown>; facts: CopilotFact[]; sources: CopilotSource[] };

const LIQUID_KINDS = new Set(["bank", "cash", "mobile_wallet", "digital_wallet", "payment_processor", "savings"]);

function qs(params: Record<string, string | number | boolean | string[] | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return search.toString();
}

/** The period to compare against: the same days last month for a month so far, else the one just before. */
export function previousPeriod(range: Range): Range {
  if (range.from === startOfMonth(range.from) && range.to.slice(0, 7) === range.from.slice(0, 7) && range.to !== endOfMonth(range.from)) {
    const from = addMonths(range.from, -1);
    return { from, to: minDay(addMonths(range.to, -1), endOfMonth(from)) };
  }
  return previousRange(range);
}

const txHref = (params: Record<string, string | number | boolean | string[] | null | undefined>) => `/transactions?${qs(params)}`;

/**
 * The copilot's controlled query layer: read-only, workspace-scoped queries
 * over the same services the dashboard uses. Nothing here writes, and every
 * figure carries a link to the records behind it. The model reaches the
 * ledger only through these methods (as tools); the built-in answers use
 * them directly.
 */
@Injectable()
export class CopilotQueries {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(NetWorthService) private readonly netWorthService: NetWorthService,
    @Inject(PlanningCalendarService) private readonly calendar: PlanningCalendarService,
    @Inject(SubscriptionsService) private readonly subscriptionsService: SubscriptionsService,
    @Inject(BudgetsService) private readonly budgetsService: BudgetsService,
    @Inject(ReceivablesService) private readonly receivablesService: ReceivablesService,
    @Inject(LiabilitiesService) private readonly liabilitiesService: LiabilitiesService,
    @Inject(GoalsService) private readonly goalsService: GoalsService,
    @Inject(ProjectFinanceService) private readonly projectFinance: ProjectFinanceService,
  ) {}

  private money(ctx: WorkspaceContext, minor: number | null | undefined, currency = ctx.baseCurrency) {
    return minor === null || minor === undefined ? "unknown (no exchange rate)" : formatMoney(minor, currency);
  }

  // ------------------------------------------------------------ resolution

  /** A category named in the text or by the parser's hint (with its subcategories). */
  async findCategory(ctx: WorkspaceContext, text: string, hint: string | null, kind: "expense" | "income" = "expense") {
    if (hint) {
      const byHint = await this.categories.resolveName(ctx, hint, kind);
      if (byHint) return byHint;
    }
    const wanted = ` ${normalizeName(text)} `;
    const all = (await this.categories.list(ctx)).filter((c) => c.kind === kind);
    // Longest name first: "Food & Dining" before "Food".
    return (
      all.sort((a, b) => b.name.length - a.name.length).find((c) => normalizeName(c.name).length >= 3 && wanted.includes(` ${normalizeName(c.name)} `)) ?? null
    );
  }

  async findProject(ctx: WorkspaceContext, text: string) {
    const wanted = ` ${normalizeName(text)} `;
    const all = await this.projects.list(ctx);
    return (
      all.find((p) => normalizeName(p.name).length >= 3 && wanted.includes(` ${normalizeName(p.name)} `)) ??
      all.find((p) => p.code && normalizeName(p.code).length >= 2 && wanted.includes(` ${normalizeName(p.code)} `)) ??
      null
    );
  }

  /** A payee or customer named in the text ("How much did I pay Foodpanda?"). */
  async findCounterparty(ctx: WorkspaceContext, text: string) {
    const wanted = ` ${normalizeName(text)} `;
    const rows = await db
      .select({ id: counterparties.id, name: counterparties.name })
      .from(counterparties)
      .where(and(eq(counterparties.workspaceId, ctx.workspaceId), sql`length(${counterparties.name}) >= 3`))
      .limit(2000);
    return rows.sort((a, b) => b.name.length - a.name.length).find((c) => wanted.includes(` ${normalizeName(c.name)} `)) ?? null;
  }

  // ------------------------------------------------------------ queries

  /** Income, spending and net for a period (transfers, loans, investments excluded). */
  async summary(ctx: WorkspaceContext, range: Range, filters: { projectId?: string; projectName?: string } = {}): Promise<QueryResult> {
    const s = await this.analytics.summary(ctx, range, { projectId: filters.projectId });
    const base = { from: range.from, to: range.to, status: "posted", projectId: filters.projectId };
    const incomeHref = txHref({ ...base, type: ["income", "refund"] });
    const spendHref = txHref({ ...base, type: ["expense", "refund"] });
    return {
      data: {
        period: range,
        project: filters.projectName ?? null,
        income: this.money(ctx, s.income),
        expenses: this.money(ctx, s.expenses),
        net: this.money(ctx, s.net),
        savingsRatePercent: s.rate,
        note: "Transfers, loans, debt payments, investments, asset purchases and owner equity are not income or spending.",
      },
      facts: [
        { label: "Income", value: this.money(ctx, s.income), href: incomeHref, tone: "positive" },
        { label: "Spending", value: this.money(ctx, s.expenses), href: spendHref, tone: "negative" },
        { label: "Net", value: this.money(ctx, s.net), href: txHref(base), tone: s.net >= 0 ? "positive" : "negative" },
      ],
      sources: [{ label: `Transactions ${range.from} – ${range.to}`, href: txHref(base) }],
    };
  }

  /** Spending (expenses less refunds) for a period, optionally for a category, payee or project. */
  async spending(
    ctx: WorkspaceContext,
    range: Range,
    filters: {
      categoryId?: string;
      categoryName?: string;
      counterpartyId?: string;
      counterpartyName?: string;
      projectId?: string;
      projectName?: string;
      kind?: "expense" | "income";
    } = {},
  ): Promise<QueryResult> {
    const kind = filters.kind ?? "expense";
    const query = {
      from: range.from,
      to: range.to,
      type: kind === "expense" ? ["expense", "refund"] : ["income", "refund"],
      status: ["posted"],
      categoryId: filters.categoryId,
      counterpartyId: filters.counterpartyId,
      projectId: filters.projectId,
    };
    const result = await this.transactions.list(ctx, { ...query, includeChildren: true, pageSize: 5, sort: "amount_desc" });
    const total = kind === "expense" ? result.totals.expense : result.totals.income;
    const href = txHref(query);
    const scope =
      [filters.categoryName, filters.counterpartyName, filters.projectName].filter(Boolean).join(" · ") || (kind === "expense" ? "All spending" : "All income");
    return {
      data: {
        period: range,
        scope,
        kind,
        total: this.money(ctx, total),
        transactions: result.total,
        largest: result.items
          .filter((row) => row.type !== "refund")
          .map((row) => ({
            date: row.date,
            payee: row.counterpartyName ?? row.merchant ?? row.description,
            amount: this.money(ctx, row.amount, row.currency),
            category: row.categoryName,
          })),
      },
      facts: [
        {
          label: kind === "expense" ? `Spent · ${scope}` : `Earned · ${scope}`,
          value: this.money(ctx, total),
          href,
          tone: kind === "expense" ? "negative" : "positive",
        },
        { label: "Transactions", value: String(result.total), href },
      ],
      sources: [{ label: `${scope}, ${range.from} – ${range.to}`, href }],
    };
  }

  /** Where money went (or came from) by top-level category. */
  async categoryBreakdown(ctx: WorkspaceContext, range: Range, kind: "expense" | "income" = "expense"): Promise<QueryResult> {
    const rows = (await this.analytics.byCategory(ctx, range, kind)).slice(0, 8);
    return {
      data: {
        period: range,
        kind,
        categories: rows.map((row) => ({ name: row.name, amount: this.money(ctx, row.amount), sharePercent: row.share, transactions: row.count })),
      },
      facts: rows.slice(0, 5).map((row) => ({ label: row.name, value: `${this.money(ctx, row.amount)} · ${row.share}%`, href: row.href })),
      sources: rows.slice(0, 5).map((row) => ({ label: row.name, href: row.href })),
    };
  }

  async merchantBreakdown(ctx: WorkspaceContext, range: Range, kind: "expense" | "income" = "expense"): Promise<QueryResult> {
    const rows = await this.analytics.topMerchants(ctx, range, kind, 8);
    return {
      data: { period: range, kind, payees: rows.map((row) => ({ name: row.name, amount: this.money(ctx, row.amount), transactions: row.count })) },
      facts: rows.slice(0, 5).map((row) => ({ label: row.name, value: this.money(ctx, row.amount), href: row.href })),
      sources: rows.slice(0, 5).map((row) => ({ label: row.name, href: row.href })),
    };
  }

  /**
   * A period against another: by default the same days of the month before
   * for a month so far (1–26 Sep against 1–26 Aug), otherwise the equally
   * long period just before.
   */
  async compare(ctx: WorkspaceContext, range: Range, previous?: Range): Promise<QueryResult> {
    const before = previous ?? previousPeriod(range);
    const [current, prior] = await Promise.all([this.analytics.summary(ctx, range), this.analytics.summary(ctx, before)]);
    const change = (from: number, to: number) => (from === 0 ? null : Math.round(((to - from) / Math.abs(from)) * 1000) / 10);
    const spendingChange = change(prior.expenses, current.expenses);
    const hrefFor = (r: Range) => txHref({ from: r.from, to: r.to, status: "posted", type: ["expense", "refund"] });
    return {
      data: {
        current: { period: range, income: this.money(ctx, current.income), expenses: this.money(ctx, current.expenses), net: this.money(ctx, current.net) },
        previous: { period: before, income: this.money(ctx, prior.income), expenses: this.money(ctx, prior.expenses), net: this.money(ctx, prior.net) },
        incomeChangePercent: change(prior.income, current.income),
        spendingChangePercent: spendingChange,
      },
      facts: [
        { label: `Spending ${range.from} – ${range.to}`, value: this.money(ctx, current.expenses), href: hrefFor(range) },
        { label: `Spending ${before.from} – ${before.to}`, value: this.money(ctx, prior.expenses), href: hrefFor(before) },
        {
          label: "Change",
          value: spendingChange === null ? "—" : `${spendingChange > 0 ? "+" : ""}${spendingChange}%`,
          tone: (spendingChange ?? 0) > 0 ? "negative" : "positive",
        },
        {
          label: `Income ${range.from} – ${range.to}`,
          value: this.money(ctx, current.income),
          href: txHref({ from: range.from, to: range.to, status: "posted", type: ["income", "refund"] }),
        },
      ],
      sources: [
        { label: `${range.from} – ${range.to}`, href: hrefFor(range) },
        { label: `${before.from} – ${before.to}`, href: hrefFor(before) },
      ],
    };
  }

  /** Account balances today and the cash on hand across liquid accounts. */
  async balances(ctx: WorkspaceContext): Promise<QueryResult> {
    const rows = await this.accounts.list(ctx);
    const liquid = rows.filter((a) => LIQUID_KINDS.has(a.kind) && !a.isLiability);
    const cash = liquid.reduce((sum, a) => sum + (a.baseBalance ?? 0), 0);
    const unconverted = rows.filter((a) => a.baseBalance === null).map((a) => a.name);
    const owed = rows.filter((a) => a.isLiability).reduce((sum, a) => sum + Math.min(0, a.baseBalance ?? 0), 0);
    return {
      data: {
        asOf: todayFor(ctx),
        cashOnHand: this.money(ctx, cash),
        creditOwed: this.money(ctx, -owed),
        accounts: rows.map((a) => ({
          name: a.name,
          kind: a.kind,
          balance: this.money(ctx, a.balance, a.currency),
          inBaseCurrency: a.currency === ctx.baseCurrency ? undefined : this.money(ctx, a.baseBalance),
        })),
        warnings: unconverted.length ? [`No exchange rate for: ${unconverted.join(", ")}; not included in totals.`] : [],
      },
      facts: [
        { label: "Cash on hand", value: this.money(ctx, cash), href: "/accounts", tone: cash >= 0 ? "positive" : "negative" },
        ...rows
          .filter((a) => a.balance !== 0 || !a.isLiability)
          .slice(0, 6)
          .map((a) => ({
            label: a.name,
            value: this.money(ctx, a.balance, a.currency),
            href: `/accounts/${a.id}`,
            tone: a.balance < 0 ? ("negative" as const) : null,
          })),
      ],
      sources: [{ label: "Accounts", href: "/accounts" }],
    };
  }

  async netWorth(ctx: WorkspaceContext): Promise<QueryResult> {
    const s = await this.netWorthService.summary(ctx);
    return {
      data: {
        asOf: s.asOf,
        netWorth: this.money(ctx, s.netWorth),
        changeSinceLastMonth: s.change === null ? null : this.money(ctx, s.change),
        changePercent: s.changePercent,
        assets: this.money(ctx, s.assets.total),
        liabilities: this.money(ctx, s.liabilities.total),
        complete: s.complete,
        warnings: s.warnings.map((w) => (typeof w === "string" ? w : ((w as { message?: string }).message ?? JSON.stringify(w)))),
      },
      facts: [
        { label: "Net worth", value: this.money(ctx, s.netWorth), href: "/wealth/net-worth", tone: s.netWorth >= 0 ? "positive" : "negative" },
        { label: "Assets", value: this.money(ctx, s.assets.total), href: "/wealth/net-worth" },
        { label: "Liabilities", value: this.money(ctx, s.liabilities.total), href: "/wealth/liabilities" },
        ...(s.complete
          ? []
          : [
              {
                label: "Incomplete",
                value: `${s.warningCount} warning${s.warningCount === 1 ? "" : "s"}`,
                href: "/wealth/net-worth",
                tone: "warning" as const,
              },
            ]),
      ],
      sources: [{ label: "Net worth", href: "/wealth/net-worth" }],
    };
  }

  /** Bills, renewals, installments and expected income due soon, overdue first. */
  async upcoming(ctx: WorkspaceContext, days = 30): Promise<QueryResult> {
    const result = await this.calendar.upcoming(ctx, { days: Math.min(366, Math.max(1, days)), includeOverdue: true });
    const items = result.items.filter((item) => item.status === "scheduled" || item.status === "overdue" || item.status === "projected");
    items.sort((a, b) => (a.status === "overdue" ? 0 : 1) - (b.status === "overdue" ? 0 : 1) || a.date.localeCompare(b.date));
    const href = (item: (typeof items)[number]) => (item.subscriptionId ? `/subscriptions/${item.subscriptionId}` : `/commitments?focus=${item.commitmentId}`);
    return {
      data: {
        from: result.from,
        to: result.to,
        dueOut: this.money(ctx, result.totals.out),
        expectedIn: this.money(ctx, result.totals.in),
        items: items.slice(0, 20).map((item) => ({
          date: item.date,
          name: item.name,
          kind: item.kindLabel,
          direction: item.direction,
          amount: this.money(ctx, item.amount, item.currency),
          status: item.status === "overdue" ? "overdue — payment not recorded" : item.status,
          autoPay: item.autoPay,
        })),
      },
      facts: [
        { label: `Due in ${result.days} days`, value: this.money(ctx, result.totals.out), href: "/commitments", tone: "negative" },
        ...items.slice(0, 5).map((item) => ({
          label: `${item.name} · ${item.date}`,
          value: this.money(ctx, item.amount, item.currency),
          href: href(item),
          tone: item.status === "overdue" ? ("warning" as const) : null,
        })),
      ],
      sources: [{ label: "Upcoming payments", href: "/commitments" }, ...items.slice(0, 3).map((item) => ({ label: item.name, href: href(item) }))],
    };
  }

  async subscriptions(ctx: WorkspaceContext): Promise<QueryResult> {
    const [a, list] = await Promise.all([this.subscriptionsService.analytics(ctx), this.subscriptionsService.list(ctx, { sort: "monthly_desc" })]);
    const active = list.items.filter((item) => ACTIVE_SUBSCRIPTION_STATUSES.has(item.derivedStatus));
    return {
      data: {
        active: a.activeCount,
        monthlyTotal: this.money(ctx, a.monthlyTotal),
        annualTotal: this.money(ctx, a.annualTotal),
        renewingIn30Days: { count: a.upcoming30.count, total: this.money(ctx, a.upcoming30.total) },
        overdue: a.overdue.count,
        subscriptions: active.slice(0, 15).map((item) => ({
          name: item.name,
          amount: this.money(ctx, item.amount, item.currency),
          billingCycle: item.billingCycle,
          monthlyEquivalent: this.money(ctx, item.monthlyEquivalentBase),
          nextRenewal: item.nextRenewalDate,
          autoRenew: item.autoRenew,
          status: item.statusLabel,
        })),
      },
      facts: [
        { label: "Active subscriptions", value: String(a.activeCount), href: "/subscriptions" },
        { label: "Per month", value: this.money(ctx, a.monthlyTotal), href: "/subscriptions", tone: "negative" },
        { label: "Per year", value: this.money(ctx, a.annualTotal), href: "/subscriptions" },
        ...active
          .slice(0, 3)
          .map((item) => ({ label: item.name, value: `${this.money(ctx, item.monthlyEquivalentBase)}/mo`, href: `/subscriptions/${item.id}` })),
      ],
      sources: [{ label: "Subscriptions", href: "/subscriptions" }],
    };
  }

  async budgets(ctx: WorkspaceContext): Promise<QueryResult> {
    const result = await this.budgetsService.list(ctx, { active: true });
    const items = result.items.filter((item) => item.inEffect).sort((a, b) => b.metrics.utilization - a.metrics.utilization);
    return {
      data: {
        summary: result.summary,
        budgets: items.map((item) => ({
          name: item.name,
          period: item.range,
          budget: this.money(ctx, item.amount),
          spent: this.money(ctx, item.metrics.actual),
          remaining: this.money(ctx, item.metrics.remaining),
          usedPercent: item.metrics.utilization,
          status: item.metrics.status,
          projectedByPeriodEnd: item.metrics.projected === null ? null : this.money(ctx, item.metrics.projected),
        })),
      },
      facts: items.slice(0, 6).map((item) => ({
        label: item.name,
        value: `${this.money(ctx, item.metrics.actual)} of ${this.money(ctx, item.amount)} · ${item.metrics.utilization}%`,
        href: item.drilldown.href,
        tone: item.metrics.status === "over" ? ("negative" as const) : item.metrics.status === "warning" ? ("warning" as const) : ("positive" as const),
      })),
      sources: [{ label: "Budgets", href: "/budgets" }],
    };
  }

  /** Projected cash; always an estimate. */
  async forecast(ctx: WorkspaceContext, days = 30): Promise<QueryResult> {
    const horizon = Math.min(180, Math.max(7, days));
    const f = await this.analytics.forecast(ctx, horizon);
    const confirmed = f.events.filter((e) => e.certainty === "confirmed");
    return {
      data: {
        label: "estimate",
        horizonDays: horizon,
        startBalance: this.money(ctx, f.startBalance),
        endBalance: this.money(ctx, f.endBalance),
        lowest: { date: f.lowest.date, balance: this.money(ctx, f.lowest.balance) },
        scheduledIn: this.money(ctx, f.scheduledIn),
        scheduledOut: this.money(ctx, f.scheduledOut),
        typicalUnscheduledSpending: this.money(ctx, f.discretionaryOut),
        lowCashThreshold: this.money(ctx, f.threshold),
        fallsBelowThreshold: f.belowThreshold,
        biggestEvents: [...f.events]
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
          .slice(0, 8)
          .map((e) => ({ date: e.date, label: e.label, amount: this.money(ctx, e.amount), certainty: e.certainty })),
        assumptions: f.assumptions,
        unconvertedAccounts: f.unconvertedAccounts,
      },
      facts: [
        { label: "Cash today", value: this.money(ctx, f.startBalance), href: "/accounts" },
        { label: `In ${horizon} days`, value: this.money(ctx, f.endBalance), href: "/ai/forecasts", estimate: true },
        {
          label: `Lowest (${f.lowest.date})`,
          value: this.money(ctx, f.lowest.balance),
          href: "/ai/forecasts",
          estimate: true,
          tone: f.belowThreshold ? "warning" : null,
        },
        { label: "Scheduled out", value: this.money(ctx, f.scheduledOut), href: "/commitments", estimate: confirmed.length === 0 },
      ],
      sources: [{ label: "Cash forecast (estimate)", href: "/ai/forecasts" }],
    };
  }

  async receivables(ctx: WorkspaceContext): Promise<QueryResult> {
    const result = await this.receivablesService.list(ctx, { status: ["pending", "partially_paid", "overdue"] });
    const items = [...result.items].sort((a, b) => b.daysOverdue - a.daysOverdue || (b.baseRemaining ?? 0) - (a.baseRemaining ?? 0));
    return {
      data: {
        outstanding: this.money(ctx, result.totals.outstanding),
        overdue: { count: result.totals.overdueCount, amount: this.money(ctx, result.totals.overdueAmount) },
        items: items.slice(0, 15).map((item) => ({
          who: item.counterpartyName,
          what: item.title,
          remaining: this.money(ctx, item.remaining, item.currency),
          dueDate: item.dueDate,
          status: item.status,
          daysOverdue: item.daysOverdue || undefined,
        })),
      },
      facts: [
        { label: "Owed to you", value: this.money(ctx, result.totals.outstanding), href: "/wealth/receivables", tone: "positive" },
        ...(result.totals.overdueCount
          ? [
              {
                label: `Overdue (${result.totals.overdueCount})`,
                value: this.money(ctx, result.totals.overdueAmount),
                href: "/wealth/receivables?status=overdue",
                tone: "warning" as const,
              },
            ]
          : []),
        ...items
          .slice(0, 4)
          .map((item) => ({ label: item.counterpartyName, value: this.money(ctx, item.remaining, item.currency), href: `/wealth/receivables/${item.id}` })),
      ],
      sources: [{ label: "Receivables", href: "/wealth/receivables" }],
    };
  }

  async liabilities(ctx: WorkspaceContext): Promise<QueryResult> {
    const result = await this.liabilitiesService.list(ctx);
    const open = result.items.filter((item) => item.status !== "cancelled" && item.status !== "paid_off" && item.outstanding > 0);
    open.sort((a, b) => (b.baseOutstanding ?? 0) - (a.baseOutstanding ?? 0));
    return {
      data: {
        outstanding: this.money(ctx, result.totals.outstanding),
        overdue: { count: result.totals.overdueCount, amount: this.money(ctx, result.totals.overdueOutstanding) },
        byKind: result.groups.map((g) => ({ kind: g.kind, count: g.count, outstanding: this.money(ctx, g.outstanding) })),
        items: open.slice(0, 15).map((item) => ({
          name: item.name,
          to: item.counterparty,
          kind: item.kind,
          outstanding: this.money(ctx, item.outstanding, item.currency),
          dueDate: item.dueDate,
          status: item.status,
        })),
      },
      facts: [
        { label: "You owe", value: this.money(ctx, result.totals.outstanding), href: "/wealth/liabilities", tone: "negative" },
        ...open
          .slice(0, 4)
          .map((item) => ({ label: item.name, value: this.money(ctx, item.outstanding, item.currency), href: `/wealth/liabilities/${item.id}` })),
      ],
      sources: [{ label: "Liabilities", href: "/wealth/liabilities" }],
    };
  }

  async goals(ctx: WorkspaceContext): Promise<QueryResult> {
    const result = await this.goalsService.list(ctx, { status: ["active"] });
    return {
      data: {
        active: result.summary.active,
        saved: this.money(ctx, result.summary.currentBase),
        target: this.money(ctx, result.summary.targetBase),
        plannedPerMonth: this.money(ctx, result.summary.monthlyPlanned),
        goals: result.items.map((item) => ({
          name: item.name,
          kind: item.kind,
          target: this.money(ctx, item.progress.target, item.currency),
          saved: this.money(ctx, item.progress.current, item.currency),
          progressPercent: item.progress.progress,
          targetDate: item.targetDate,
          neededPerMonth: item.progress.requiredMonthly === null ? null : this.money(ctx, item.progress.requiredMonthly, item.currency),
          plannedPerMonth: item.monthlyPlan ? this.money(ctx, item.monthlyPlan, item.currency) : null,
          onTrack: item.progress.onTrack,
          projectedCompletion: item.progress.projectedCompletion,
        })),
      },
      facts: result.items.slice(0, 5).map((item) => ({
        label: item.name,
        value: `${this.money(ctx, item.progress.current, item.currency)} of ${this.money(ctx, item.progress.target, item.currency)} · ${item.progress.progress}%`,
        href: item.links.self,
        tone: item.progress.onTrack === false ? ("warning" as const) : null,
      })),
      sources: [{ label: "Goals", href: "/goals" }],
    };
  }

  /** Revenue, cost, net and burn per project (business workspaces). */
  async projectsOverview(ctx: WorkspaceContext, range: Range, projectId?: string): Promise<QueryResult> {
    if (ctx.workspaceKind !== "business") {
      return { data: { note: "Projects are tracked in business workspaces." }, facts: [], sources: [] };
    }
    const overview = await this.projectFinance.overview(ctx, { from: range.from, to: range.to });
    // A named project always answers; otherwise only projects with money in the period.
    const rows = projectId
      ? overview.projects.filter((p) => p.project.id === projectId)
      : overview.projects.filter((p) => p.actual.revenue.amount !== 0 || p.actual.cost.amount !== 0);
    return {
      data: {
        period: range,
        projects: rows.map((p) => ({
          name: p.project.name,
          revenue: this.money(ctx, p.actual.revenue.amount),
          cost: this.money(ctx, p.actual.cost.amount),
          net: this.money(ctx, p.actual.netContribution),
          marginPercent: p.actual.margin,
          monthlyBurn: this.money(ctx, p.actual.monthlyBurn),
          budget: p.actual.budget ? { amount: this.money(ctx, p.actual.budget.amount), usedPercent: p.actual.budget.utilization } : null,
          runwayMonthsEstimate: p.estimated.runwayMonths,
          recurringMonthlyCostEstimate: this.money(ctx, p.estimated.recurringMonthlyCost),
        })),
        totals: projectId
          ? undefined
          : {
              revenue: this.money(ctx, overview.totals.revenue),
              cost: this.money(ctx, overview.totals.cost),
              net: this.money(ctx, overview.totals.netContribution),
            },
      },
      facts: rows.slice(0, 4).flatMap((p) => [
        {
          label: `${p.project.name} · net`,
          value: this.money(ctx, p.actual.netContribution),
          href: `/business/projects/${p.project.id}`,
          tone: p.actual.netContribution >= 0 ? ("positive" as const) : ("negative" as const),
        },
        ...(projectId
          ? [
              {
                label: "Revenue",
                value: this.money(ctx, p.actual.revenue.amount),
                href: txHref({ from: range.from, to: range.to, status: "posted", type: ["income", "refund"], projectId: p.project.id }),
              },
              {
                label: "Cost",
                value: this.money(ctx, p.actual.cost.amount),
                href: txHref({ from: range.from, to: range.to, status: "posted", type: ["expense", "refund"], projectId: p.project.id }),
              },
            ]
          : []),
      ]),
      sources: rows.slice(0, 4).map((p) => ({ label: p.project.name, href: `/business/projects/${p.project.id}` })),
    };
  }

  /** Individual transactions matching a search, newest or largest first. */
  async searchTransactions(
    ctx: WorkspaceContext,
    input: {
      from?: Day;
      to?: Day;
      q?: string;
      types?: string[];
      categoryId?: string;
      projectId?: string;
      minAmount?: number;
      maxAmount?: number;
      sort?: "date_desc" | "amount_desc";
      limit?: number;
    },
  ): Promise<QueryResult> {
    const today = todayFor(ctx);
    const query = {
      from: input.from ?? addDays(today, -90),
      to: input.to ?? today,
      q: input.q,
      type: input.types,
      status: ["posted", "pending", "draft"],
      categoryId: input.categoryId,
      projectId: input.projectId,
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
    };
    const result = await this.transactions.list(ctx, { ...query, sort: input.sort ?? "date_desc", pageSize: Math.min(25, input.limit ?? 10) });
    const href = txHref(query);
    return {
      data: {
        matching: result.total,
        spending: this.money(ctx, result.totals.expense),
        income: this.money(ctx, result.totals.income),
        transactions: result.items.map((row) => ({
          date: row.date,
          type: row.type,
          status: row.status,
          payee: row.counterpartyName ?? row.merchant ?? null,
          description: row.description,
          amount: this.money(ctx, row.amount, row.currency),
          account: row.accountName,
          category: row.categoryName,
          project: row.projectName,
        })),
      },
      facts: result.items.slice(0, 5).map((row) => ({
        label: `${row.date} · ${row.counterpartyName ?? row.merchant ?? row.description ?? row.type}`,
        value: this.money(ctx, row.amount, row.currency),
        href: txHref({ period: "all_time", ids: row.id }),
      })),
      sources: [{ label: `${result.total} matching transactions`, href }],
    };
  }
}
