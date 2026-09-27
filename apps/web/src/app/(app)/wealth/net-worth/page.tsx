import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { NetWorthView } from "@/components/wealth/net-worth";
import { api } from "@/lib/api/server";
import type { NetWorthCurrent, NetWorthHistory } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Net worth" };

export default async function NetWorthPage() {
  const [current, history] = await Promise.all([api<NetWorthCurrent>("/net-worth"), api<NetWorthHistory>("/net-worth/history", { query: { months: 12 } })]);
  return (
    <PageShell title="Net worth" crumbs={[{ label: "Wealth" }]} width="wide">
      <NetWorthView current={current} history={history} />
    </PageShell>
  );
}
