import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { SyncHistoryView } from "@/components/integrations/sync-history-view";
import { api } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { Account } from "@/lib/api/types";
import type { Connection, Page, RunSummary } from "@/lib/api/types/integrations";

export const metadata: Metadata = { title: "Sync history" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SyncHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = fromSearchParams(await searchParams);
  const filters = {
    connectionId: query.connectionId && UUID.test(query.connectionId) ? query.connectionId : undefined,
    status: query.status?.replace(/[^a-z,]/g, "") || undefined,
    trigger: query.trigger?.replace(/[^a-z,]/g, "") || undefined,
    from: query.from && DAY.test(query.from) ? query.from : undefined,
    to: query.to && DAY.test(query.to) ? query.to : undefined,
    runId: query.runId && UUID.test(query.runId) ? query.runId : undefined,
  };
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const [runs, connections, accounts] = await Promise.all([
    api<Page<RunSummary>>("/sync-runs", {
      query: { connectionId: filters.connectionId, status: filters.status, trigger: filters.trigger, from: filters.from, to: filters.to, page, pageSize: 50 },
    }),
    api<Connection[]>("/integrations"),
    api<Account[]>("/accounts"),
  ]);
  return (
    <PageShell frame="settings" title="Sync history" crumbs={[{ label: "Integrations", href: "/integrations" }]} width="wide">
      <SyncHistoryView runs={runs} connections={connections} accounts={accounts} filters={filters} />
    </PageShell>
  );
}
