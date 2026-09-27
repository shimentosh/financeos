import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { SubscriptionDetailView } from "@/components/planning/subscription-detail";
import { apiOrNull } from "@/lib/api/server";
import type { SubscriptionDetail } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Subscription" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const subscription = await apiOrNull<SubscriptionDetail>(`/subscriptions/${id}`);
  if (!subscription) notFound();
  return (
    <PageShell title={subscription.name} crumbs={[{ label: "Subscriptions", href: "/subscriptions" }]} backHref="/subscriptions" width="wide">
      <SubscriptionDetailView subscription={subscription} />
    </PageShell>
  );
}
