import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { loadTransactions } from "@/components/transactions/load";
import { TransactionsView } from "@/components/transactions/transactions-view";

export const metadata: Metadata = { title: "Income" };

export default async function IncomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await loadTransactions(searchParams, { tab: "income", types: "income" });
  const business = data.workspace.kind === "business";
  return (
    <PageShell title={business ? "Income & revenue" : "Income"} width="wide">
      <TransactionsView
        {...data}
        lockedTab
        emptyTitle="No income recorded in this period"
        emptyDescription={
          business
            ? "Record a payment from a client, or connect Stripe or your own app to import revenue."
            : "Record your salary or freelance income, or scan a bank credit alert."
        }
      />
    </PageShell>
  );
}
