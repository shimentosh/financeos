"use client";

import { formatDay, formatMoney } from "@financeos/core";
import { ArrowRightLeft, CalendarClock, Minus, Pencil, PiggyBank, Plus, Target, Trash2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, Facts, ProgressBar, Section, StatCard } from "@/components/app/blocks";
import { BarsChart, SERIES, TrendChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import { fileUrl } from "@/lib/api/files";
import type { GoalContribution, GoalDetail } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { ContributionDialog, GOAL_KIND_LABELS, GoalFormDialog, PRIORITY_LABELS } from "./goal-form";
import { OnTrackBadge, paceStatement } from "./goals-view";
import { ConfirmDialog } from "./occurrence-history";

export function GoalDetailView({ goal: g }: { goal: GoalDetail }) {
  const { money, canWrite, locale } = useApp();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [contributing, setContributing] = useState<"add" | "withdraw" | null>(null);
  const [removing, setRemoving] = useState<GoalContribution | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const removeContribution = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await clientApi(`/goals/${g.id}/contributions/${removing.id}`, { method: "DELETE" });
      toast.success(removing.transactionId ? "Contribution removed; its transfer was voided" : "Contribution removed");
      invalidateApiCache("/goals");
      setRemoving(null);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const result = await clientApi<{ deleted: boolean; archived: boolean }>(`/goals/${g.id}`, { method: "DELETE" });
      toast.success(result.deleted ? "Goal deleted" : "It has contributions, so it was archived");
      invalidateApiCache("/goals");
      router.push(g.kind === "dream_asset" ? "/goals/dream-assets" : "/goals");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const plan = g.monthlyPlan ?? 0;
  const monthly = g.monthly.map((m) => ({ label: m.month, planned: m.planned ?? 0, actual: m.actual, cumulative: m.cumulative }));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {GOAL_KIND_LABELS[g.kind]} · {PRIORITY_LABELS[g.priority]} priority
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{money(g.current, g.currency)}</p>
              <p className="text-sm text-muted-foreground">
                of {money(g.targetAmount, g.currency)} · {g.progress.progress}%
              </p>
            </div>
            <OnTrackBadge goal={g} />
          </div>
          <ProgressBar value={g.progress.progress} tone={g.status === "achieved" ? "good" : g.progress.onTrack === false ? "warn" : "default"} />
          <p className={cn("rounded-lg px-3 py-2 text-sm", g.status === "achieved" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted")}>
            {paceStatement(g, money)}
          </p>
          {g.accountUnconverted && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              The linked account is in another currency with no exchange rate; progress uses logged contributions.
            </p>
          )}
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {g.status !== "archived" && (
                <>
                  <Button size="sm" onClick={() => setContributing("add")}>
                    <Plus className="size-3.5" /> Add money
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setContributing("withdraw")}>
                    <Minus className="size-3.5" /> Withdraw
                  </Button>
                </>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 className="size-3.5" /> {g.contributions.length ? "Archive" : "Delete"}
              </Button>
            </div>
          )}
        </div>
        <Section title="Details">
          {g.imageFileId && (
            <a href={fileUrl(g.imageFileId)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border">
              {/* biome-ignore lint/performance/noImgElement: authenticated file route, not a static asset */}
              <img src={fileUrl(g.imageFileId)} alt={g.name} className="max-h-56 w-full object-cover" />
            </a>
          )}
          <Facts
            items={[
              { label: "Target", value: <span className="tabular-nums">{money(g.targetAmount, g.currency)}</span> },
              { label: "Target date", value: g.targetDate ? formatDay(g.targetDate) : "None" },
              { label: "Progress from", value: g.currentSource === "account" ? `${g.linkedAccountName ?? "Account"} balance` : "Contributions you log" },
              { label: "Starting amount", value: <span className="tabular-nums">{money(g.startingAmount, g.currency)}</span> },
              { label: "Contributed", value: <span className="tabular-nums">{money(g.contributed, g.currency)}</span> },
              g.monthlyPlan ? { label: "Monthly plan", value: <span className="tabular-nums">{money(g.monthlyPlan, g.currency)}</span> } : false,
              g.progress.requiredMonthly !== null
                ? { label: "Needed per month", value: <span className="tabular-nums">{money(g.progress.requiredMonthly, g.currency)}</span> }
                : false,
              g.progress.monthsLeft !== null ? { label: "Months left", value: g.progress.monthsLeft } : false,
              g.progress.projectedCompletion ? { label: "Projected completion", value: formatDay(g.progress.projectedCompletion) } : false,
              { label: "Status", value: g.status === "achieved" && g.achievedAt ? `Achieved ${formatDay(g.achievedAt.slice(0, 10))}` : g.status },
            ]}
          />
          {g.notes && <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm">{g.notes}</p>}
        </Section>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={PiggyBank}
          label="Saved"
          value={money(g.current, g.currency)}
          hint={g.currency !== g.baseCurrency && g.currentBase !== null ? `≈ ${money(g.currentBase)}` : `${g.progress.progress}% of target`}
        />
        <StatCard icon={Target} label="Still to go" value={money(g.progress.remaining, g.currency)} tone={g.progress.remaining === 0 ? "good" : "default"} />
        <StatCard
          icon={TrendingUp}
          label="Needed per month"
          value={g.progress.requiredMonthly !== null ? money(g.progress.requiredMonthly, g.currency) : "—"}
          hint={g.targetDate ? `By ${formatDay(g.targetDate, "short")}` : "Set a target date"}
        />
        <StatCard
          icon={CalendarClock}
          label="Planned per month"
          value={plan ? money(plan, g.currency) : "—"}
          hint={g.progress.onTrack === false ? "Below what is needed" : g.progress.onTrack ? "Enough to finish on time" : "No plan set"}
          tone={g.progress.onTrack === false ? "warn" : "default"}
        />
      </div>

      <Section title={plan ? "Planned vs saved" : "Saved over time"} hint="By month">
        {monthly.length === 0 ? (
          <EmptyNote>No contributions yet.</EmptyNote>
        ) : plan ? (
          <BarsChart
            data={monthly}
            series={[
              { key: "planned", label: "Planned", color: SERIES.secondary },
              { key: "actual", label: "Saved", color: SERIES.primary },
            ]}
            format={(v) => money(v, g.currency)}
            axisFormat={(v) => formatMoney(v, g.currency, { locale, compact: true })}
            tickFormat={(label) => formatMonth(label, "en-GB", true)}
            labelFormat={(label) => formatMonth(label)}
            height={200}
          />
        ) : (
          <TrendChart
            data={monthly}
            series={[{ key: "cumulative", label: "Saved", color: SERIES.primary }]}
            format={(v) => money(v, g.currency)}
            axisFormat={(v) => formatMoney(v, g.currency, { locale, compact: true })}
            tickFormat={(label) => formatMonth(label, "en-GB", true)}
            labelFormat={(label) => formatMonth(label)}
            height={200}
          />
        )}
      </Section>

      <Section
        title="Contributions"
        hint={g.currentSource === "account" ? "Logged here; progress itself follows the linked account's balance" : "Money added to and taken from this goal"}
      >
        {g.contributions.length === 0 ? (
          <EmptyNote
            action={
              canWrite && g.status !== "archived" ? (
                <Button size="xs" variant="outline" onClick={() => setContributing("add")}>
                  <Plus className="size-3.5" /> Add money
                </Button>
              ) : undefined
            }
          >
            Nothing logged yet.
          </EmptyNote>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                  <th>Date</th>
                  <th className="hidden sm:table-cell">Note</th>
                  <th className="hidden md:table-cell">Transfer</th>
                  <th className="text-right!">Amount</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {g.contributions.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2 tabular-nums">{formatDay(c.date)}</td>
                    <td className="hidden max-w-60 truncate px-3 py-2 text-muted-foreground sm:table-cell">{c.note ?? "—"}</td>
                    <td className="hidden px-3 py-2 md:table-cell">
                      {c.transactionHref ? (
                        <Link href={c.transactionHref} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          <ArrowRightLeft className="size-3" /> {c.transaction?.status === "void" ? "Voided transfer" : "Transfer"}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-medium tabular-nums", c.amount > 0 ? "text-money-in" : "text-red-600 dark:text-red-400")}>
                      {money(c.amount, g.currency, { signed: true })}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canWrite && (
                        <Button size="icon-xs" variant="ghost" aria-label="Remove contribution" onClick={() => setRemoving(c)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <GoalFormDialog open={editing} onOpenChange={setEditing} goal={g} />
      <ContributionDialog goal={contributing ? g : null} mode={contributing ?? "add"} onClose={() => setContributing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this contribution?"
        description={
          removing?.transactionId ? "The transfer recorded with it is voided too, so the account balances go back." : "Only the goal's progress changes."
        }
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void removeContribution()}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`${g.contributions.length ? "Archive" : "Delete"} ${g.name}?`}
        description={
          g.contributions.length
            ? "It has contributions, so it is archived and kept. Transfers stay in your ledger."
            : "It has no contributions, so it is removed completely."
        }
        confirmLabel={g.contributions.length ? "Archive" : "Delete"}
        busy={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
