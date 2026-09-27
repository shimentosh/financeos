"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { ProgressBar } from "@/components/app/blocks";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { SettingsCard } from "@/components/settings/settings-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AiUsageReportView } from "@/lib/api/types/ai";
import { formatDateTime } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import { FEATURE_LABELS } from "./insights-view";
import { usd } from "./shared";

function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const total = year * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

const STATUS_VARIANT: Record<string, "success" | "error" | "warning" | "secondary"> = {
  ok: "success",
  error: "error",
  refusal: "warning",
  budget: "secondary",
  disabled: "secondary",
};
const tokens = (value: number) => new Intl.NumberFormat("en", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);

/** Every model call this month: cost against the budget, by day, feature and model, and the latest calls. */
export function AiUsageReport({ usage, currentMonth }: { usage: AiUsageReportView; currentMonth: string }) {
  const t = usage.totals;
  const budget = usage.budget;
  const isCurrent = usage.month === currentMonth;
  const daily = usage.daily.map((d) => ({ label: d.date, cost: d.costUsd, calls: d.calls }));

  return (
    <>
      <SettingsCard title="Usage" description="Every model call is recorded, including the ones skipped because AI was off or the budget was used up.">
        <div className="flex items-center justify-between gap-2">
          <Button size="xs" variant="ghost" render={<Link href={`/settings/ai?month=${shiftMonth(usage.month, -1)}`} scroll={false} />}>
            <ChevronLeft className="size-3.5" /> {formatMonth(shiftMonth(usage.month, -1), "en-GB", true)}
          </Button>
          <span className="text-sm font-medium">{formatMonth(usage.month)}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={isCurrent}
            render={isCurrent ? undefined : <Link href={`/settings/ai?month=${shiftMonth(usage.month, 1)}`} scroll={false} />}
          >
            {formatMonth(shiftMonth(usage.month, 1), "en-GB", true)} <ChevronRight className="size-3.5" />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Spent" value={usd(t.costUsd, 2)} hint={budget.limitUsd === null ? "no limit" : `of ${usd(budget.limitUsd, 2)}`} />
          <Metric label="Model calls" value={String(t.providerCalls)} hint={t.blocked ? `${t.blocked} skipped` : `${t.errors + t.refusals} failed`} />
          <Metric
            label="Tokens in / out"
            value={`${tokens(t.inputTokens)} / ${tokens(t.outputTokens)}`}
            hint={t.cacheReadTokens ? `${tokens(t.cacheReadTokens)} from cache` : "no cache hits"}
          />
          <Metric label="Avg. time" value={t.avgLatencyMs === null ? "—" : `${(t.avgLatencyMs / 1000).toFixed(1)} s`} hint="per call" />
        </div>

        {isCurrent && budget.limitUsd !== null && (
          <div className="space-y-1">
            <ProgressBar
              value={budget.percentUsed ?? 0}
              tone={(budget.percentUsed ?? 0) >= 90 ? "danger" : (budget.percentUsed ?? 0) >= 70 ? "warn" : "default"}
            />
            <p className="text-xs text-muted-foreground">
              {usd(budget.remainingUsd ?? 0, 2)} left this month. When it runs out, captures fall back to the built-in parser and manual entry until next month.
            </p>
          </div>
        )}

        {t.calls > 0 ? (
          <BarsChart
            data={daily}
            series={[{ key: "cost", label: "Cost (USD)", color: SERIES.primary }]}
            format={(value) => usd(value)}
            axisFormat={(value) => usd(value, 2)}
            tickFormat={(label) => String(Number(label.slice(8)))}
            labelFormat={(label) => label}
            height={160}
          />
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">No AI calls in {formatMonth(usage.month)}.</p>
        )}
      </SettingsCard>

      {t.calls > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <SettingsCard title="By feature">
            <Breakdown
              rows={usage.byFeature.map((r) => ({ key: r.feature, label: FEATURE_LABELS[r.feature] ?? r.feature, calls: r.calls, cost: r.costUsd }))}
            />
          </SettingsCard>
          <SettingsCard title="By model">
            <Breakdown
              rows={usage.byModel.map((r) => ({
                key: `${r.provider}:${r.model}`,
                label: r.model === "none" ? "No model (skipped)" : r.model,
                calls: r.calls,
                cost: r.costUsd,
              }))}
            />
          </SettingsCard>
        </div>
      )}

      {usage.recent.length > 0 && (
        <SettingsCard title="Latest calls">
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs">
              <thead className="text-muted-foreground">
                <tr className="[&>th]:px-1 [&>th]:pb-1.5 [&>th]:text-left [&>th]:font-medium">
                  <th>When</th>
                  <th>Feature</th>
                  <th>Status</th>
                  <th className="text-right!">Tokens</th>
                  <th className="text-right!">Time</th>
                  <th className="text-right!">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {usage.recent.map((call) => (
                  <tr key={call.id} className="[&>td]:px-1 [&>td]:py-1.5 align-top">
                    <td className="whitespace-nowrap text-muted-foreground">{formatDateTime(call.createdAt)}</td>
                    <td>
                      {FEATURE_LABELS[call.feature] ?? call.feature}
                      {call.error && (
                        <span className="block max-w-56 truncate text-muted-foreground" title={call.error}>
                          {call.error}
                        </span>
                      )}
                    </td>
                    <td>
                      <Badge variant={STATUS_VARIANT[call.status] ?? "secondary"}>{call.status}</Badge>
                    </td>
                    <td className="text-right tabular-nums">
                      {tokens(call.inputTokens)} / {tokens(call.outputTokens)}
                    </td>
                    <td className="text-right tabular-nums">{call.latencyMs === null ? "—" : `${(call.latencyMs / 1000).toFixed(1)} s`}</td>
                    <td className="text-right tabular-nums">{usd(call.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsCard>
      )}
    </>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border px-3 py-2">
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      <p className="truncate text-base font-semibold tabular-nums">{value}</p>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Breakdown({ rows }: { rows: Array<{ key: string; label: string; calls: number; cost: number }> }) {
  const max = Math.max(...rows.map((r) => r.cost), 0);
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((row) => (
        <li key={row.key} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{row.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {row.calls} · {usd(row.cost)}
            </span>
          </div>
          <ProgressBar value={max ? (row.cost / max) * 100 : 0} />
        </li>
      ))}
    </ul>
  );
}
