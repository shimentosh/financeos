"use client";

import { formatMoney } from "@expensewise/core";
import { ArrowDownLeft, ArrowUpRight, FileText, Loader2, PiggyBank, Sparkles, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryTile, Delta, EmptyNote, EmptyState, ProgressBar, Section, StatCard } from "@/components/app/blocks";
import { BarsChart, SERIES, TrendChart } from "@/components/charts/charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { formatDay, timeAgo } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import { toast } from "@/lib/toast";
import type { CashFlow, CashFlowPoint, CategoryShare, Compare, Merchant, MonthPoint, ReportSummary } from "./types";

export const TABS = [
  { value: "summary", label: "Summary" },
  { value: "cash-flow", label: "Cash flow" },
  { value: "saved", label: "AI reports" },
] as const;

export const PERIODS = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_quarter", label: "This quarter" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "this_year", label: "This year" },
  { value: "last_12_months", label: "Last 12 months" },
];

function useNav() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    router.push(`${pathname}?${next}`, { scroll: false });
  };
}

export function ReportsTabs({ tab, period }: { tab: string; period: string }) {
  const nav = useNav();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="tablist" className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => nav({ tab: t.value })}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              tab === t.value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab !== "saved" && (
        <Select value={period} onValueChange={(v) => typeof v === "string" && nav({ period: v })}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue>{PERIODS.find((p) => p.value === period)?.label ?? "This month"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <GenerateReportButton />
    </div>
  );
}

export function GenerateReportButton() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const generate = async (kind: "weekly" | "monthly" | "quarterly") => {
    setBusy(kind);
    try {
      const report = await clientApi<{ id: string }>("/reports", { method: "POST", body: { kind, withNarrative: true } });
      router.push(`/reports/${report.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="ms-auto flex gap-1.5">
      {(["weekly", "monthly", "quarterly"] as const).map((kind) => (
        <Button key={kind} size="sm" variant={kind === "monthly" ? "default" : "outline"} disabled={Boolean(busy)} onClick={() => void generate(kind)}>
          {busy === kind ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {kind === "weekly" ? "Weekly brief" : kind === "monthly" ? "Monthly report" : "Quarterly review"}
        </Button>
      ))}
    </div>
  );
}

export function SummaryView({
  compare,
  categories,
  incomeCategories,
  merchants,
  monthly,
}: {
  compare: Compare;
  categories: CategoryShare[];
  incomeCategories: CategoryShare[];
  merchants: Merchant[];
  monthly: MonthPoint[];
}) {
  const { money, isBusiness, locale, workspace } = useApp();
  const compact = (v: number) => formatMoney(v, workspace.baseCurrency, { locale, compact: true });
  const { current } = compare;
  const range = compare.range;
  const q = `from=${range.from}&to=${range.to}`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {formatDay(range.from)} – {formatDay(range.to)}, compared with {formatDay(compare.previousRange.from)} – {formatDay(compare.previousRange.to)}. Actual,
        posted figures only.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={ArrowDownLeft}
          label={isBusiness ? "Revenue" : "Income"}
          value={money(current.income)}
          hint={<Delta value={compare.incomeChangePct} />}
          href={`/transactions?${q}&type=income`}
        />
        <StatCard
          icon={ArrowUpRight}
          label="Spending"
          value={money(current.expenses)}
          hint={<Delta value={compare.expenseChangePct} goodWhen="down" />}
          href={`/transactions?${q}&type=expense,refund`}
        />
        <StatCard
          icon={TrendingUp}
          label="Net"
          value={money(current.net, undefined, { signed: true })}
          hint={<Delta value={compare.netChangePct} />}
          tone={current.net < 0 ? "danger" : "good"}
        />
        <StatCard
          icon={PiggyBank}
          label={isBusiness ? "Net margin" : "Savings rate"}
          value={current.rate === null ? "—" : `${current.rate}%`}
          hint={`Previous: ${compare.previous.rate === null ? "—" : `${compare.previous.rate}%`}`}
        />
      </div>
      <Section title={isBusiness ? "Revenue and costs by month" : "Income and spending by month"} hint="Last 12 months">
        <BarsChart
          data={monthly.map((m) => ({ label: m.month, income: m.income, expenses: m.expenses }))}
          series={[
            { key: "income", label: isBusiness ? "Revenue" : "Income", color: SERIES.primary },
            { key: "expenses", label: isBusiness ? "Costs" : "Spending", color: SERIES.secondary },
          ]}
          format={(v) => money(v)}
          axisFormat={compact}
          tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
          labelFormat={(label) => formatMonth(label)}
        />
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Spending by category" hint="Subcategories roll up into their parent">
          <ShareList rows={categories} />
        </Section>
        <div className="space-y-4">
          <Section title={isBusiness ? "Revenue by category" : "Income by category"}>
            <ShareList rows={incomeCategories} />
          </Section>
          <Section title="Where it went" hint="Top merchants and payees">
            {merchants.length ? (
              <ul className="divide-y divide-border">
                {merchants.map((m) => (
                  <li key={m.name}>
                    <Link href={m.href} className="flex items-center justify-between gap-3 py-2 hover:opacity-80">
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{m.name}</span>
                        <span className="text-xs text-muted-foreground">{m.count} payments</span>
                      </span>
                      <span className="shrink-0 text-sm tabular-nums">{money(m.amount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote>No payments in this period.</EmptyNote>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function ShareList({ rows }: { rows: CategoryShare[] }) {
  const { money } = useApp();
  if (!rows.length) return <EmptyNote>Nothing recorded in this period.</EmptyNote>;
  return (
    <ul className="space-y-1">
      {rows.map((row) => (
        <li key={row.categoryId ?? "none"}>
          <Link href={row.href} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/60">
            <CategoryTile icon={row.icon} color={row.color} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm">{row.name}</span>
                <span className="shrink-0 text-sm tabular-nums">{money(row.amount)}</span>
              </span>
              <span className="mt-1 flex items-center gap-2">
                <ProgressBar value={row.share} className="h-1" />
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{row.share}%</span>
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CashFlowView({ flow, series }: { flow: CashFlow; series: CashFlowPoint[] }) {
  const { money, workspace, locale } = useApp();
  const compact = (v: number) => formatMoney(v, workspace.baseCurrency, { locale, compact: true });
  const s = flow.statement;
  const q = `from=${flow.range.from}&to=${flow.range.to}`;
  const rows: Array<{ label: string; value: number; href?: string; muted?: boolean }> = [
    { label: "Opening cash", value: s.opening, muted: true },
    { label: "+ Income", value: s.income, href: `/transactions?${q}&type=income` },
    { label: "− Expenses", value: -s.expenses, href: `/transactions?${q}&type=expense` },
    { label: "± Refunds", value: s.refunds, href: `/transactions?${q}&type=refund` },
    { label: "− Debt payments", value: -s.debtPayments, href: `/transactions?${q}&type=debt_payment` },
    { label: "+ Repayments received", value: s.collections, href: `/transactions?${q}&type=debt_payment` },
    { label: "+ Borrowed", value: s.borrowing, href: `/transactions?${q}&type=loan` },
    { label: "− Lent", value: -s.lending, href: `/transactions?${q}&type=loan` },
    { label: "± Investments & assets", value: s.investing, href: `/transactions?${q}&type=investment,asset_purchase` },
    { label: "± Owner equity", value: s.equity, href: `/transactions?${q}&type=equity` },
    { label: "± Transfers out of these accounts", value: s.transfersIn - s.transfersOut, href: `/transactions?${q}&type=transfer` },
    { label: "± Adjustments", value: s.adjustments, href: `/transactions?${q}&type=adjustment` },
  ].filter((row) => row.muted || row.value !== 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section
          title="Cash flow statement"
          hint={`${formatDay(flow.range.from)} – ${formatDay(flow.range.to)} · actual · ${flow.accounts.length} cash accounts`}
        >
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className={cn("py-1.5", row.muted && "text-muted-foreground")}>
                    {row.href ? (
                      <Link href={row.href} className="hover:underline underline-offset-4">
                        {row.label}
                      </Link>
                    ) : (
                      row.label
                    )}
                  </td>
                  <td className={cn("py-1.5 text-right tabular-nums", row.value > 0 && !row.muted && "text-money-in")}>
                    {money(row.value, undefined, { signed: !row.muted })}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2">Closing cash</td>
                <td className="py-2 text-right tabular-nums">{money(s.closing)}</td>
              </tr>
            </tbody>
          </table>
          {flow.fxDifference !== 0 && (
            <p className="text-xs text-muted-foreground">
              Exchange-rate movements on foreign balances: {money(flow.fxDifference, undefined, { signed: true })}.
            </p>
          )}
          {flow.unconvertedAccounts > 0 && (
            <p className="text-xs text-amber-600">{flow.unconvertedAccounts} accounts have no exchange rate and are left out.</p>
          )}
        </Section>
        <div className="space-y-4">
          <Section title="Money in and out" hint="Per month, transfers between your accounts excluded">
            <BarsChart
              data={series.map((p) => ({ label: p.month, moneyIn: p.moneyIn, moneyOut: p.moneyOut }))}
              series={[
                { key: "moneyIn", label: "In", color: SERIES.primary },
                { key: "moneyOut", label: "Out", color: SERIES.secondary },
              ]}
              format={(v) => money(v)}
              axisFormat={compact}
              tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
              labelFormat={(label) => formatMonth(label)}
              height={180}
            />
          </Section>
          <Section title="Cash at month end">
            <TrendChart
              data={series.map((p) => ({ label: p.month, closing: p.closing }))}
              series={[{ key: "closing", label: "Closing cash", color: SERIES.primary }]}
              format={(v) => money(v)}
              axisFormat={compact}
              tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
              labelFormat={(label) => formatMonth(label)}
              height={160}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

export function SavedReports({ reports }: { reports: ReportSummary[] }) {
  if (!reports.length) {
    return (
      <EmptyState
        icon={FileText}
        title="No reports yet"
        description="Generate a weekly brief, monthly report or quarterly review. Numbers come from your ledger; the summary only restates them. Weekly and monthly reports are also created automatically."
        action={<GenerateReportButton />}
      />
    );
  }
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {reports.map((report) => (
        <li key={report.id}>
          <Link href={`/reports/${report.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/40">
            <FileText className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{report.title}</span>
              <span className="text-xs text-muted-foreground">
                {formatDay(report.periodStart)} – {formatDay(report.periodEnd)} · generated {timeAgo(report.createdAt)}
              </span>
            </span>
            <Badge variant={report.narrativeSource === "ai" ? "info" : "outline"}>{report.narrativeSource === "ai" ? "AI summary" : "Template"}</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
