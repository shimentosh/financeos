import { type PeriodPreset, presetRange, today } from "@financeos/core";
import { Suspense } from "react";
import { PageShell } from "@/components/app/page-shell";
import { CashFlowView, ReportsTabs, SavedReports, SummaryView } from "@/components/reports/reports-view";
import type { CashFlow, CashFlowPoint, CategoryShare, Compare, Merchant, MonthPoint, ReportSummary } from "@/components/reports/types";
import { api } from "@/lib/api/server";
import type { CurrentWorkspace } from "@/lib/api/types";

export const metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string; period?: string }> }) {
  const { tab = "summary", period = "this_month" } = await searchParams;
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const range = presetRange(period as PeriodPreset, today(workspace.timezone), workspace.fiscalYearStartMonth);
  const query = { from: range.from, to: range.to };

  let body: React.ReactNode;
  if (tab === "cash-flow") {
    const [flow, series] = await Promise.all([
      api<CashFlow>("/analytics/cash-flow", { query }),
      api<CashFlowPoint[]>("/analytics/cash-flow/series", { query: { months: 12 } }),
    ]);
    body = <CashFlowView flow={flow} series={series} />;
  } else if (tab === "saved") {
    body = <SavedReports reports={await api<ReportSummary[]>("/reports")} />;
  } else {
    const [compare, categories, incomeCategories, merchants, monthly] = await Promise.all([
      api<Compare>("/analytics/summary", { query }),
      api<CategoryShare[]>("/analytics/categories", { query: { ...query, kind: "expense" } }),
      api<CategoryShare[]>("/analytics/categories", { query: { ...query, kind: "income" } }),
      api<Merchant[]>("/analytics/merchants", { query }),
      api<MonthPoint[]>("/analytics/monthly", { query: { months: 12 } }),
    ]);
    body = <SummaryView compare={compare} categories={categories} incomeCategories={incomeCategories} merchants={merchants} monthly={monthly} />;
  }

  return (
    <PageShell title={workspace.kind === "business" ? "Business reports" : "Reports"} width="wide">
      <Suspense>
        <ReportsTabs tab={tab} period={period} />
      </Suspense>
      {body}
    </PageShell>
  );
}
