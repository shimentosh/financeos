"use client";

import { formatDay, formatMoney } from "@expensewise/core";
import { ArrowDownLeft, ArrowUpRight, CircleAlert, Flame, HandCoins, Hourglass, Landmark, Pencil, PiggyBank, Receipt, Repeat, TrendingUp } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/api/types";
import type { ProjectProfile, RecurringSummary } from "@/lib/api/types/business";
import { cn } from "@/lib/cn";
import { percentText } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import { drillHref, groupDrillHref } from "./drill";
import { ProjectFormDialog } from "./projects";
import { RangeSelect } from "./range-select";

/** A labelled band that says whether the numbers under it happened or are expected. */
function Band({ kind, title, hint, children }: { kind: "actual" | "estimated"; title: string; hint: string; children: ReactNode }) {
  return (
    <section className={cn("space-y-3 rounded-xl p-3 sm:p-4", kind === "estimated" ? "border border-dashed border-border" : "bg-muted/30")}>
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Badge variant={kind === "actual" ? "success" : "info"}>{kind === "actual" ? "Actual" : "Estimated"}</Badge>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function RecurringList({ summary, empty }: { summary: RecurringSummary; empty: string }) {
  const { money } = useApp();
  if (!summary.items.length) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <ul className="divide-y divide-border">
      {summary.items.map((item) => (
        <li key={item.commitmentId} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-sm">{item.name}</span>
            <span className="block text-xs text-muted-foreground">
              {money(item.amount, item.currency)} {item.frequency.replace(/_/g, "-")}
              {item.nextDueDate ? ` · next ${formatDay(item.nextDueDate, "short")}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-right text-sm tabular-nums">
            {item.baseMonthly === null ? <span className="text-xs text-amber-600 dark:text-amber-400">no rate</span> : `${money(item.baseMonthly)}/mo`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ProjectProfileView({ profile, project, preset }: { profile: ProjectProfile; project: Project | null; preset: string }) {
  const { money, locale, canWrite } = useApp();
  const [editing, setEditing] = useState(false);
  const { actual, estimated } = profile;
  const compact = (v: number) => formatMoney(v, profile.currency, { locale, compact: true });
  const net = actual.netContribution.amount;
  const hasActivity =
    actual.revenue.amount !== 0 || actual.cost.amount !== 0 || actual.capitalInvested.amount !== 0 || actual.monthly.some((m) => m.revenue || m.cost);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <RangeSelect preset={preset} fallback="all_time" range={profile.range} />
          {profile.project.status !== "active" && (
            <StatusBadge status={profile.project.status === "completed" ? "paid" : "paused"} label={profile.project.status} />
          )}
        </div>
        {canWrite && project && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" /> Edit project
          </Button>
        )}
      </div>

      {profile.warnings.length > 0 && (
        <div className="space-y-1 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {profile.warnings.map((w) => (
            <p key={w} className="flex items-center gap-1.5">
              <CircleAlert className="size-3.5 shrink-0" /> {w}{" "}
              <Link href="/settings/currency" className="underline underline-offset-2">
                Add a rate
              </Link>
            </p>
          ))}
        </div>
      )}

      <Band kind="actual" title="What happened" hint="Posted transactions tagged with this project; refunds net against revenue and cost">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            icon={ArrowDownLeft}
            label="Revenue"
            value={money(actual.revenue.amount)}
            tone="good"
            href={drillHref(actual.revenue.drill)}
            hint="Income less refunds paid out"
          />
          <StatCard
            icon={ArrowUpRight}
            label="Cost"
            value={money(actual.cost.amount)}
            href={drillHref(actual.cost.drill)}
            hint="Expenses less refunds received"
          />
          <StatCard
            icon={TrendingUp}
            label="Net contribution"
            value={money(net, undefined, { signed: true })}
            tone={net < 0 ? "danger" : "good"}
            href={drillHref(actual.netContribution.drill)}
            hint={actual.margin === null ? "No revenue yet" : `${percentText(actual.margin)} margin`}
          />
          <StatCard
            icon={PiggyBank}
            label="Capital invested"
            value={money(actual.capitalInvested.amount)}
            href={drillHref(actual.capitalInvested.drill)}
            hint={actual.ownerDrawings.amount ? `${money(actual.ownerDrawings.amount)} drawn out` : "Owner equity in"}
          />
        </div>

        {!hasActivity ? (
          <EmptyNote>
            Nothing is tagged with this project yet. Choose it as the project on income and expenses, or set it as an employee's default project.
          </EmptyNote>
        ) : (
          <>
            <Section title="Revenue and cost by month" hint="Last 12 months, whatever the range above">
              <BarsChart
                data={actual.monthly.map((m) => ({
                  label: m.month,
                  revenue: m.revenue,
                  cost: m.cost,
                }))}
                series={[
                  { key: "revenue", label: "Revenue", color: SERIES.primary },
                  { key: "cost", label: "Cost", color: SERIES.secondary },
                ]}
                format={(v) => money(v)}
                axisFormat={compact}
                tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
                labelFormat={(label) => formatMonth(label)}
              />
            </Section>

            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="Where the money went" hint="Cost by group">
                {actual.costByGroup.length ? (
                  <ul className="space-y-1">
                    {actual.costByGroup.map((g) => (
                      <li key={g.group}>
                        <Link href={groupDrillHref(g.drill, g.categoryIds)} className="block rounded-lg px-2 py-1.5 hover:bg-accent/60">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm">{g.label}</span>
                            <span className="shrink-0 text-sm tabular-nums">{money(g.amount)}</span>
                          </span>
                          <span className="mt-1 flex items-center gap-2">
                            <ProgressBar value={g.share ?? 0} className="h-1" />
                            <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{percentText(g.share)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote>No costs in this range.</EmptyNote>
                )}
              </Section>
              <Section title="By category">
                {actual.costByCategory.length ? (
                  <ul className="divide-y divide-border">
                    {actual.costByCategory.map((c) => (
                      <li key={c.categoryId ?? "none"}>
                        <Link href={drillHref(c.drill)} className="flex items-center justify-between gap-3 py-1.5 hover:opacity-80">
                          <span className="min-w-0 truncate text-sm">{c.name}</span>
                          <span className="shrink-0 text-sm tabular-nums">
                            {money(c.amount)} <span className="text-xs text-muted-foreground">{percentText(c.share)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote>No costs in this range.</EmptyNote>
                )}
              </Section>
            </div>
          </>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <Section
            title="Burn"
            hint={
              actual.burn.months.length ? `Average of ${actual.burn.months.map((m) => formatMonth(m, "en-GB", true)).join(", ")}` : "Needs a complete month"
            }
          >
            <div className="grid grid-cols-2 gap-3">
              <Link href={drillHref(actual.burn.monthlyBurn.drill)} className="rounded-lg px-1 hover:bg-accent/40">
                <p className="text-xs text-muted-foreground">Spending a month</p>
                <p className="text-lg font-semibold tabular-nums">{money(actual.burn.monthlyBurn.amount)}</p>
              </Link>
              <Link href={drillHref(actual.burn.netBurn.drill)} className="rounded-lg px-1 hover:bg-accent/40">
                <p className="text-xs text-muted-foreground">Net burn a month</p>
                <p className={cn("text-lg font-semibold tabular-nums", actual.burn.netBurn.amount < 0 && "text-money-in")}>
                  {actual.burn.netBurn.amount < 0 ? `${money(-actual.burn.netBurn.amount)} gained` : money(actual.burn.netBurn.amount)}
                </p>
              </Link>
            </div>
          </Section>
          <Section title="Budget" hint="Lifetime, whatever the range">
            {actual.budget ? (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <Link href={drillHref(actual.budget.spent.drill)} className="text-lg font-semibold tabular-nums hover:underline underline-offset-4">
                    {money(actual.budget.spent.amount)}
                  </Link>
                  <span className="text-xs text-muted-foreground">of {money(actual.budget.amount)}</span>
                </div>
                <ProgressBar
                  value={actual.budget.utilization ?? 0}
                  tone={(actual.budget.utilization ?? 0) > 100 ? "danger" : (actual.budget.utilization ?? 0) > 80 ? "warn" : "good"}
                />
                <p className="text-xs text-muted-foreground">
                  {percentText(actual.budget.utilization)} used ·{" "}
                  {(actual.budget.remaining ?? 0) >= 0 ? `${money(actual.budget.remaining)} left` : `${money(-(actual.budget.remaining ?? 0))} over`}
                </p>
              </div>
            ) : (
              <EmptyNote
                action={
                  canWrite && project ? (
                    <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                      Set a budget
                    </Button>
                  ) : undefined
                }
              >
                No budget set.
              </EmptyNote>
            )}
          </Section>
          <Section title="Open balances" hint="Invoices and bills tagged with the project">
            <div className="grid grid-cols-2 gap-3">
              <Link href={drillHref(actual.receivables.drill)} className="rounded-lg px-1 hover:bg-accent/40">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <HandCoins className="size-3" /> Owed to it
                </p>
                <p className="text-lg font-semibold tabular-nums">{money(actual.receivables.outstanding)}</p>
                <p className={cn("text-xs", actual.receivables.overdueCount ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                  {actual.receivables.overdueCount ? `${money(actual.receivables.overdue)} overdue` : `${actual.receivables.count} open`}
                </p>
              </Link>
              <Link href={drillHref(actual.payables.drill)} className="rounded-lg px-1 hover:bg-accent/40">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Receipt className="size-3" /> It owes
                </p>
                <p className="text-lg font-semibold tabular-nums">{money(actual.payables.outstanding)}</p>
                <p className={cn("text-xs", actual.payables.overdueCount ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                  {actual.payables.overdueCount ? `${money(actual.payables.overdue)} overdue` : `${actual.payables.count} open`}
                </p>
              </Link>
            </div>
          </Section>
        </div>

        <Section title="Top vendors" hint="Who the project paid most, in this range">
          {actual.topVendors.length ? (
            <ul className="divide-y divide-border">
              {actual.topVendors.map((v) => (
                <li key={v.counterpartyId ?? v.name}>
                  <Link href={drillHref(v.drill)} className="flex items-center justify-between gap-3 py-1.5 hover:opacity-80">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{v.name}</span>
                      <span className="text-xs text-muted-foreground">{v.count} payments</span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">{money(v.amount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote>No payments in this range.</EmptyNote>
          )}
        </Section>
      </Band>

      <Band kind="estimated" title="What to expect" hint="Built from the actuals above and scheduled commitments — not money that has moved">
        <div className="grid gap-4 lg:grid-cols-3">
          <Section title="Runway">
            {estimated.runwayMonths !== null ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-2xl font-semibold tabular-nums">
                  <Hourglass className="size-5 text-muted-foreground" /> {estimated.runwayMonths} months
                </p>
                <p className="text-xs text-muted-foreground">{estimated.runwayBasis}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{estimated.runwayUnavailableReason ?? "Not enough information for an estimate."}</p>
            )}
          </Section>
          <Section title="Recurring costs" hint={`${money(estimated.recurringMonthlyCost.amount)} a month`} href="/commitments" linkLabel="Commitments">
            <RecurringList summary={estimated.recurringMonthlyCost} empty="No recurring commitments are tagged with this project." />
          </Section>
          <Section
            title="Expected recurring revenue"
            hint={`${money(estimated.expectedRecurringRevenue.amount)} a month, expected`}
            href="/commitments"
            linkLabel="Commitments"
          >
            <RecurringList summary={estimated.expectedRecurringRevenue} empty="No expected income is scheduled for this project." />
          </Section>
        </div>
      </Band>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard icon={Landmark} label="Lifetime revenue" value={money(actual.lifetime.revenue.amount)} href={drillHref(actual.lifetime.revenue.drill)} />
        <StatCard icon={Flame} label="Lifetime cost" value={money(actual.lifetime.cost.amount)} href={drillHref(actual.lifetime.cost.drill)} />
        <StatCard
          icon={Repeat}
          label="Lifetime net"
          value={money(actual.lifetime.netContribution, undefined, {
            signed: true,
          })}
          tone={actual.lifetime.netContribution < 0 ? "danger" : "good"}
        />
      </div>

      {project && <ProjectFormDialog open={editing} onOpenChange={setEditing} project={project} />}
    </div>
  );
}
