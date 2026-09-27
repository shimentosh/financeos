import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { LiabilityDetailView } from "@/components/wealth/liabilities";
import { apiOrNull } from "@/lib/api/server";
import type { LiabilityDetail } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Liability" };

export default async function LiabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const liability = await apiOrNull<LiabilityDetail>(`/liabilities/${id}`);
  if (!liability) notFound();
  return (
    <PageShell
      title={liability.name}
      crumbs={[
        { label: "Wealth", href: "/wealth/net-worth" },
        { label: "Liabilities", href: "/wealth/liabilities" },
      ]}
      backHref="/wealth/liabilities"
      width="wide"
    >
      <LiabilityDetailView liability={liability} />
    </PageShell>
  );
}
