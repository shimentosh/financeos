import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { AssetDetailView } from "@/components/wealth/assets";
import { apiOrNull } from "@/lib/api/server";
import type { AssetDetail } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Asset" };

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = await apiOrNull<AssetDetail>(`/assets/${id}`);
  if (!asset) notFound();
  return (
    <PageShell
      title={asset.name}
      crumbs={[
        { label: "Wealth", href: "/wealth/net-worth" },
        { label: "Assets", href: "/wealth/assets" },
      ]}
      backHref="/wealth/assets"
      width="wide"
    >
      <AssetDetailView asset={asset} />
    </PageShell>
  );
}
