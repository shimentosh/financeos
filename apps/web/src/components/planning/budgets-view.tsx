"use client";

import { addMonths, formatDay, formatMoney } from "@financeos/core";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, PiggyBank, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryTile, EmptyState, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import type { BudgetList, BudgetMetrics, BudgetView } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { BudgetFormDialog, PERIOD_LABELS } from "./budget-form";
import { toneForBudget, useQueryNav } from "./shared";

export const BUDGET_STATUS_LABEL: Record<string, string> = { on_track: "On track", warning: "Warning", over: "Over budget", under: "Under" };

export function AddBudgetButton() {
  const { canWrite } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setOpen(true);
  }, [params]);
  if (!canWrite) return null;
  const change = (next: boolean) => {
    setOpen(next);
    if (!next && params.get("new")) router.replace("/budgets", { scroll: false });
  };
  return (
    <>
      <Button size="xs" onClick={() => change(true)}>
        <Plus className="size-3.5" /> Create budget
      </Button>
      <BudgetFormDialog open={open} onOpenChange={change} />
    </>
  );
}

/** "Spent ৳8,500 of ৳10,000 · ৳1,500 left" and the pace line under it. */
export function BudgetFigures({ metrics, range, compact }: { metrics: BudgetMetrics; range: { from: string; to: string }; compact?: boolean }) {
  const { money } = useApp();
  const over = metrics.remaining < 0;
  return (
    <div className="space-y-1.5">
      <ProgressBar value={metrics.utilization} tone={toneForBudget(metrics.status)} />
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="tabular-nums">
          <span className="font-semibold">{money(metrics.actual)}</span>
          <span className="text-muted-foreground"> of {money(metrics.budget)}</span>
        </span>
        <span className={cn("shrink-0 text-xs tabular-nums", over ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
          {over ? `${money(-metrics.remaining)} over` : `${money(metrics.remaining)} left`} · {metrics.utilization}%
        </span>
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {metrics.projected !== null
            ? `On pace for ${money(metrics.projected)} by ${formatDay(range.to, "short")}${metrics.projected > metrics.budget ? " — over budget" : ""} · ${metrics.daysLeft} ${metrics.daysLeft === 1 ? "day" : "days"} left`
            : range.to === "2999-12-31"
              ? `Since ${formatDay(range.from)}`
              : `${formatDay(range.from, "short")} – ${formatDay(range.to, "short")}`}
        </p>
      )}
    </div>
  );
}

export function scopeLabel(budget: BudgetView) {
  if (budget.scope === "workspace") return "All spending";
  if (budget.scope === "project") return budget.projectName ?? "Project";
  if (budget.scope === "category_project") return `${budget.categoryName ?? "Category"} · ${budget.projectName ?? "Project"}`;
  return budget.categoryName ?? "Category";
}

export function BudgetsView({ list, today }: { list: BudgetList; today: string }) {
  const { money, canWrite, locale } = useApp();
  const { update, pending } = useQueryNav();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const measured = list.items.filter((b) => b.inEffect);
  // Budgets overlap (all spending contains every category), so the headline never adds them all up:
  // the overall budget when there is one, otherwise the category budgets of one period.
  const overall = measured.filter((b) => b.scope === "workspace").sort((a, b) => Number(b.period === "monthly") - Number(a.period === "monthly"))[0];
  const firstCategory = measured.find((b) => b.scope === "category");
  const headline = overall ? [overall] : measured.filter((b) => b.scope === "category" && b.period === firstCategory?.period);
  const budgeted = headline.reduce((sum, b) => sum + b.metrics.budget, 0);
  const spent = headline.reduce((sum, b) => sum + b.metrics.actual, 0);
  const headlineHint = overall ? overall.name : `${headline.length} category budget${headline.length === 1 ? "" : "s"}`;
  const month = list.date.slice(0, 7);
  const shift = (months: number) => {
    const next = addMonths(`${month}-01`, months);
    update({ date: next.slice(0, 7) === today.slice(0, 7) ? null : next });
  };

  if (list.total === 0) {
    return (
      <>
        <EmptyState
          icon={PiggyBank}
          title="No budgets yet"
          description="Set a monthly limit for groceries, eating out, transport — or for all spending. You'll see the pace as you go and get a warning before you run over."
          action={
            canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> Create budget
              </Button>
            ) : undefined
          }
        />
        <BudgetFormDialog open={creating} onOpenChange={setCreating} onSaved={(id) => router.push(`/budgets/${id}`)} />
      </>
    );
  }

  const chart = measured.map((b) => ({ label: b.name, budget: b.metrics.budget, actual: b.metrics.actual }));

  return (
    <div className={cn("space-y-4 transition-opacity", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="icon-sm" variant="outline" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-32 text-center text-sm font-medium">{formatMonth(month)}</span>
        <Button size="icon-sm" variant="outline" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight className="size-4" />
        </Button>
        {month !== today.slice(0, 7) && (
          <Button size="xs" variant="ghost" onClick={() => update({ date: null })}>
            This month
          </Button>
        )}
        <span className="ms-2 text-xs text-muted-foreground">Each budget is measured over its own period containing {formatDay(list.date)}.</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={Wallet}
          label={overall ? "Overall budget" : "Budgeted"}
          value={money(budgeted)}
          hint={`${headlineHint} · ${measured.length} in effect`}
        />
        <StatCard
          icon={PiggyBank}
          label="Spent"
          value={money(spent)}
          hint={budgeted ? `${Math.round((spent / budgeted) * 100)}% of ${overall ? "the overall budget" : "those budgets"}` : "—"}
        />
        <StatCard
          icon={AlertTriangle}
          label="Warning"
          value={list.summary.warning}
          tone={list.summary.warning ? "warn" : "default"}
          hint="Past their alert threshold"
        />
        <StatCard
          icon={list.summary.over ? CircleAlert : CheckCircle2}
          label="Over budget"
          value={list.summary.over}
          tone={list.summary.over ? "danger" : "good"}
          hint={`${list.summary.onTrack} on track`}
        />
      </div>

      {chart.length > 1 && (
        <Section title="Budget vs actual" hint={`Period containing ${formatDay(list.date)}`}>
          <BarsChart
            data={chart}
            series={[
              { key: "budget", label: "Budget", color: SERIES.secondary },
              { key: "actual", label: "Spent", color: SERIES.primary },
            ]}
            format={(v) => money(v)}
            axisFormat={(v) => formatMoney(v, list.baseCurrency, { locale, compact: true })}
            height={200}
          />
        </Section>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.items.map((budget) => (
          <div key={budget.id} className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4", !budget.inEffect && "opacity-70")}>
            <Link href={`/budgets/${budget.id}${list.date !== today ? `?date=${list.date}` : ""}`} className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <CategoryTile icon={budget.categoryIcon ?? (budget.scope === "workspace" ? "circle-dashed" : "briefcase")} color={budget.categoryColor} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium hover:underline">{budget.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {scopeLabel(budget)} · {PERIOD_LABELS[budget.period].split(" ")[0]}
                  </p>
                </div>
              </div>
              {budget.inEffect ? (
                <StatusBadge
                  status={budget.metrics.status === "on_track" ? "active" : budget.metrics.status === "over" ? "overdue" : "renewal_due"}
                  label={BUDGET_STATUS_LABEL[budget.metrics.status]}
                />
              ) : (
                <StatusBadge status="paused" label={budget.active ? "Not in effect" : "Inactive"} />
              )}
            </Link>
            <BudgetFigures metrics={budget.metrics} range={budget.range} />
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs">
              <span className="text-muted-foreground tabular-nums">Variance {money(budget.metrics.variance, undefined, { signed: true })}</span>
              <Link href={budget.drilldown.href} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                Transactions <ExternalLink className="size-3" />
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
