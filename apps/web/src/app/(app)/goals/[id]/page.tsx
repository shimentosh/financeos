import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { GoalDetailView } from "@/components/planning/goal-detail";
import { apiOrNull } from "@/lib/api/server";
import type { GoalDetail } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Goal" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const goal = await apiOrNull<GoalDetail>(`/goals/${id}`);
  if (!goal) notFound();
  const parent =
    goal.kind === "dream_asset"
      ? { label: "Dream assets", href: "/goals/dream-assets" }
      : goal.isSavingsPlan
        ? { label: "Savings plans", href: "/goals/savings-plans" }
        : { label: "Goals", href: "/goals" };
  return (
    <PageShell title={goal.name} crumbs={[parent]} backHref={parent.href} width="wide">
      <GoalDetailView goal={goal} />
    </PageShell>
  );
}
