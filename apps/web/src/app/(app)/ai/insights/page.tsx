import { addDays, diffDays, endOfMonth, minDay, startOfMonth, today } from "@financeos/core";
import type { Metadata } from "next";
import { InsightsView } from "@/components/ai/insights-view";
import { PageShell } from "@/components/app/page-shell";
import type { CategoryShare, Compare, MonthPoint } from "@/components/reports/types";
import { api } from "@/lib/api/server";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { AiStatusView, AiUsageReportView, InboxView } from "@/lib/api/types/ai";
import type { SubscriptionAnalytics } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Insights" };

export default async function InsightsPage() {
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const day = today(workspace.timezone);
  // This month so far against the same number of days last month: a fair comparison mid-month.
  const current = { from: startOfMonth(day), to: day };
  const lastStart = startOfMonth(addDays(current.from, -1));
  const previous = { from: lastStart, to: minDay(addDays(lastStart, diffDays(current.from, day)), endOfMonth(lastStart)) };
  const manages = workspace.role === "owner" || workspace.role === "admin";

  const [now, before, categoriesNow, categoriesBefore, monthly, anomalies, recurring, subscriptions, usage, aiStatus] = await Promise.all([
    api<Compare>("/analytics/summary", { query: current }),
    api<Compare>("/analytics/summary", { query: previous }),
    api<CategoryShare[]>("/analytics/categories", { query: { ...current, kind: "expense" } }),
    api<CategoryShare[]>("/analytics/categories", { query: { ...previous, kind: "expense" } }),
    api<MonthPoint[]>("/analytics/monthly", { query: { months: 6 } }),
    api<InboxView>("/inbox", { query: { kind: ["anomaly", "large_transaction"], status: "open", limit: 6 } }).catch(() => null),
    api<InboxView>("/inbox", { query: { kind: ["recurring_candidate", "subscription_candidate"], status: "open", limit: 6 } }).catch(() => null),
    api<SubscriptionAnalytics>("/subscriptions/analytics").catch(() => null),
    manages ? api<AiUsageReportView>("/ai/usage").catch(() => null) : Promise.resolve(null),
    manages ? api<AiStatusView>("/ai/status").catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <PageShell title="Insights" width="wide">
      <InsightsView
        current={{ range: current, statement: now.current, categories: categoriesNow }}
        previous={{ range: previous, statement: before.current, categories: categoriesBefore }}
        monthly={monthly}
        anomalies={anomalies?.items ?? []}
        recurring={recurring?.items ?? []}
        subscriptions={subscriptions}
        usage={usage}
        aiStatus={aiStatus}
        today={day}
      />
    </PageShell>
  );
}
