import { today } from "@financeos/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { AddSubscriptionButton, SubscriptionsView } from "@/components/planning/subscriptions-view";
import { api } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { SubscriptionAnalytics, SubscriptionList } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Subscriptions" };

export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = fromSearchParams(await searchParams);
  // Notifications and other pages link here with a subscription or commitment id.
  if (params.focus) {
    const all = await api<SubscriptionList>("/subscriptions");
    const match = all.items.find((s) => s.id === params.focus || s.commitmentId === params.focus);
    if (match) redirect(`/subscriptions/${match.id}`);
  }
  const filters = { q: params.q, status: params.status, billingCycle: params.billingCycle, sort: params.sort };
  const [list, analytics, workspace] = await Promise.all([
    api<SubscriptionList>("/subscriptions", { query: filters }),
    api<SubscriptionAnalytics>("/subscriptions/analytics"),
    api<CurrentWorkspace>("/workspaces/current"),
  ]);
  return (
    <PageShell title="Subscriptions" actions={<AddSubscriptionButton />} width="wide">
      <SubscriptionsView list={list} analytics={analytics} filters={filters} today={today(workspace.timezone)} />
    </PageShell>
  );
}
