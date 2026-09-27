"use client";

import { formatDay, formatMoney, type GoalKind } from "@expensewise/core";
import { CheckCircle2, Gem, PiggyBank, Plus, Target, TrendingUp, Trophy, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, EmptyState, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { fileUrl } from "@/lib/api/files";
import type { GoalDetail, GoalList, GoalView } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { ContributionDialog, GOAL_KIND_LABELS, GoalFormDialog, PRIORITY_LABELS } from "./goal-form";

export type GoalsVariant = "all" | "dream" | "savings";

function useCreateParam(): [boolean, (open: boolean) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setOpen(true);
  }, [params]);
  return [
    open,
    (next: boolean) => {
      setOpen(next);
      if (!next && params.get("new")) router.replace(window.location.pathname, { scroll: false });
    },
  ];
}

export function AddGoalButton({ kind, label = "Add goal" }: { kind?: GoalKind; label?: string }) {
  const { canWrite } = useApp();
  const router = useRouter();
  const [open, setOpen] = useCreateParam();
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> {label}
      </Button>
      <GoalFormDialog open={open} onOpenChange={setOpen} defaultKind={kind} onSaved={(id) => router.push(`/goals/${id}`)} />
    </>
  );
}

/** "You need ৳12,000/month to reach it by 10 Oct 2027", or when a plan gets there. */
export function paceStatement(goal: GoalView, money: (minor: number, currency?: string) => string): string {
  const p = goal.progress;
  if (goal.status === "achieved") return goal.achievedAt ? `Reached on ${formatDay(goal.achievedAt.slice(0, 10))}` : "Reached";
  if (p.remaining === 0) return "Target reached";
  if (goal.targetDate && p.requiredMonthly !== null) {
    return p.monthsLeft === 0
      ? `${money(p.remaining, goal.currency)} still needed by ${formatDay(goal.targetDate)}`
      : `You need ${money(p.requiredMonthly, goal.currency)}/month to reach it by ${formatDay(goal.targetDate)}`;
  }
  if (goal.monthlyPlan && p.projectedCompletion)
    return `At ${money(goal.monthlyPlan, goal.currency)}/month you'll get there around ${formatMonth(p.projectedCompletion.slice(0, 7))}`;
  return `${money(p.remaining, goal.currency)} to go — set a target date or a monthly plan to see the pace`;
}

export function OnTrackBadge({ goal }: { goal: GoalView }) {
  if (goal.status === "achieved") return <StatusBadge status="paid" label="Achieved" />;
  if (goal.status !== "active") return <StatusBadge status="paused" label={goal.status} />;
  if (goal.progress.onTrack === true) return <StatusBadge status="active" label="On track" />;
  if (goal.progress.onTrack === false) return <StatusBadge status="renewal_due" label="Behind plan" />;
  return null;
}

function GoalCard({ goal, onAdd }: { goal: GoalView; onAdd?: (goal: GoalView) => void }) {
  const { money, canWrite } = useApp();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <Link href={`/goals/${goal.id}`} className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {goal.kind === "dream_asset" ? (
              <Gem className="size-4" />
            ) : goal.kind === "emergency_fund" ? (
              <PiggyBank className="size-4" />
            ) : (
              <Target className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium hover:underline">{goal.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {GOAL_KIND_LABELS[goal.kind]} · {PRIORITY_LABELS[goal.priority]} priority
            </p>
          </div>
        </div>
        <OnTrackBadge goal={goal} />
      </Link>
      <div className="space-y-1.5">
        <ProgressBar value={goal.progress.progress} tone={goal.status === "achieved" ? "good" : goal.progress.onTrack === false ? "warn" : "default"} />
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="tabular-nums">
            <span className="font-semibold">{money(goal.current, goal.currency)}</span>
            <span className="text-muted-foreground"> of {money(goal.targetAmount, goal.currency)}</span>
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{goal.progress.progress}%</span>
        </div>
        <p className="text-xs text-muted-foreground">{paceStatement(goal, money)}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        <span className="truncate">
          {goal.currentSource === "account" && goal.linkedAccountName
            ? `Tracks ${goal.linkedAccountName}`
            : goal.targetDate
              ? `By ${formatDay(goal.targetDate)}`
              : "No deadline"}
        </span>
        {canWrite && onAdd && goal.status === "active" && (
          <Button size="xs" variant="outline" onClick={() => onAdd(goal)}>
            <Plus className="size-3.5" /> Add money
          </Button>
        )}
      </div>
    </div>
  );
}

/** A dream asset: the thing, its price, how far along, and the monthly pace to get it. */
function DreamCard({ goal, onAdd }: { goal: GoalView; onAdd: (goal: GoalView) => void }) {
  const { money, canWrite } = useApp();
  const tone =
    goal.priority === "high"
      ? "from-violet-500/20 to-fuchsia-500/10"
      : goal.priority === "medium"
        ? "from-sky-500/20 to-cyan-500/10"
        : "from-emerald-500/15 to-teal-500/10";
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <Link
        href={`/goals/${goal.id}`}
        className={cn("relative flex items-end overflow-hidden bg-gradient-to-br p-4", goal.imageFileId ? "h-40" : "h-28", tone)}
      >
        {goal.imageFileId ? (
          <>
            {/* biome-ignore lint/performance/noImgElement: authenticated file route, not a static asset */}
            <img src={fileUrl(goal.imageFileId)} alt="" className="absolute inset-0 size-full object-cover" />
            <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" aria-hidden />
          </>
        ) : (
          <Gem className="absolute top-4 right-4 size-10 text-foreground/15" />
        )}
        <div className={cn("relative min-w-0", goal.imageFileId && "text-white")}>
          <p className="truncate text-lg font-semibold">{goal.name}</p>
          <p className={cn("text-sm tabular-nums", goal.imageFileId ? "text-white/80" : "text-muted-foreground")}>{money(goal.targetAmount, goal.currency)}</p>
        </div>
      </Link>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums">{goal.progress.progress}%</span>
            <span className="text-sm tabular-nums text-muted-foreground">{money(goal.current, goal.currency)} saved</span>
          </div>
          <ProgressBar value={goal.progress.progress} tone={goal.status === "achieved" ? "good" : "info"} />
        </div>
        <p className="text-sm">{paceStatement(goal, money)}</p>
        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-md bg-muted px-1.5 py-0.5">{PRIORITY_LABELS[goal.priority]} priority</span>
          {goal.targetDate && <span className="rounded-md bg-muted px-1.5 py-0.5">Target {formatDay(goal.targetDate)}</span>}
          {goal.currentSource === "account" && goal.linkedAccountName && (
            <span className="rounded-md bg-muted px-1.5 py-0.5">Tracks {goal.linkedAccountName}</span>
          )}
        </div>
        {goal.notes && <p className="line-clamp-2 text-xs text-muted-foreground">{goal.notes}</p>}
        {canWrite && goal.status === "active" && (
          <Button size="sm" variant="outline" className="mt-auto" onClick={() => onAdd(goal)}>
            <Plus className="size-3.5" /> Add money
          </Button>
        )}
      </div>
    </div>
  );
}

/** A savings plan: planned vs actual per month. */
function SavingsPlanCard({ goal, onAdd }: { goal: GoalDetail; onAdd: (goal: GoalView) => void }) {
  const { money, locale, canWrite } = useApp();
  const months = goal.monthly.slice(-12);
  const met = months.filter((m) => m.metPlan).length;
  return (
    <Section
      title={
        <Link href={`/goals/${goal.id}`} className="hover:underline">
          {goal.name}
        </Link>
      }
      hint={`${money(goal.monthlyPlan ?? 0, goal.currency)} a month planned · ${money(goal.current, goal.currency)} of ${money(goal.targetAmount, goal.currency)} saved`}
      actions={
        <div className="flex items-center gap-2">
          <OnTrackBadge goal={goal} />
          {canWrite && goal.status === "active" && (
            <Button size="xs" variant="outline" onClick={() => onAdd(goal)}>
              <Plus className="size-3.5" /> Add money
            </Button>
          )}
        </div>
      }
    >
      <ProgressBar value={goal.progress.progress} tone={goal.progress.onTrack === false ? "warn" : "default"} />
      <p className="text-xs text-muted-foreground">
        {paceStatement(goal, money)} · plan met in {met} of the last {months.length} {months.length === 1 ? "month" : "months"}
      </p>
      {months.length > 0 ? (
        <BarsChart
          data={months.map((m) => ({ label: m.month, planned: m.planned ?? 0, actual: m.actual }))}
          series={[
            { key: "planned", label: "Planned", color: SERIES.secondary },
            { key: "actual", label: "Saved", color: SERIES.primary },
          ]}
          format={(v) => money(v, goal.currency)}
          axisFormat={(v) => formatMoney(v, goal.currency, { locale, compact: true })}
          tickFormat={(label) => formatMonth(label, "en-GB", true)}
          labelFormat={(label) => formatMonth(label)}
          height={180}
        />
      ) : (
        <EmptyNote>No months yet.</EmptyNote>
      )}
    </Section>
  );
}

export function GoalsView({ list, variant, details = [] }: { list: GoalList; variant: GoalsVariant; details?: GoalDetail[] }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState<GoalView | null>(null);
  const defaultKind: GoalKind = variant === "dream" ? "dream_asset" : "savings";
  const active = list.items.filter((g) => g.status === "active" || g.status === "paused");
  const done = list.items.filter((g) => g.status === "achieved");
  const archived = list.items.filter((g) => g.status === "archived");

  const create = <GoalFormDialog open={creating} onOpenChange={setCreating} defaultKind={defaultKind} onSaved={(id) => router.push(`/goals/${id}`)} />;

  if (list.total === 0) {
    const copy =
      variant === "dream"
        ? {
            icon: Gem,
            title: "What are you dreaming of?",
            description: "A car, a MacBook, a flat, a trip abroad. Add its price and see how much to put aside each month to get it by when you want it.",
            action: "Add a dream asset",
          }
        : variant === "savings"
          ? {
              icon: Wallet,
              title: "No savings plans yet",
              description: "Give a goal a monthly amount — ৳10,000 a month for an emergency fund — and track planned versus actual every month.",
              action: "Start a savings plan",
            }
          : {
              icon: Target,
              title: "Set your first goal",
              description:
                "An emergency fund, Hajj, a new laptop, business capital. Log contributions or link a savings account and see how far along you are.",
              action: "Set a goal",
            };
    return (
      <>
        <EmptyState
          icon={copy.icon}
          title={copy.title}
          description={copy.description}
          action={
            canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> {copy.action}
              </Button>
            ) : undefined
          }
        />
        {create}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Target} label="Active" value={list.summary.active} hint={`${list.total} in total`} />
        <StatCard
          icon={PiggyBank}
          label="Saved"
          value={money(list.summary.currentBase)}
          hint={
            list.summary.targetBase
              ? `${Math.round((list.summary.currentBase / list.summary.targetBase) * 100)}% of ${money(list.summary.targetBase)}`
              : "Across active goals"
          }
        />
        <StatCard
          icon={TrendingUp}
          label="Planned each month"
          value={money(list.summary.monthlyPlanned)}
          hint="Across savings plans"
          href={variant === "savings" ? undefined : "/goals/savings-plans"}
        />
        <StatCard icon={Trophy} label="Achieved" value={list.summary.achieved} tone={list.summary.achieved ? "good" : "default"} />
      </div>

      {variant === "savings" ? (
        <div className="space-y-4">
          {details
            .filter((g) => g.status === "active" || g.status === "paused")
            .map((goal) => (
              <SavingsPlanCard key={goal.id} goal={goal} onAdd={setAdding} />
            ))}
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", variant === "dream" ? "xl:grid-cols-3" : "xl:grid-cols-3")}>
          {active.map((goal) =>
            variant === "dream" ? <DreamCard key={goal.id} goal={goal} onAdd={setAdding} /> : <GoalCard key={goal.id} goal={goal} onAdd={setAdding} />,
          )}
        </div>
      )}

      {active.length === 0 && variant !== "savings" && <EmptyNote>Every goal here is achieved or archived. Add the next one.</EmptyNote>}

      {done.length > 0 && (
        <Section title="Achieved" hint="Goals you reached">
          <ul className="divide-y divide-border">
            {done.map((goal) => (
              <li key={goal.id}>
                <Link href={`/goals/${goal.id}`} className="flex items-center justify-between gap-2 py-2 text-sm hover:bg-accent/30">
                  <span className="flex min-w-0 items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                    <span className="truncate">{goal.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {money(goal.targetAmount, goal.currency)}
                    {goal.achievedAt ? ` · ${formatDay(goal.achievedAt.slice(0, 10))}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {archived.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {archived.length} archived {archived.length === 1 ? "goal" : "goals"}:{" "}
          {archived.map((g, index) => (
            <span key={g.id}>
              {index > 0 && ", "}
              <Link href={`/goals/${g.id}`} className="hover:underline">
                {g.name}
              </Link>
            </span>
          ))}
        </p>
      )}

      {create}
      <ContributionDialog goal={adding} mode="add" onClose={() => setAdding(null)} />
    </div>
  );
}
