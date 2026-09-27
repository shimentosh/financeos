import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddGoalButton, GoalsView } from "@/components/planning/goals-view";
import { api } from "@/lib/api/server";
import type { GoalList } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Dream assets" };

export default async function DreamAssetsPage() {
  const list = await api<GoalList>("/goals", { query: { kind: "dream_asset" } });
  return (
    <PageShell
      title="Dream assets"
      crumbs={[{ label: "Goals", href: "/goals" }]}
      actions={<AddGoalButton kind="dream_asset" label="Add dream asset" />}
      width="wide"
    >
      <GoalsView list={list} variant="dream" />
    </PageShell>
  );
}
