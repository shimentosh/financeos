"use client";

import { formatMoney } from "@expensewise/core";
import { AlertTriangle, CalendarClock, Info, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, Section, StatCard } from "@/components/app/blocks";
import { ForecastChart } from "@/components/charts/charts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import type { Forecast } from "./types";

export function ForecastView({ forecast }: { forecast: Forecast }) {
  const { money, workspace, locale } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const compact = (v: number) => formatMoney(v, workspace.baseCurrency, { locale, compact: true });

  const eventHref = (event: Forecast["events"][number]) =>
    event.kind === "receivable"
      ? "/wealth/receivables"
      : event.kind === "payable"
        ? "/wealth/liabilities?view=payables"
        : event.ref
          ? `/commitments?focus=${event.ref}`
          : "/commitments";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
          {[30, 60, 90].map((days) => (
            <button
              key={days}
              type="button"
              role="tab"
              aria-selected={forecast.horizonDays === days}
              onClick={() => router.push(`${pathname}?days=${days}`, { scroll: false })}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                forecast.horizonDays === days ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {days} days
            </button>
          ))}
        </div>
        <Badge variant="warning">Estimate</Badge>
      </div>

      {forecast.belowThreshold && (
        <p className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="size-4" />
          Cash is projected to fall to {money(forecast.lowest.balance)} on {formatDay(forecast.lowest.date)}
          {forecast.threshold ? `, below your ${money(forecast.threshold)} floor` : ""}.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Wallet} label="Cash today" value={compact(forecast.startBalance)} hint="Bank, wallets and cash" href="/accounts" />
        <StatCard
          icon={forecast.endBalance >= forecast.startBalance ? TrendingUp : TrendingDown}
          label={`In ${forecast.horizonDays} days (estimate)`}
          value={compact(forecast.endBalance)}
          hint={`${money(forecast.endBalance - forecast.startBalance, undefined, { signed: true, compact: true })} change`}
        />
        <StatCard
          icon={AlertTriangle}
          label="Lowest point"
          value={compact(forecast.lowest.balance)}
          hint={formatDay(forecast.lowest.date)}
          tone={forecast.belowThreshold ? "danger" : "default"}
        />
        <StatCard
          icon={CalendarClock}
          label="Scheduled out"
          value={compact(forecast.scheduledOut)}
          hint={`${compact(forecast.scheduledIn)} scheduled in`}
          href="/commitments"
        />
      </div>

      <Section title="Projected cash" hint="The line is the expected balance; the band is an 80% range for unscheduled spending.">
        <ForecastChart
          data={forecast.days.map((d) => ({ label: d.date, balance: d.balance, low: d.low, high: d.high }))}
          format={(v) => money(v)}
          axisFormat={compact}
          tickFormat={(label) => formatDay(label, "short")}
          labelFormat={(label) => formatDay(label, "long")}
          threshold={forecast.threshold ? { value: forecast.threshold, label: "Your cash floor" } : null}
        />
      </Section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section title="What is scheduled" hint="Commitments, receivables and payables in the window">
          {forecast.events.length ? (
            <ul className="divide-y divide-border">
              {forecast.events.map((event) => (
                <li key={`${event.date}-${event.kind}-${event.ref ?? event.label}-${event.amount}`}>
                  <Link href={eventHref(event)} className="flex items-center gap-3 py-2 hover:opacity-80">
                    <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDay(event.date, "short")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{event.label}</span>
                      <span className="text-xs text-muted-foreground capitalize">
                        {event.kind} · {event.certainty}
                      </span>
                    </span>
                    <span className={cn("shrink-0 text-sm tabular-nums", event.amount > 0 && "text-money-in")}>
                      {money(event.amount, undefined, { signed: true })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote>Nothing scheduled. Add rent, subscriptions, salary or invoices to make the forecast sharper.</EmptyNote>
          )}
        </Section>
        <div className="space-y-4">
          <Section title="Windows">
            <ul className="divide-y divide-border text-sm">
              {forecast.windows.map((w) => (
                <li key={w.days} className="flex items-center justify-between py-2">
                  <span>{w.days} days</span>
                  <span className="text-right tabular-nums">
                    {money(w.endBalance)}
                    <span className="block text-[11px] text-muted-foreground">
                      range {compact(w.low)} – {compact(w.high)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="How this is estimated">
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {forecast.assumptions.map((line) => (
                <li key={line} className="flex gap-2">
                  <Info className="mt-0.5 size-3 shrink-0" />
                  {line}
                </li>
              ))}
              <li className="flex gap-2">
                <Info className="mt-0.5 size-3 shrink-0" />
                Typical unscheduled spending: {money(Math.round(forecast.discretionaryOut / Math.max(1, forecast.horizonDays)))} a day.
              </li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
