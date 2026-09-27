import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { InvestmentDetailView } from "@/components/wealth/investments";
import { apiOrNull } from "@/lib/api/server";
import type { InvestmentDetail } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Investment" };

export default async function InvestmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const investment = await apiOrNull<InvestmentDetail>(`/investments/${id}`);
  if (!investment) notFound();
  return (
    <PageShell
      title={investment.name}
      crumbs={[
        { label: "Wealth", href: "/wealth/net-worth" },
        { label: "Investments", href: "/wealth/investments" },
      ]}
      backHref="/wealth/investments"
      width="wide"
    >
      <InvestmentDetailView investment={investment} />
    </PageShell>
  );
}
