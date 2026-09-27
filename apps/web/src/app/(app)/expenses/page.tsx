import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { loadTransactions } from "@/components/transactions/load";
import { TransactionsView } from "@/components/transactions/transactions-view";

export const metadata: Metadata = { title: "Expenses" };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await loadTransactions(searchParams, { tab: "expense", types: "expense,refund" });
  return (
    <PageShell title="Expenses" width="wide">
      <TransactionsView
        {...data}
        lockedTab
        emptyTitle="No spending in this period"
        emptyDescription="Scan a bKash or card screenshot, type “৫০০ টাকার বাজার”, or add an expense by hand."
      />
    </PageShell>
  );
}
