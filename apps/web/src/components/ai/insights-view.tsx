"use client";

import { formatDay, percentChange } from "@financeos/core";
import { ArrowDownLeft, ArrowUpRight, Bot, CalendarClock, PiggyBank, Repeat, Scale, Sparkles, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useApp } from "@/components/app/app-context";
import { CategoryTile, Delta, EmptyNote, ProgressBar, Section, StatCard } from "@/components/app/blocks";
import { SERIES, TrendChart } from "@/components/charts/charts";
import type { CategoryShare, MonthPoint, Statement } from "@/components/reports/types";
import { Button } from "@/components/ui/button";
import type { AiStatusView, AiUsageReportView, InboxItemView } from "@/lib/api/types/ai";
import type { SubscriptionAnalytics } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { transactionsHref, usd } from "./shared";

type Period = { range: { from: string; to: string }; statement: Statement; categories: CategoryShare[] };

function periodHref(range: { from: string; to: string }, type: string) {
  return `/transactions?from=${range.from}&to=${range.to}&type=${type}`;
}

/** The "Understand" page: what changed this month and why, with every number linked to its records. */
export function InsightsView({
  current,
  previous,
  monthly,
  anomalies,
  recurring,
  subscriptions,
  usage,
  aiStatus,
  today,
}: {
  current: Period;
  previous: Period;
  monthly: MonthPoint[];
  anomalies: InboxItemView[];
  recurring: InboxItemView[];
  subscriptions: SubscriptionAnalytics | null;
  usage: AiUsageReportView | null;
  aiStatus: AiStatusView | null;
  today: string;
}) {
  const { money, isBusiness, canManage } = useApp();
  const now = current.statement;
  const before = previous.statement;
  const span = `${formatDay(current.range.from, "short")} – ${formatDay(current.range.to, "short")}`;
  const priorSpan = `${formatDay(previous.range.from, "short")} – ${formatDay(previous.range.to, "short")}`;

  const changes = mergeCategories(current.categories, previous.categories).slice(0, 6);
  const trend = monthly.map((point) => ({
    label: point.month,
    income: point.income,
    expenses: point.expenses,
  }));
  const question = encodeURIComponent(
    isBusiness ? "Why did my costs change this month compared with last month?" : "What changed in my spending this month compared with last month?",
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Insights</h1>
          <p className="text-sm text-muted-foreground">
            This month so far ({span}) against the same days last month ({priorSpan}). Figures come from posted transactions only.
          </p>
        </div>
        <Button size="sm" variant="outline" render={<Link href={`/ai/copilot?q=${question}`} />}>
          <Bot className="size-3.5" /> Ask the copilot
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={ArrowUpRight}
          label={isBusiness ? "Costs so far" : "Spending so far"}
          value={money(now.expenses, undefined, { trimZeroFraction: true })}
          hint={
            <span className="inline-flex items-center gap-1.5">
              <Delta value={percentChange(before.expenses, now.expenses)} goodWhen="down" /> vs {money(before.expenses, undefined, { compact: true })}
            </span>
          }
          href={periodHref(current.range, "expense,refund")}
          tone="warn"
        />
        <StatCard
          icon={ArrowDownLeft}
          label={isBusiness ? "Revenue so far" : "Income so far"}
          value={money(now.income, undefined, { trimZeroFraction: true })}
          hint={
            <span className="inline-flex items-center gap-1.5">
              <Delta value={percentChange(before.income, now.income)} goodWhen="up" /> vs {money(before.income, undefined, { compact: true })}
            </span>
          }
          href={periodHref(current.range, "income")}
          tone="good"
        />
        <StatCard
          icon={Scale}
          label="Net"
          value={money(now.net, undefined, { trimZeroFraction: true, signed: true })}
          valueClassName={now.net < 0 ? "text-red-600 dark:text-red-400" : undefined}
          hint={`same days last month: ${money(before.net, undefined, { compact: true, signed: true })}`}
          href={`/transactions?from=${current.range.from}&to=${current.range.to}`}
        />
        <StatCard
          icon={PiggyBank}
          label={isBusiness ? "Net margin" : "Savings rate"}
          value={now.rate === null ? "—" : `${now.rate}%`}
          hint={before.rate === null ? "no income last month" : `${before.rate}% same days last month`}
          href="/reports"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Section
          title="Six months"
          hint="Income and spending per month; the current month is so far."
          className="lg:col-span-3"
          href="/reports?tab=summary&period=last_12_months"
          linkLabel="Reports"
        >
          <TrendChart
            data={trend}
            series={[
              { key: "income", label: isBusiness ? "Revenue" : "Income", color: SERIES.primary },
              { key: "expenses", label: isBusiness ? "Costs" : "Spending", color: SERIES.secondary },
            ]}
            format={(value) => money(value, undefined, { trimZeroFraction: true })}
            axisFormat={(value) => money(value, undefined, { compact: true })}
            labelFormat={(label) => `${formatMonth(label)}${label === today.slice(0, 7) ? " (so far)" : ""}`}
            tickFormat={(label) => formatMonth(label, "en-GB", true)}
            height={220}
          />
        </Section>

        <Section title="What moved" hint="Spending categories with the biggest change against the same days last month." className="lg:col-span-2">
          {changes.length ? (
            <ul className="divide-y divide-border">
              {changes.map((row) => (
                <li key={row.key} className="flex items-center gap-3 py-2">
                  <CategoryTile icon={row.icon} color={row.color} size="sm" />
                  <div className="min-w-0 flex-1">
                    <Link href={row.currentHref ?? row.previousHref ?? "#"} className="block truncate text-sm hover:underline">
                      {row.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.previousHref ? (
                        <Link href={row.previousHref} className="hover:underline">
                          was {money(row.previous, undefined, { trimZeroFraction: true })}
                        </Link>
                      ) : (
                        "new this month"
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    {row.currentHref ? (
                      <Link href={row.currentHref} className="block text-sm tabular-nums hover:underline">
                        {money(row.current, undefined, { trimZeroFraction: true })}
                      </Link>
                    ) : (
                      <span className="block text-sm tabular-nums text-muted-foreground">{money(0)}</span>
                    )}
                    <span className={cn("text-xs tabular-nums", row.change > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
                      {money(row.change, undefined, { signed: true, trimZeroFraction: true })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote>No spending in either period yet. Capture a payment and it shows up here.</EmptyNote>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Unusual activity"
          hint="From the daily check: category spikes, large payments and revenue drops."
          href="/ai/inbox?show=anomalies"
          linkLabel="In the inbox"
        >
          {anomalies.length ? (
            <ul className="divide-y divide-border">
              {anomalies.map((item) => {
                const data = item.data as { expected?: number; actual?: number; currency?: string; href?: string; transactionIds?: string[] };
                const href = data.href ?? (data.transactionIds?.length ? transactionsHref(data.transactionIds) : null);
                return (
                  <li key={item.id} className="space-y-1 py-2.5">
                    <p className="flex items-start gap-2 text-sm font-medium">
                      <TrendingUp className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      {item.title}
                    </p>
                    {typeof data.expected === "number" && typeof data.actual === "number" && (
                      <p className="ps-6 text-xs text-muted-foreground tabular-nums">
                        Usually {money(data.expected, data.currency)} · this time {money(data.actual, data.currency)}
                      </p>
                    )}
                    {href && (
                      <Link href={href} className="ps-6 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                        View the transactions
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyNote>Nothing unusual right now. Each night spending is compared with its own recent pattern.</EmptyNote>
          )}
        </Section>

        <Section
          title="Recurring charges not tracked yet"
          hint="Payments that repeat on a schedule. Track them to be reminded before they renew."
          href="/ai/inbox?show=recurring"
          linkLabel="Review"
        >
          {recurring.length ? (
            <ul className="divide-y divide-border">
              {recurring.map((item) => {
                const data = item.data as { amount?: number; currency?: string; cadence?: string; nextExpected?: string | null; href?: string };
                return (
                  <li key={item.id} className="flex items-center gap-3 py-2">
                    <Repeat className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{item.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {data.nextExpected ? `Next around ${formatDay(data.nextExpected)} (estimate)` : item.body}
                      </p>
                    </div>
                    {typeof data.amount === "number" && data.currency && (
                      <Link href={data.href ?? "/ai/inbox?show=recurring"} className="shrink-0 text-sm tabular-nums hover:underline">
                        {money(data.amount, data.currency)}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyNote>No untracked recurring charges found. Subscriptions you already track are on the Subscriptions page.</EmptyNote>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {subscriptions && (
          <Section title="Subscriptions" hint="Active subscriptions in your base currency." href="/subscriptions" linkLabel="All subscriptions">
            <div className="grid grid-cols-3 gap-3">
              <Figure
                label="A month (equivalent)"
                value={money(subscriptions.monthlyTotal, subscriptions.baseCurrency, { trimZeroFraction: true })}
                href="/subscriptions"
              />
              <Figure label="A year" value={money(subscriptions.annualTotal, subscriptions.baseCurrency, { trimZeroFraction: true })} href="/subscriptions" />
              <Figure label="Active" value={String(subscriptions.activeCount)} href="/subscriptions" />
            </div>
            {subscriptions.upcoming30.items.length > 0 ? (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <CalendarClock className="size-3.5" /> Renewing in the next 30 days ·{" "}
                  {money(subscriptions.upcoming30.total, subscriptions.baseCurrency, { trimZeroFraction: true })}
                </p>
                <ul className="divide-y divide-border">
                  {subscriptions.upcoming30.items.slice(0, 4).map((item) => (
                    <li key={`${item.subscriptionId}-${item.date}`}>
                      <Link href={`/subscriptions/${item.subscriptionId}`} className="flex items-center justify-between gap-3 py-1.5 text-sm hover:underline">
                        <span className="truncate">{item.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {formatDay(item.date, "short")} · {money(item.amount, item.currency)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <EmptyNote>Nothing renews in the next 30 days.</EmptyNote>
            )}
          </Section>
        )}

        {canManage && usage && (
          <Section
            title="AI this month"
            hint="What reading captures and suggestions cost. Rules and merchant memory are free."
            href="/settings/ai"
            linkLabel="AI settings"
          >
            <AiUsageSummary usage={usage} status={aiStatus} />
          </Section>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link href={href} className="rounded-lg border border-border px-3 py-2 hover:bg-accent/40">
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-base font-semibold tabular-nums">{value}</p>
    </Link>
  );
}

/** Spend against the budget and the features behind it. */
export function AiUsageSummary({ usage, status }: { usage: AiUsageReportView; status: AiStatusView | null }) {
  const budget = usage.budget;
  const pct = budget.percentUsed ?? 0;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-semibold tabular-nums">{usd(usage.totals.costUsd, 2)}</span>
          <span className="text-xs text-muted-foreground">{budget.limitUsd === null ? "no monthly limit" : `of ${usd(budget.limitUsd, 2)} budget`}</span>
        </div>
        {budget.limitUsd !== null && <ProgressBar value={pct} tone={pct >= 90 ? "danger" : pct >= 70 ? "warn" : "default"} />}
        <p className="text-xs text-muted-foreground">
          {usage.totals.providerCalls} model call{usage.totals.providerCalls === 1 ? "" : "s"}
          {usage.totals.blocked > 0 && ` · ${usage.totals.blocked} skipped (AI off or budget)`}
          {status?.model && ` · ${status.model}`}
        </p>
      </div>
      {usage.byFeature.length > 0 && (
        <ul className="space-y-1 text-sm">
          {usage.byFeature.slice(0, 4).map((row) => (
            <li key={row.feature} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 truncate">
                <Sparkles className="size-3.5 text-violet-500" />
                {FEATURE_LABELS[row.feature] ?? row.feature}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {row.calls} · {usd(row.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const FEATURE_LABELS: Record<string, string> = {
  "capture.extract": "Reading captures",
  classify: "Category suggestions",
  "report.narrative": "Report summaries",
  summarize: "Summaries",
  generate: "Writing",
  copilot: "Copilot",
};

type CategoryChange = {
  key: string;
  name: string;
  icon: string | null;
  color: string | null;
  current: number;
  previous: number;
  change: number;
  currentHref: string | null;
  previousHref: string | null;
};

function mergeCategories(current: CategoryShare[], previous: CategoryShare[]): CategoryChange[] {
  const rows = new Map<string, CategoryChange>();
  for (const c of current) {
    rows.set(c.categoryId ?? "none", {
      key: c.categoryId ?? "none",
      name: c.name,
      icon: c.icon,
      color: c.color,
      current: c.amount,
      previous: 0,
      change: c.amount,
      currentHref: c.href,
      previousHref: null,
    });
  }
  for (const p of previous) {
    const key = p.categoryId ?? "none";
    const row = rows.get(key);
    if (row) {
      row.previous = p.amount;
      row.change = row.current - p.amount;
      row.previousHref = p.href;
    } else {
      rows.set(key, {
        key,
        name: p.name,
        icon: p.icon,
        color: p.color,
        current: 0,
        previous: p.amount,
        change: -p.amount,
        currentHref: null,
        previousHref: p.href,
      });
    }
  }
  return [...rows.values()].filter((row) => row.change !== 0).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}
