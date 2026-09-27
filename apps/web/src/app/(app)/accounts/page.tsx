import type { Metadata } from "next";
import { AccountsView, AddAccountButton } from "@/components/accounts/accounts-view";
import { PageShell } from "@/components/app/page-shell";
import { api } from "@/lib/api/server";
import type { Account } from "@/lib/api/types";

export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { archived } = await searchParams;
  const accounts = await api<Account[]>("/accounts", { query: { includeArchived: archived === "1" } });
  return (
    <PageShell title="Accounts" actions={<AddAccountButton />}>
      <AccountsView accounts={accounts} />
    </PageShell>
  );
}
