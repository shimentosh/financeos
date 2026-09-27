import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { loadTransactions } from "@/components/transactions/load";
import { TransactionsView } from "@/components/transactions/transactions-view";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await loadTransactions(searchParams, { tab: "transfer", types: "transfer" });
  return (
    <PageShell title="Transfers" width="wide">
      <TransactionsView
        {...data}
        lockedTab
        emptyTitle="No transfers in this period"
        emptyDescription="Moving money between your own accounts — bank to bKash, a cash-out — is a transfer, never an expense."
      />
    </PageShell>
  );
}
