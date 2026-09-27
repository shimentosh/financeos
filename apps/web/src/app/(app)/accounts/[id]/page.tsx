import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountHeader } from "@/components/accounts/account-detail";
import { PageShell } from "@/components/app/page-shell";
import { loadTransactions } from "@/components/transactions/load";
import { TransactionsView } from "@/components/transactions/transactions-view";
import { apiOrNull } from "@/lib/api/server";
import type { AccountDetail } from "@/lib/api/types";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const account = await apiOrNull<AccountDetail>(`/accounts/${id}`);
  if (!account) notFound();
  const data = await loadTransactions(searchParams.then((sp) => ({ period: "last_90_days", ...sp, accountId: id })));
  return (
    <PageShell title={account.name} crumbs={[{ label: "Accounts", href: "/accounts" }]} backHref="/accounts" width="wide">
      <AccountHeader account={account} />
      <TransactionsView {...data} />
    </PageShell>
  );
}
