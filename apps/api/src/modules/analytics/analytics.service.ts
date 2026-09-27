import {
  addDays,
  addMonths,
  cashFlowStatement,
  type Day,
  diffDays,
  dueDatesBetween,
  eachMonth,
  endOfMonth,
  type ForecastEvent,
  forecastCash,
  incomeStatement,
  monthKey,
  percentChange,
  previousRange,
  type Range,
  receivableState,
  startOfMonth,
} from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { categories, commitments, financialAccounts, ledgerEntries, liabilities, receivables, transactions } from "../../db/schema/index.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { FxService } from "../ledger/fx.service.js";

const LIQUID_KINDS = ["bank", "cash", "mobile_wallet", "digital_wallet", "payment_processor", "savings"] as const;

export type MonthPoint = { month: string; income: number; expenses: number; net: number };

export type CategoryShare = {
  categoryId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  amount: number;
  count: number;
  share: number;
  href: string;
};

/**
 * Read models over the ledger. Every figure comes from posted transactions
 * and their entries, in the workspace base currency, and carries the query
 * that reproduces it so the UI can show the records behind it.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  private posted(ctx: WorkspaceContext, range?: Partial<Range>) {
    return and(
      eq(transactions.workspaceId, ctx.workspaceId),
      eq(transactions.status, "posted"),
      range?.from ? gte(transactions.date, range.from) : undefined,
      range?.to ? lte(transactions.date, range.to) : undefined,
    );
  }

  /** Income, spending and net for a range (refunds net against their side). */
  async summary(ctx: WorkspaceContext, range: Range, filters: { projectId?: string } = {}) {
    const rows = await db
      .select({ type: transactions.type, direction: transactions.direction, amount: sql<string>`coalesce(sum(${transactions.baseAmount}), 0)` })
      .from(transactions)
      .where(and(this.posted(ctx, range), filters.projectId ? eq(transactions.projectId, filters.projectId) : undefined))
      .groupBy(transactions.type, transactions.direction);
    return incomeStatement(rows.map((row) => ({ type: row.type, direction: row.direction, amount: Number(row.amount) })));
  }

  /** Summary for a range and the equally long range before it. */
  async compare(ctx: WorkspaceContext, range: Range) {
    const previous = previousRange(range);
    const [current, before] = await Promise.all([this.summary(ctx, range), this.summary(ctx, previous)]);
    return {
      range,
      previousRange: previous,
      current,
      previous: before,
      incomeChangePct: percentChange(before.income, current.income),
      expenseChangePct: percentChange(before.expenses, current.expenses),
      netChangePct: percentChange(before.net, current.net),
    };
  }

  /** Income and spending per calendar month, oldest first, gaps filled. */
  async monthly(ctx: WorkspaceContext, months = 12, filters: { projectId?: string; categoryIds?: string[] } = {}): Promise<MonthPoint[]> {
    const today = todayFor(ctx);
    const from = startOfMonth(addMonths(today, -(months - 1)));
    const to = endOfMonth(today);
    const rows = await db
      .select({
        month: sql<string>`to_char(${transactions.date}::date, 'YYYY-MM')`,
        type: transactions.type,
        direction: transactions.direction,
        amount: sql<string>`coalesce(sum(${transactions.baseAmount}), 0)`,
      })
      .from(transactions)
      .where(
        and(
          this.posted(ctx, { from, to }),
          inArray(transactions.type, ["income", "expense", "refund"]),
          filters.projectId ? eq(transactions.projectId, filters.projectId) : undefined,
          filters.categoryIds?.length ? inArray(transactions.categoryId, filters.categoryIds) : undefined,
        ),
      )
      .groupBy(sql`1`, transactions.type, transactions.direction);
    const byMonth = new Map<string, Array<{ type: (typeof rows)[number]["type"]; direction: "in" | "out"; amount: number }>>();
    for (const row of rows) {
      const list = byMonth.get(row.month) ?? [];
      list.push({ type: row.type, direction: row.direction, amount: Number(row.amount) });
      byMonth.set(row.month, list);
    }
    return eachMonth(from, to).map((month) => {
      const statement = incomeStatement(byMonth.get(month) ?? []);
      return { month, income: statement.income, expenses: statement.expenses, net: statement.net };
    });
  }

  /**
   * Spending (or income) by category for a range. Subcategories roll up into
   * their parent; each row links to its transactions.
   */
  async byCategory(
    ctx: WorkspaceContext,
    range: Range,
    kind: "expense" | "income" = "expense",
    filters: { projectId?: string } = {},
  ): Promise<CategoryShare[]> {
    const sign =
      kind === "expense"
        ? sql`case when ${transactions.type} = 'expense' then 1 when ${transactions.type} = 'refund' and ${transactions.direction} = 'in' then -1 else 0 end`
        : sql`case when ${transactions.type} = 'income' then 1 when ${transactions.type} = 'refund' and ${transactions.direction} = 'out' then -1 else 0 end`;
    const rows = await db
      .select({
        categoryId: transactions.categoryId,
        amount: sql<string>`coalesce(sum(${transactions.baseAmount} * ${sign}), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .where(
        and(
          this.posted(ctx, range),
          inArray(transactions.type, kind === "expense" ? ["expense", "refund"] : ["income", "refund"]),
          filters.projectId ? eq(transactions.projectId, filters.projectId) : undefined,
        ),
      )
      .groupBy(transactions.categoryId);
    const all = await db.select().from(categories).where(eq(categories.workspaceId, ctx.workspaceId));
    const byId = new Map(all.map((c) => [c.id, c]));
    const rolled = new Map<string, { amount: number; count: number }>();
    for (const row of rows) {
      const category = row.categoryId ? byId.get(row.categoryId) : undefined;
      const key = category?.parentId ?? row.categoryId ?? "none";
      const current = rolled.get(key) ?? { amount: 0, count: 0 };
      current.amount += Number(row.amount);
      current.count += row.count;
      rolled.set(key, current);
    }
    const total = [...rolled.values()].reduce((sum, row) => sum + Math.max(0, row.amount), 0);
    const query = (id: string) =>
      `from=${range.from}&to=${range.to}&type=${kind === "expense" ? "expense,refund" : "income,refund"}&categoryId=${id}${filters.projectId ? `&projectId=${filters.projectId}` : ""}`;
    return [...rolled.entries()]
      .filter(([, row]) => row.amount > 0)
      .map(([id, row]) => {
        const category = id === "none" ? null : byId.get(id);
        return {
          categoryId: category?.id ?? null,
          name: category?.name ?? "Uncategorized",
          icon: category?.icon ?? null,
          color: category?.color ?? null,
          amount: row.amount,
          count: row.count,
          share: total ? Math.round((row.amount / total) * 1000) / 10 : 0,
          href: `/transactions?${query(category?.id ?? "none")}`,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }

  /** Top counterparties by spending (or income) in a range. */
  async topMerchants(ctx: WorkspaceContext, range: Range, kind: "expense" | "income" = "expense", limit = 8) {
    const rows = await db.execute<{ counterparty_id: string | null; name: string; amount: string; count: number }>(sql`
      select t.counterparty_id, coalesce(c.name, t.merchant, 'Unknown') as name, sum(t.base_amount)::text as amount, count(*)::int as count
      from ${transactions} t left join counterparty c on c.id = t.counterparty_id
      where t.workspace_id = ${ctx.workspaceId} and t.status = 'posted' and t.type = ${kind}
        and t.date between ${range.from} and ${range.to}
      group by 1, 2 order by sum(t.base_amount) desc limit ${limit}
    `);
    return rows.rows.map((row) => ({
      counterpartyId: row.counterparty_id,
      name: row.name,
      amount: Number(row.amount),
      count: row.count,
      href: row.counterparty_id
        ? `/transactions?from=${range.from}&to=${range.to}&counterpartyId=${row.counterparty_id}`
        : `/transactions?from=${range.from}&to=${range.to}&q=${encodeURIComponent(row.name)}`,
    }));
  }

  private async liquidAccounts(ctx: WorkspaceContext, accountIds?: string[]) {
    const rows = await db
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.workspaceId, ctx.workspaceId),
          accountIds?.length ? inArray(financialAccounts.id, accountIds) : inArray(financialAccounts.kind, [...LIQUID_KINDS]),
        ),
      );
    return rows;
  }

  /** Base-currency balance of a set of accounts at the end of a day. */
  private async balanceOf(ctx: WorkspaceContext, accounts: Array<typeof financialAccounts.$inferSelect>, asOf: Day) {
    const sums = await this.accounts.balances(
      ctx.workspaceId,
      asOf,
      accounts.map((a) => a.id),
    );
    let total = 0;
    let unconverted = 0;
    for (const account of accounts) {
      const balance = (account.openingDate <= asOf ? account.openingBalance : 0) + (sums.get(account.id)?.total ?? 0);
      const base =
        account.currency === ctx.baseCurrency ? balance : await this.fx.tryConvert(balance, account.currency, ctx.baseCurrency, asOf, ctx.workspaceId);
      if (base === null) unconverted++;
      else total += base;
    }
    return { total, unconverted };
  }

  /**
   * Opening cash + income − expenses − debt payments ± transfers = closing
   * cash, for liquid accounts (or the given ones) over a range.
   */
  async cashFlow(ctx: WorkspaceContext, range: Range, accountIds?: string[]) {
    const accounts = await this.liquidAccounts(ctx, accountIds);
    const ids = accounts.map((a) => a.id);
    const opening = await this.balanceOf(ctx, accounts, addDays(range.from, -1));
    const rows = ids.length
      ? await db
          .select({ type: transactions.type, direction: transactions.direction, amount: sql<string>`coalesce(sum(${ledgerEntries.baseAmount}), 0)` })
          .from(ledgerEntries)
          .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
          .where(and(inArray(ledgerEntries.accountId, ids), gte(ledgerEntries.date, range.from), lte(ledgerEntries.date, range.to)))
          .groupBy(transactions.type, transactions.direction)
      : [];
    const statement = cashFlowStatement(
      opening.total,
      rows.map((row) => ({ type: row.type, direction: row.direction, amount: Number(row.amount) })),
    );
    const closing = await this.balanceOf(ctx, accounts, range.to);
    return {
      range,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
      statement,
      // Closing from balances; equals statement.closing unless rates moved.
      closingByBalances: closing.total,
      fxDifference: closing.total - statement.closing,
      unconvertedAccounts: opening.unconverted,
      label: "actual" as const,
    };
  }

  /** Month-by-month actual cash in, out and closing balance. */
  async cashFlowSeries(ctx: WorkspaceContext, months = 12) {
    const today = todayFor(ctx);
    const accounts = await this.liquidAccounts(ctx);
    const ids = accounts.map((a) => a.id);
    const from = startOfMonth(addMonths(today, -(months - 1)));
    const rows = ids.length
      ? await db
          .select({
            month: sql<string>`to_char(${ledgerEntries.date}::date, 'YYYY-MM')`,
            moneyIn: sql<string>`coalesce(sum(case when ${ledgerEntries.baseAmount} > 0 and ${transactions.type} <> 'transfer' then ${ledgerEntries.baseAmount} else 0 end), 0)`,
            moneyOut: sql<string>`coalesce(sum(case when ${ledgerEntries.baseAmount} < 0 and ${transactions.type} <> 'transfer' then -${ledgerEntries.baseAmount} else 0 end), 0)`,
            net: sql<string>`coalesce(sum(${ledgerEntries.baseAmount}), 0)`,
          })
          .from(ledgerEntries)
          .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
          .where(and(inArray(ledgerEntries.accountId, ids), gte(ledgerEntries.date, from), lte(ledgerEntries.date, endOfMonth(today))))
          .groupBy(sql`1`)
      : [];
    const byMonth = new Map(rows.map((row) => [row.month, row]));
    let balance = (await this.balanceOf(ctx, accounts, addDays(from, -1))).total;
    return eachMonth(from, today).map((month) => {
      const row = byMonth.get(month);
      balance += Number(row?.net ?? 0);
      return { month, moneyIn: Number(row?.moneyIn ?? 0), moneyOut: Number(row?.moneyOut ?? 0), net: Number(row?.net ?? 0), closing: balance };
    });
  }

  /**
   * 30/60/90-day projection. Scheduled items (commitments, receivables,
   * payables) are placed on their dates; unscheduled spending is the average
   * of the last 90 days. Returned as an estimate with its assumptions.
   */
  async forecast(ctx: WorkspaceContext, horizonDays = 90) {
    const today = todayFor(ctx);
    const end = addDays(today, horizonDays);
    const accounts = await this.liquidAccounts(ctx);
    const start = await this.balanceOf(ctx, accounts, today);
    const events: ForecastEvent[] = [];

    const active = await db
      .select()
      .from(commitments)
      .where(and(eq(commitments.workspaceId, ctx.workspaceId), eq(commitments.status, "active"), isNotNull(commitments.nextDueDate)));
    for (const commitment of active) {
      const schedule = {
        frequency: commitment.frequency,
        intervalCount: commitment.intervalCount,
        intervalUnit: commitment.intervalUnit,
        startDate: commitment.startDate,
        endDate: commitment.endDate,
      };
      const dates = dueDatesBetween(schedule, commitment.nextDueDate as Day, end);
      // A payment already late is still owed: place it today.
      const overdue = (commitment.nextDueDate as Day) < today ? [today] : [];
      for (const date of [...overdue, ...dates.filter((d) => d >= today)]) {
        const base =
          commitment.currency === ctx.baseCurrency
            ? commitment.amount
            : await this.fx.tryConvert(commitment.amount, commitment.currency, ctx.baseCurrency, today, ctx.workspaceId);
        if (base === null) continue;
        events.push({
          date,
          amount: commitment.direction === "in" ? base : -base,
          label: commitment.name,
          kind:
            commitment.kind === "subscription"
              ? "subscription"
              : commitment.direction === "in"
                ? "income"
                : commitment.kind === "payroll"
                  ? "payroll"
                  : "commitment",
          certainty: commitment.kind === "loan_payment" || commitment.kind === "rent" || commitment.autoPay ? "confirmed" : "expected",
          ref: commitment.id,
        });
      }
    }

    const open = await db
      .select({
        receivable: receivables,
        paid: sql<string>`coalesce((select sum(t.amount) from ${transactions} t where t.receivable_id = "receivable"."id" and t.status = 'posted' and t.direction = 'in'), 0)`,
      })
      .from(receivables)
      .where(
        and(eq(receivables.workspaceId, ctx.workspaceId), ne(receivables.status, "cancelled"), isNotNull(receivables.dueDate), lte(receivables.dueDate, end)),
      );
    for (const { receivable, paid } of open) {
      const state = receivableState({ amount: receivable.amount, paid: Number(paid), dueDate: receivable.dueDate, today });
      if (state.remaining <= 0) continue;
      const base =
        receivable.currency === ctx.baseCurrency
          ? state.remaining
          : await this.fx.tryConvert(state.remaining, receivable.currency, ctx.baseCurrency, today, ctx.workspaceId);
      if (base === null) continue;
      events.push({
        // Overdue money is not assumed to arrive today; a week out is fairer.
        date: receivable.dueDate && receivable.dueDate >= today ? receivable.dueDate : addDays(today, 7),
        amount: base,
        label: `${receivable.counterpartyName}: ${receivable.title}`,
        kind: "receivable",
        certainty: "expected",
        ref: receivable.id,
      });
    }

    const payables = await db
      .select()
      .from(liabilities)
      .where(
        and(
          eq(liabilities.workspaceId, ctx.workspaceId),
          eq(liabilities.status, "active"),
          inArray(liabilities.kind, ["payable", "personal_debt", "business_debt"]),
          isNotNull(liabilities.dueDate),
          lte(liabilities.dueDate, end),
        ),
      );
    const scheduledLiabilities = new Set(active.map((c) => c.liabilityId).filter(Boolean));
    for (const payable of payables) {
      if (scheduledLiabilities.has(payable.id)) continue;
      const flows = await db
        .select({
          amount: sql<string>`coalesce(sum(case when ${transactions.direction} = 'out' then ${transactions.amount} when ${transactions.type} = 'loan' then -${transactions.amount} else 0 end), 0)`,
        })
        .from(transactions)
        .where(and(eq(transactions.liabilityId, payable.id), eq(transactions.status, "posted")));
      const outstanding = payable.openingOutstanding - Number(flows[0]?.amount ?? 0);
      if (outstanding <= 0) continue;
      const base =
        payable.currency === ctx.baseCurrency ? outstanding : await this.fx.tryConvert(outstanding, payable.currency, ctx.baseCurrency, today, ctx.workspaceId);
      if (base === null) continue;
      events.push({
        date: (payable.dueDate as Day) < today ? today : (payable.dueDate as Day),
        amount: -base,
        label: payable.name,
        kind: "payable",
        certainty: "confirmed",
        ref: payable.id,
      });
    }

    // Unscheduled spending: the last 90 days of posted spending that did not
    // settle a commitment, as a daily rate and its day-to-day spread.
    const history = await db
      .select({ date: transactions.date, amount: sql<string>`sum(${transactions.baseAmount})` })
      .from(transactions)
      .where(
        and(
          this.posted(ctx, { from: addDays(today, -90), to: addDays(today, -1) }),
          eq(transactions.type, "expense"),
          sql`not (${transactions.metadata} ? 'commitmentId')`,
          isNull(transactions.liabilityId),
        ),
      )
      .groupBy(transactions.date);
    const daily = new Map(history.map((row) => [row.date, Number(row.amount)]));
    const values = Array.from({ length: 90 }, (_, index) => daily.get(addDays(today, -(index + 1))) ?? 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length);

    const result = forecastCash({
      startBalance: start.total,
      today,
      horizonDays,
      events,
      dailyDiscretionary: Math.round(mean),
      dailyDeviation: Math.round(deviation),
    });
    const threshold = ctx.settings.lowCashThreshold ?? 0;
    return {
      ...result,
      horizonDays,
      label: "estimate" as const,
      threshold,
      belowThreshold: result.lowest.balance < threshold,
      unconvertedAccounts: start.unconverted,
      windows: [30, 60, 90]
        .filter((days) => days <= horizonDays)
        .map((days) => {
          const point = result.days[days - 1];
          const slice = result.days.slice(0, days);
          const lowest = slice.reduce((min, day) => (day.balance < min.balance ? day : min), slice[0] ?? { date: today, balance: start.total });
          return {
            days,
            endBalance: point?.balance ?? start.total,
            low: point?.low ?? start.total,
            high: point?.high ?? start.total,
            lowest: { date: lowest.date, balance: lowest.balance },
          };
        }),
    };
  }

  /** Counts behind the dashboard's attention pills. */
  async attention(ctx: WorkspaceContext) {
    const today = todayFor(ctx);
    const [drafts] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), inArray(transactions.status, ["draft", "pending"])));
    const [uncategorized] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(this.posted(ctx, { from: addDays(today, -90), to: today }), inArray(transactions.type, ["expense", "income"]), isNull(transactions.categoryId)),
      );
    const inbox = await db.execute<{ kind: string; value: number }>(sql`
      select kind, count(*)::int as value from inbox_item where workspace_id = ${ctx.workspaceId} and status = 'open' group by kind
    `);
    const byKind = Object.fromEntries(inbox.rows.map((row) => [row.kind, row.value]));
    const [overdueCommitments] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(commitments)
      .where(and(eq(commitments.workspaceId, ctx.workspaceId), eq(commitments.status, "active"), lte(commitments.nextDueDate, addDays(today, -1))));
    const overdueReceivables = await db.execute<{ value: number }>(sql`
      select count(*)::int as value from ${receivables} r
      where r.workspace_id = ${ctx.workspaceId} and r.status <> 'cancelled' and r.due_date < ${today}
        and r.amount > coalesce((select sum(t.amount) from ${transactions} t where t.receivable_id = r.id and t.status = 'posted' and t.direction = 'in'), 0)
    `);
    return {
      drafts: drafts?.value ?? 0,
      uncategorized: uncategorized?.value ?? 0,
      duplicates: byKind.duplicate ?? 0,
      overdueCommitments: overdueCommitments?.value ?? 0,
      overdueReceivables: overdueReceivables.rows[0]?.value ?? 0,
      inboxByKind: byKind as Record<string, number>,
    };
  }

  /** Days until a date in the workspace calendar. */
  daysUntil(ctx: WorkspaceContext, date: Day) {
    return diffDays(todayFor(ctx), date);
  }

  monthRange(ctx: WorkspaceContext, day?: Day): Range {
    const reference = day ?? todayFor(ctx);
    return { from: startOfMonth(reference), to: endOfMonth(reference) };
  }

  monthKey(day: Day) {
    return monthKey(day);
  }
}
