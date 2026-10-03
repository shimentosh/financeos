"use client";

import { formatDay, formatMoney } from "@financeos/core";
import { ArrowDownLeft, CalendarRange, Receipt, Repeat, Undo2 } from "lucide-react";
import Link from "next/link";
import { useApp } from "@/components/app/app-context";
import { Delta, EmptyNote, EmptyState, ProgressBar, Section, StatCard } from "@/components/app/blocks";
import { openAddTransaction } from "@/components/app/global-actions";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Drill, RevenueAnalytics } from "@/lib/api/types/business";
import { percentText } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import { drillHref } from "./drill";
import { RangeSelect } from "./range-select";

type ShareRow = {
  key: string;
  name: string;
  hint?: string;
  amount: number;
  share: number | null;
  drill: Drill;
};

function ShareList({ rows, empty }: { rows: ShareRow[]; empty: string }) {
  const { money } = useApp();
  if (!rows.length) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <ul className="space-y-1">
      {rows.map((row) => (
        <li key={row.key}>
          <Link href={drillHref(row.drill)} className="block rounded-lg px-2 py-1.5 hover:bg-accent/60">
            <span className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm">
                {row.name}
                {row.hint && <span className="ms-1 text-xs text-muted-foreground">{row.hint}</span>}
              </span>
              <span className="shrink-0 text-sm tabular-nums">{money(row.amount)}</span>
            </span>
            <span className="mt-1 flex items-center gap-2">
              <ProgressBar value={Math.max(0, row.share ?? 0)} className="h-1" />
              <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{percentText(row.share)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function RevenueView({ data, preset }: { data: RevenueAnalytics; preset: string }) {
  const { money, locale, isBusiness } = useApp();
  const { totals } = data;
  const compact = (v: number) => formatMoney(v, data.currency, { locale, compact: true });
  const hasRevenue = totals.gross !== 0 || totals.refunds !== 0 || totals.previous !== 0;

  return (
    <div className="space-y-4">
      <RangeSelect preset={preset} fallback="last_12_months" range={data.range} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={ArrowDownLeft}
          label="Revenue"
          value={money(totals.revenue)}
          hint={<Delta value={totals.changePercent} />}
          tone="good"
          href={drillHref(totals.drill)}
        />
        <StatCard
          icon={Receipt}
          label="Invoiced and received"
          value={money(totals.gross)}
          hint={`${totals.transactionCount} payments`}
          href={drillHref(totals.drill)}
        />
        <StatCard icon={Undo2} label="Refunded to customers" value={money(totals.refunds)} hint="Subtracted from revenue" />
        <StatCard
          icon={CalendarRange}
          label="Previous period"
          value={money(totals.previous)}
          hint={`${formatDay(data.previousRange.from, "short")} – ${formatDay(data.previousRange.to, "short")} · ${money(totals.change, undefined, { signed: true })}`}
          href={drillHref(totals.previousDrill)}
        />
      </div>

      {!hasRevenue ? (
        <EmptyState
          icon={ArrowDownLeft}
          title="No revenue in this period"
          description={
            isBusiness
              ? "Record income, mark invoices as paid, or connect Stripe, PayPal or your bank. Revenue here is cash received, less refunds."
              : "Income you record shows up here by month, source and payer."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => openAddTransaction("income")}>
                Record income
              </Button>
              {isBusiness && (
                <Button size="sm" variant="outline" render={<Link href="/integrations" />}>
                  Connect an app
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <>
          <Section title="Revenue by month" hint="Cash received less refunds; actual">
            <BarsChart
              data={data.byMonth.map((m) => ({
                label: m.month,
                revenue: m.amount,
              }))}
              series={[{ key: "revenue", label: "Revenue", color: SERIES.primary }]}
              format={(v) => money(v)}
              axisFormat={compact}
              tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
              labelFormat={(label) => formatMonth(label)}
            />
          </Section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="By customer">
              <ShareList
                rows={data.byCustomer.map((r) => ({
                  key: r.counterpartyId ?? "none",
                  name: r.name,
                  hint: `${r.count}×`,
                  amount: r.amount,
                  share: r.share,
                  drill: r.drill,
                }))}
                empty="No customers recorded."
              />
            </Section>
            <Section title="By project">
              <ShareList
                rows={data.byProject.map((r) => ({
                  key: r.projectId ?? "none",
                  name: r.name,
                  amount: r.amount,
                  share: r.share,
                  drill: r.drill,
                }))}
                empty="No revenue is tagged with a project."
              />
            </Section>
            <Section title="By source" hint="How it was recorded or which app it came from">
              <ShareList
                rows={data.bySource.map((r) => ({
                  key: `${r.source}-${r.connectionId ?? ""}`,
                  name: r.label,
                  hint: r.connectionId ? r.source : undefined,
                  amount: r.amount,
                  share: r.share,
                  drill: r.drill,
                }))}
                empty="Nothing recorded."
              />
            </Section>
            <Section title="By category">
              <ShareList
                rows={data.byCategory.map((r) => ({
                  key: r.categoryId ?? "none",
                  name: r.name,
                  amount: r.amount,
                  share: r.share,
                  drill: r.drill,
                }))}
                empty="Nothing recorded."
              />
            </Section>
          </div>
        </>
      )}

      <section className="space-y-3 rounded-xl border border-dashed border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">Expected</Badge>
          <h2 className="text-sm font-semibold">Recurring revenue</h2>
          <span className="text-xs text-muted-foreground">Scheduled income from commitments — not yet received, never counted above</span>
        </div>
        {data.expectedRecurring.items.length ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <p className="text-2xl font-semibold tabular-nums">
                {money(data.expectedRecurring.monthly)}
                <span className="text-sm font-normal text-muted-foreground"> a month</span>
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">{money(data.expectedRecurring.annualized)} a year</p>
            </div>
            <ul className="divide-y divide-border">
              {data.expectedRecurring.items.map((item) => (
                <li key={item.commitmentId} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{item.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {money(item.amount, item.currency)} {item.frequency.replace(/_/g, "-")}
                      {item.nextDueDate ? ` · next ${formatDay(item.nextDueDate, "short")}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">
                    {item.baseMonthly === null ? <span className="text-xs text-amber-600 dark:text-amber-400">no rate</span> : `${money(item.baseMonthly)}/mo`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Repeat className="size-4" />
            Add a retainer or subscription income as a commitment to see what is expected each month.
            <Link href={drillHref(data.expectedRecurring.drill)} className="shrink-0 text-xs font-medium text-foreground hover:underline underline-offset-4">
              Commitments
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
