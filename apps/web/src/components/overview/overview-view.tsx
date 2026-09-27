"use client";

import { formatMoney, relativeDays } from "@expensewise/core";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Camera,
  CircleAlert,
  Flame,
  HandCoins,
  Inbox,
  Landmark,
  Lightbulb,
  Plug,
  Repeat,
  Scale,
  Sparkles,
  Tags,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useApp } from "@/components/app/app-context";
import { CategoryTile, Delta, EmptyNote, Pill, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { openAddTransaction } from "@/components/app/global-actions";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import type { Account, CurrentWorkspace, Me, TransactionPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDay, timeAgo } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import type { OverviewData } from "./types";

function greeting(hour: number) {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function OverviewView({
  me,
  workspace,
  overview,
  accounts,
  recent,
  monthTotals,
  today,
}: {
  me: Me;
  workspace: CurrentWorkspace;
  overview: OverviewData | null;
  accounts: Account[];
  recent: TransactionPage;
  monthTotals: TransactionPage["totals"];
  today: string;
}) {
  const { money, locale, isBusiness, canWrite } = useApp();
  const compact = (v: number) => formatMoney(v, workspace.baseCurrency, { locale, compact: true });
  const cash = overview?.cash.total ?? accounts.reduce((sum, a) => sum + Math.max(0, a.baseBalance ?? 0), 0);
  const income = overview?.month.income ?? monthTotals.income;
  const expenses = overview?.month.expenses ?? monthTotals.expense;
  const net = income - expenses;
  const monthHref = (type: string) => `/transactions?period=this_month&type=${type}`;
  const firstName = me.user.name.split(" ")[0];
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: workspace.timezone }).format(new Date()));
  const attention = overview?.attention;

  const isEmpty = accounts.every((a) => a.entryCount === 0) && recent.total === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {greeting(hour)}, {firstName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatDay(today, "long")} · {workspace.name}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" render={<Link href="/capture?mode=screenshot" />}>
            <Camera className="size-3.5" /> Scan
          </Button>
          <Button size="sm" onClick={() => openAddTransaction("expense")}>
            <ArrowUpRight className="size-3.5" /> Add expense
          </Button>
        </div>
      </div>

      {isEmpty && (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-card/50 p-5 sm:flex-row sm:items-center">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Start with one transaction</p>
            <p className="text-sm text-muted-foreground">
              Scan a bKash or bank screenshot, type “আজকে ৫০০ টাকার বাজার”, import a CSV statement, or connect{" "}
              {isBusiness ? "Stripe or your own app" : "a bank feed"}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" render={<Link href="/accounts" />} variant="outline">
              <Wallet className="size-3.5" /> Add accounts
            </Button>
            <Button size="sm" render={<Link href="/integrations" />}>
              <Plug className="size-3.5" /> Connect an app
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Scale}
          label="Net worth"
          value={overview?.netWorth ? compact(overview.netWorth.value) : "—"}
          hint={
            overview?.netWorth ? (
              <span className="inline-flex items-center gap-1.5">
                <Delta value={overview.netWorth.changePct} /> vs last month
                {!overview.netWorth.complete && <CircleAlert className="size-3 text-amber-500" aria-label="Incomplete" />}
              </span>
            ) : (
              "Add assets and debts to see it"
            )
          }
          href="/wealth/net-worth"
        />
        <StatCard icon={Wallet} label="Cash position" value={compact(cash)} hint={`${accounts.length} accounts`} href="/accounts" tone="good" />
        <StatCard
          icon={ArrowDownLeft}
          label={isBusiness ? "Revenue this month" : "Income this month"}
          value={compact(income)}
          hint={<Delta value={overview?.month.incomeChangePct} />}
          href={monthHref("income")}
        />
        <StatCard
          icon={ArrowUpRight}
          label="Spent this month"
          value={compact(expenses)}
          hint={<Delta value={overview?.month.expenseChangePct} goodWhen="down" />}
          href={monthHref("expense")}
        />
        <StatCard
          icon={TrendingUp}
          label="Net cash flow"
          value={formatMoney(net, workspace.baseCurrency, { locale, compact: true, signed: true })}
          hint={
            overview?.month.savingsRate !== null && overview?.month.savingsRate !== undefined
              ? `${overview.month.savingsRate}% ${isBusiness ? "margin" : "saved"}`
              : "This month"
          }
          tone={net < 0 ? "danger" : "default"}
          href="/reports?tab=cash-flow"
        />
        {isBusiness ? (
          <StatCard
            icon={Flame}
            label="Monthly burn"
            value={overview?.business ? compact(overview.business.burn) : "—"}
            hint="Average of 3 months"
            href="/business/projects"
            tone="warn"
          />
        ) : (
          <StatCard
            icon={HandCoins}
            label="Owed to you"
            value={overview ? compact(overview.receivables.outstanding) : "—"}
            hint={overview?.receivables.overdue ? `${compact(overview.receivables.overdue)} overdue` : "Receivables"}
            href="/wealth/receivables"
            tone={overview?.receivables.overdue ? "warn" : "default"}
          />
        )}
      </div>

      {attention && (
        <div className="flex flex-wrap gap-2">
          {attention.drafts > 0 && (
            <Pill icon={Inbox} href="/ai/inbox" tone="warn">
              {attention.drafts} {attention.drafts === 1 ? "transaction needs" : "transactions need"} review
            </Pill>
          )}
          {attention.duplicates > 0 && (
            <Pill icon={AlertTriangle} href="/ai/inbox?kind=duplicate" tone="danger">
              {attention.duplicates} possible {attention.duplicates === 1 ? "duplicate" : "duplicates"}
            </Pill>
          )}
          {attention.uncategorized > 0 && (
            <Pill icon={Tags} href="/transactions?categoryId=none&period=last_90_days" tone="info">
              {attention.uncategorized} uncategorized
            </Pill>
          )}
          {attention.overdueCommitments > 0 && (
            <Pill icon={Repeat} href="/commitments" tone="danger">
              {attention.overdueCommitments} payment{attention.overdueCommitments === 1 ? "" : "s"} not recorded
            </Pill>
          )}
          {attention.overdueReceivables > 0 && (
            <Pill icon={HandCoins} href="/wealth/receivables?status=overdue" tone="warn">
              {attention.overdueReceivables} overdue receivable{attention.overdueReceivables === 1 ? "" : "s"}
            </Pill>
          )}
          {overview?.integrations.failing ? (
            <Pill icon={Plug} href="/integrations" tone="danger">
              {overview.integrations.failing} integration{overview.integrations.failing === 1 ? "" : "s"} failing
            </Pill>
          ) : null}
          {overview?.forecast?.belowThreshold && (
            <Pill icon={AlertTriangle} href="/ai/forecasts" tone="danger">
              Cash may dip to {compact(overview.forecast.lowest.balance)} on {formatDay(overview.forecast.lowest.date, "short")}
            </Pill>
          )}
        </div>
      )}

      <div className="columns-1 gap-4 lg:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
        <Section title={isBusiness ? "Revenue and costs" : "Income and spending"} hint="Last 12 months" href="/reports">
          {overview?.series.length ? (
            <BarsChart
              data={overview.series.map((m) => ({ label: m.month, income: m.income, expenses: m.expenses }))}
              series={[
                { key: "income", label: isBusiness ? "Revenue" : "Income", color: SERIES.primary },
                { key: "expenses", label: isBusiness ? "Costs" : "Spending", color: SERIES.secondary },
              ]}
              format={(v) => money(v)}
              axisFormat={compact}
              tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
              labelFormat={(label) => formatMonth(label)}
              height={200}
            />
          ) : (
            <EmptyNote>Monthly totals appear once transactions are recorded.</EmptyNote>
          )}
        </Section>

        <Section title="Where the money went" hint="This month, by category" href={monthHref("expense")}>
          {overview?.topCategories.length ? (
            <ul className="space-y-1">
              {overview.topCategories.map((category) => (
                <li key={category.categoryId ?? "none"}>
                  <Link href={category.href} className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/60">
                    <CategoryTile icon={category.icon} color={category.color} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{category.name}</span>
                        <span className="shrink-0 text-sm tabular-nums">{money(category.amount)}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-2">
                        <ProgressBar value={category.share} className="h-1" />
                        <span className="w-20 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                          {category.count} · {category.share}%
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote
              action={
                <Button size="xs" variant="outline" onClick={() => openAddTransaction("expense")}>
                  Add an expense
                </Button>
              }
            >
              No spending recorded this month.
            </EmptyNote>
          )}
        </Section>

        <Section title="Upcoming commitments" hint="Next 14 days" href="/commitments">
          {overview?.upcoming.length ? (
            <ul className="divide-y divide-border">
              {overview.upcoming.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className="flex items-center gap-3 py-2 hover:opacity-80">
                    <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDay(item.date, "short")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.overdue ? "Not recorded yet" : relativeDays(item.date, today)} · {item.autoPay ? "Auto-pay" : "Manual"}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-sm tabular-nums",
                        item.direction === "in" && "text-money-in",
                        item.overdue && "text-red-600 dark:text-red-400",
                      )}
                    >
                      {money(item.amount, item.currency)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote
              action={
                <Button size="xs" variant="outline" render={<Link href="/subscriptions?new=1" />}>
                  Track a subscription
                </Button>
              }
            >
              Rent, subscriptions, loan installments and salary will show up here before they are due.
            </EmptyNote>
          )}
        </Section>

        {isBusiness && (
          <Section title="Project performance" hint="This month · revenue vs cost" href="/business/projects">
            {overview?.business?.projects.length ? (
              <ul className="divide-y divide-border">
                {overview.business.projects.map((project) => (
                  <li key={project.id}>
                    <Link href={project.href} className="flex items-center gap-3 py-2 hover:opacity-80">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: project.color ?? "var(--color-muted-foreground)" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{project.name}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {money(project.revenue)} in · {money(project.cost)} out
                          {project.budgetUsed !== null ? ` · ${project.budgetUsed}% of budget` : ""}
                        </span>
                      </span>
                      <span className={cn("shrink-0 text-sm font-medium tabular-nums", project.net >= 0 ? "text-money-in" : "text-red-600 dark:text-red-400")}>
                        {money(project.net, undefined, { signed: true })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote>Assign transactions to projects to see what each one earns and costs.</EmptyNote>
            )}
          </Section>
        )}

        <Section title="Accounts" hint="Current balances" href="/accounts">
          {accounts.length ? (
            <ul className="divide-y divide-border">
              {accounts.slice(0, 8).map((account) => (
                <li key={account.id}>
                  <Link href={`/accounts/${account.id}`} className="flex items-center justify-between gap-3 py-2 hover:opacity-80">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{account.name}</span>
                      <span className="block text-xs text-muted-foreground">{account.currency}</span>
                    </span>
                    <span className={cn("shrink-0 text-sm tabular-nums", account.balance < 0 && "text-red-600 dark:text-red-400")}>
                      {money(account.balance, account.currency)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote
              action={
                <Button size="xs" variant="outline" render={<Link href="/accounts" />}>
                  Add an account
                </Button>
              }
            >
              No accounts yet.
            </EmptyNote>
          )}
        </Section>

        <Section title="Receivables and payables" href="/wealth/receivables">
          <div className="grid grid-cols-2 gap-3">
            <Link href="/wealth/receivables" className="rounded-lg border border-border p-3 hover:bg-accent/40">
              <p className="text-xs text-muted-foreground">Owed to you</p>
              <p className="text-lg font-semibold tabular-nums">{overview ? money(overview.receivables.outstanding) : "—"}</p>
              <p className="text-xs text-muted-foreground">
                {overview?.receivables.overdue ? `${money(overview.receivables.overdue)} overdue` : `${overview?.receivables.count ?? 0} open`}
              </p>
            </Link>
            <Link href="/wealth/liabilities?view=payables" className="rounded-lg border border-border p-3 hover:bg-accent/40">
              <p className="text-xs text-muted-foreground">You owe</p>
              <p className="text-lg font-semibold tabular-nums">{overview ? money(overview.payables.outstanding) : "—"}</p>
              <p className="text-xs text-muted-foreground">{overview?.payables.count ?? 0} open</p>
            </Link>
          </div>
        </Section>

        <Section title="Goals" href="/goals">
          {overview?.goals.length ? (
            <ul className="space-y-3">
              {overview.goals.map((goal) => (
                <li key={goal.id}>
                  <Link href={goal.href} className="block space-y-1.5 hover:opacity-80">
                    <span className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="flex items-center gap-1.5 truncate font-medium">
                        <Target className="size-3.5 text-muted-foreground" />
                        {goal.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {money(goal.current, goal.currency, { compact: true })} / {money(goal.target, goal.currency, { compact: true })}
                      </span>
                    </span>
                    <ProgressBar value={goal.progress} tone={goal.progress >= 100 ? "good" : "default"} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote
              action={
                <Button size="xs" variant="outline" render={<Link href="/goals?new=1" />}>
                  Set a goal
                </Button>
              }
            >
              {isBusiness ? "A cash reserve, new equipment, a hire — progress shows here." : "An emergency fund, a car, a trip — progress shows here."}
            </EmptyNote>
          )}
        </Section>

        <Section title="AI insights" hint="From your own numbers" href="/ai/insights">
          {overview?.insights.length ? (
            <ul className="space-y-2">
              {overview.insights.map((insight) => (
                <li key={insight.id} className="flex gap-2.5 rounded-lg bg-muted/40 px-3 py-2">
                  <Lightbulb
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      insight.severity === "warning" || insight.severity === "critical" ? "text-amber-500" : "text-muted-foreground",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{insight.title}</p>
                    {insight.body && <p className="text-xs text-muted-foreground">{insight.body}</p>}
                    {insight.href && (
                      <Link href={insight.href} className="text-xs text-foreground underline-offset-4 hover:underline">
                        View transactions
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote>Unusual spending, recurring charges and price changes will be flagged here, with the transactions behind them.</EmptyNote>
          )}
        </Section>

        <Section title="Recent activity" href="/transactions">
          {recent.items.length ? (
            <ul className="divide-y divide-border">
              {recent.items.map((tx) => {
                const incoming = tx.type !== "transfer" && tx.direction === "in";
                return (
                  <li key={tx.id} className="flex items-center gap-3 py-2">
                    <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDay(tx.date, "short")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {tx.type === "transfer" ? `${tx.accountName} → ${tx.toAccountName}` : (tx.counterpartyName ?? tx.merchant ?? tx.description ?? tx.type)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{tx.categoryName ?? tx.accountName}</span>
                    </span>
                    {tx.status !== "posted" && <StatusBadge status={tx.status} label={tx.status === "draft" ? "Review" : undefined} />}
                    <span className={cn("shrink-0 text-sm tabular-nums", incoming && "text-money-in")}>
                      {tx.type === "transfer" ? money(tx.amount, tx.currency) : money(incoming ? tx.amount : -tx.amount, tx.currency, { signed: incoming })}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyNote
              action={
                canWrite ? (
                  <Button size="sm" variant="outline" onClick={() => openAddTransaction("expense")}>
                    Add a transaction
                  </Button>
                ) : undefined
              }
            >
              No transactions yet: add one, capture a receipt or import a statement.
            </EmptyNote>
          )}
        </Section>

        <Section title="Integration health" href="/integrations">
          {overview?.integrations.total ? (
            <ul className="divide-y divide-border">
              {overview.integrations.items.map((item) => (
                <li key={item.id}>
                  <Link href={`/integrations/${item.id}`} className="flex items-center justify-between gap-3 py-2 hover:opacity-80">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {item.lastSyncedAt ? `Synced ${timeAgo(item.lastSyncedAt)}` : "Not synced yet"}
                      </span>
                    </span>
                    <StatusBadge status={item.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote
              action={
                <Button size="xs" variant="outline" render={<Link href="/integrations" />}>
                  <Landmark className="size-3.5" /> Connect an app
                </Button>
              }
            >
              You haven&apos;t connected any financial sources yet.
            </EmptyNote>
          )}
        </Section>
      </div>
    </div>
  );
}
