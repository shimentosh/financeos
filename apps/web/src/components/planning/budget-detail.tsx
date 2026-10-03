"use client";

import { formatDay, formatMoney } from "@financeos/core";
import { CalendarRange, ExternalLink, Gauge, Pencil, PiggyBank, Trash2, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Facts, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { BudgetDetail } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { BudgetFormDialog, PERIOD_LABELS } from "./budget-form";
import { BUDGET_STATUS_LABEL, BudgetFigures, scopeLabel } from "./budgets-view";
import { ConfirmDialog } from "./occurrence-history";
import { SegmentedTabs, toneForBudget, useQueryNav } from "./shared";

function periodLabel(from: string, to: string, period: string) {
  if (period === "monthly") return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${from}T00:00:00Z`));
  if (period === "quarterly") return `Q${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1} ${from.slice(2, 4)}`;
  if (period === "yearly") return from.slice(0, 7) === `${from.slice(0, 4)}-01` ? from.slice(0, 4) : `FY ${from.slice(2, 4)}/${to.slice(2, 4)}`;
  return `${formatDay(from, "short")}–${to === "2999-12-31" ? "now" : formatDay(to, "short")}`;
}

export function BudgetDetailView({ budget: b, periods }: { budget: BudgetDetail; periods: number }) {
  const { money, canWrite, locale } = useApp();
  const router = useRouter();
  const { update } = useQueryNav();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await clientApi(`/budgets/${b.id}`, { method: "DELETE" });
      toast.success("Budget deleted");
      invalidateApiCache("/budgets");
      router.push("/budgets");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const chart = b.history.map((h) => ({ label: periodLabel(h.from, h.to, b.period), budget: h.budget, actual: h.actual }));
  const tone = toneForBudget(b.metrics.status);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {scopeLabel(b)} · {PERIOD_LABELS[b.period]}
              </p>
              <p className={cn("mt-1 text-3xl font-semibold tabular-nums", tone === "danger" && "text-red-600 dark:text-red-400")}>{b.metrics.utilization}%</p>
              <p className="text-sm text-muted-foreground">
                of {money(b.amount)} used, {formatDay(b.range.from, "short")} – {b.range.to === "2999-12-31" ? "now" : formatDay(b.range.to, "short")}
              </p>
            </div>
            <StatusBadge
              status={b.metrics.status === "on_track" ? "active" : b.metrics.status === "over" ? "overdue" : "renewal_due"}
              label={b.inEffect ? BUDGET_STATUS_LABEL[b.metrics.status] : "Not in effect"}
            />
          </div>
          <BudgetFigures metrics={b.metrics} range={b.range} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" render={<Link href={b.drilldown.href} />}>
              <ExternalLink className="size-3.5" /> Transactions behind it
            </Button>
            {canWrite && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" /> Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              </>
            )}
          </div>
        </div>
        <Section title="Details">
          <Facts
            items={[
              { label: "Covers", value: scopeLabel(b) },
              { label: "Period", value: PERIOD_LABELS[b.period] },
              { label: "Budget", value: <span className="tabular-nums">{money(b.amount)}</span> },
              { label: "Warn at", value: `${b.alertThreshold}% and at 100%` },
              { label: "Starts", value: formatDay(b.startDate) },
              { label: "Ends", value: b.endDate ? formatDay(b.endDate) : "Open-ended" },
              { label: "Status", value: b.active ? "Active" : "Inactive" },
              b.categoryIds.length > 1 ? { label: "Categories counted", value: `${b.categoryName} + ${b.categoryIds.length - 1} subcategories` } : false,
            ]}
          />
          {b.notes && <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm">{b.notes}</p>}
        </Section>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Wallet} label="Spent" value={money(b.metrics.actual)} hint="Expenses less refunds" href={b.drilldown.href} />
        <StatCard
          icon={PiggyBank}
          label={b.metrics.remaining < 0 ? "Over by" : "Left"}
          value={money(Math.abs(b.metrics.remaining))}
          tone={b.metrics.remaining < 0 ? "danger" : "good"}
        />
        <StatCard
          icon={TrendingUp}
          label="Projected"
          value={b.metrics.projected !== null ? money(b.metrics.projected) : "—"}
          hint={b.metrics.projected !== null ? "At the current pace" : "Period not running"}
          tone={b.metrics.projected !== null && b.metrics.projected > b.amount ? "warn" : "default"}
        />
        <StatCard
          icon={CalendarRange}
          label="Days left"
          value={b.metrics.daysLeft}
          hint={b.range.to === "2999-12-31" ? "Open-ended" : `Until ${formatDay(b.range.to, "short")}`}
        />
      </div>

      <Section
        title="History"
        hint="Budget and actual spending per period"
        actions={
          b.period === "total" ? undefined : (
            <SegmentedTabs
              label="Periods"
              value={String(periods) as "6" | "12"}
              options={[
                { value: "6", label: "6" },
                { value: "12", label: "12" },
              ]}
              onChange={(v) => update({ periods: v === "6" ? null : v })}
            />
          )
        }
      >
        <BarsChart
          data={chart}
          series={[
            { key: "budget", label: "Budget", color: SERIES.secondary },
            { key: "actual", label: "Spent", color: SERIES.primary },
          ]}
          format={(v) => money(v)}
          axisFormat={(v) => formatMoney(v, b.currency, { locale, compact: true })}
          height={220}
          table={false}
        />
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Period</th>
                <th className="text-right!">Spent</th>
                <th className="hidden text-right! sm:table-cell">Budget</th>
                <th className="text-right!">Used</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...b.history].reverse().map((h) => (
                <tr key={h.from}>
                  <td className="px-3 py-2">
                    {periodLabel(h.from, h.to, b.period)}
                    <span className="ms-1 hidden text-xs text-muted-foreground sm:inline">
                      {formatDay(h.from, "short")} – {h.to === "2999-12-31" ? "now" : formatDay(h.to, "short")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <Link href={h.drilldown.href} className="hover:underline">
                      {money(h.actual)}
                    </Link>
                  </td>
                  <td className="hidden px-3 py-2 text-right text-muted-foreground tabular-nums sm:table-cell">{money(h.budget)}</td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right tabular-nums",
                      h.status === "over" && "text-red-600 dark:text-red-400",
                      h.status === "warning" && "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {h.utilization}%
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Gauge className={cn("size-3.5", h.status === "over" ? "text-red-500" : h.status === "warning" ? "text-amber-500" : "text-emerald-500")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <BudgetFormDialog open={editing} onOpenChange={setEditing} budget={b} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${b.name}?`}
        description="The budget and its alerts go. Your transactions are not touched."
        confirmLabel="Delete budget"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
