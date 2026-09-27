import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddReceivableButton, ReceivablesView } from "@/components/wealth/receivables";
import { api } from "@/lib/api/server";
import type { ReceivableList } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Receivables" };

const STATUSES = ["all", "pending", "partially_paid", "overdue", "paid", "cancelled"];

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    focus?: string;
    projectId?: string;
  }>;
}) {
  const { status: raw, focus, projectId } = await searchParams;
  const status = raw && STATUSES.includes(raw) ? raw : "all";
  // Loaded once: the status tabs filter it, the totals cover all of it.
  const list = await api<ReceivableList>("/receivables", {
    query: { projectId },
  });
  return (
    <PageShell title="Receivables" crumbs={[{ label: "Wealth", href: "/wealth/net-worth" }]} actions={<AddReceivableButton />} width="wide">
      <ReceivablesView list={list} status={status} focus={focus} projectFilter={Boolean(projectId)} />
    </PageShell>
  );
}
