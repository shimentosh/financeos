import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddInvestmentButton, InvestmentsView } from "@/components/wealth/investments";
import { api } from "@/lib/api/server";
import type { InvestmentList } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Investments" };

const STATUSES = ["active", "closed", "all"];

export default async function InvestmentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: raw } = await searchParams;
  const status = raw && STATUSES.includes(raw) ? raw : "active";
  const list = await api<InvestmentList>("/investments", { query: { status } });
  return (
    <PageShell title="Investments" crumbs={[{ label: "Wealth", href: "/wealth/net-worth" }]} actions={<AddInvestmentButton />} width="wide">
      <InvestmentsView list={list} status={status} />
    </PageShell>
  );
}
