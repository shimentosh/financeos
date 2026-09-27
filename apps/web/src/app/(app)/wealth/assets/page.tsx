import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddAssetButton, AssetsView } from "@/components/wealth/assets";
import { api } from "@/lib/api/server";
import type { AssetList } from "@/lib/api/types/wealth";

export const metadata: Metadata = { title: "Assets" };

const STATUSES = ["owned", "sold", "disposed", "all"];

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: raw } = await searchParams;
  const status = raw && STATUSES.includes(raw) ? raw : "owned";
  const list = await api<AssetList>("/assets", { query: { status } });
  return (
    <PageShell title="Assets" crumbs={[{ label: "Wealth", href: "/wealth/net-worth" }]} actions={<AddAssetButton />} width="wide">
      <AssetsView list={list} status={status} />
    </PageShell>
  );
}
