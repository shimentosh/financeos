import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddLiabilityButton, LiabilitiesView } from "@/components/wealth/liabilities";
import { api } from "@/lib/api/server";
import type { LiabilityList, PayableList } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Liabilities" };

const STATUSES = ["active", "paid_off", "overdue", "cancelled"];

export default async function LiabilitiesPage({ searchParams }: { searchParams: Promise<{ view?: string; status?: string; projectId?: string }> }) {
  const { view: rawView, status: rawStatus, projectId } = await searchParams;
  const view = rawView === "payables" ? "payables" : "all";
  const status = rawStatus && STATUSES.includes(rawStatus) ? rawStatus : undefined;
  // Both lists: the payables tab pays through the liability, and the summary
  // cards on either tab show the other's total.
  const [list, payables] = await Promise.all([
    api<LiabilityList>("/liabilities", {
      query: { status: view === "all" ? status : undefined, projectId },
    }),
    api<PayableList>("/payables", {
      query: { status: view === "payables" ? status : undefined, projectId },
    }),
  ]);
  return (
    <PageShell
      title={view === "payables" ? "Payables" : "Liabilities"}
      crumbs={[{ label: "Wealth", href: "/wealth/net-worth" }]}
      actions={<AddLiabilityButton />}
      width="wide"
    >
      <LiabilitiesView list={list} payables={payables} view={view} status={status} projectFilter={Boolean(projectId)} />
    </PageShell>
  );
}
