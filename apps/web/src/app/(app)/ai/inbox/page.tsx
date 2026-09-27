import type { Metadata } from "next";
import { InboxView } from "@/components/ai/inbox-view";
import { PageShell } from "@/components/app/page-shell";
import { api } from "@/lib/api/server";
import type { Category, CurrentWorkspace, Project } from "@/lib/api/types";
import type { AiStatusView, InboxView as InboxData, InboxShow, InboxStatus, UncategorizedView } from "@/lib/api/types/ai";

export const metadata: Metadata = { title: "AI Inbox" };

const SHOWS: InboxShow[] = ["all", "drafts", "uncategorized", "duplicates", "recurring", "anomalies", "integrations", "warnings"];
const STATUSES: InboxStatus[] = ["open", "snoozed", "resolved", "dismissed"];

/** Inbox kinds behind each summary tile. */
const KINDS: Partial<Record<InboxShow, string[]>> = {
  duplicates: ["duplicate"],
  recurring: ["recurring_candidate", "subscription_candidate"],
  anomalies: ["anomaly", "large_transaction"],
  integrations: ["integration_error"],
  warnings: ["budget_warning", "forecast_warning", "price_change", "renewal", "receivable_overdue"],
};

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ show?: string; status?: string }> }) {
  const params = await searchParams;
  const show = SHOWS.includes(params.show as InboxShow) ? (params.show as InboxShow) : "all";
  const status = STATUSES.includes(params.status as InboxStatus) ? (params.status as InboxStatus) : "open";
  const wantsUncategorized = status === "open" && (show === "all" || show === "uncategorized");
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const [inbox, uncategorized, categories, projects, aiStatus] = await Promise.all([
    api<InboxData>("/inbox", { query: { status, kind: KINDS[show], limit: 150 } }),
    // Suggestions from rules, merchant memory and keywords only; the model is asked on request.
    wantsUncategorized ? api<UncategorizedView>("/inbox/uncategorized", { query: { suggest: false, limit: 50 } }).catch(() => null) : Promise.resolve(null),
    api<Category[]>("/categories"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
    api<AiStatusView>("/ai/status").catch(() => null),
  ]);
  return (
    <PageShell title="AI Inbox" width="wide">
      <InboxView inbox={inbox} uncategorized={uncategorized} categories={categories} projects={projects} aiStatus={aiStatus} show={show} status={status} />
    </PageShell>
  );
}
