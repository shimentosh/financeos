import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { presetFrom } from "@/components/business/presets";
import { RevenueView } from "@/components/business/revenue";
import { api } from "@/lib/api/server";
import type { RevenueAnalytics } from "@/lib/api/types/business";

export const metadata: Metadata = { title: "Revenue" };

export default async function RevenuePage({ searchParams }: { searchParams: Promise<{ preset?: string }> }) {
  const { preset: raw } = await searchParams;
  const preset = presetFrom(raw, "last_12_months");
  const data = await api<RevenueAnalytics>("/revenue", { query: { preset } });
  return (
    <PageShell title="Revenue" crumbs={[{ label: "Business" }]} width="wide">
      <RevenueView data={data} preset={preset} />
    </PageShell>
  );
}
