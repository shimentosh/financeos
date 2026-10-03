import { presetRange, today } from "@financeos/core";
import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { OverviewView } from "@/components/overview/overview-view";
import type { OverviewData } from "@/components/overview/types";
import { api, apiOrNull } from "@/lib/api/server";
import type { Account, CurrentWorkspace, Me, TransactionPage } from "@/lib/api/types";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const [me, workspace] = await Promise.all([api<Me>("/me"), api<CurrentWorkspace>("/workspaces/current")]);
  const day = today(workspace.timezone);
  const month = presetRange("this_month", day);
  const [overview, accounts, recent, monthTotals] = await Promise.all([
    apiOrNull<OverviewData>("/analytics/overview"),
    api<Account[]>("/accounts"),
    api<TransactionPage>("/transactions", { query: { pageSize: 8 } }),
    api<TransactionPage>("/transactions", { query: { from: month.from, to: month.to, pageSize: 1 } }),
  ]);
  return (
    <PageShell title="Overview" width="wide">
      <OverviewView me={me} workspace={workspace} overview={overview} accounts={accounts} recent={recent} monthTotals={monthTotals.totals} today={day} />
    </PageShell>
  );
}
