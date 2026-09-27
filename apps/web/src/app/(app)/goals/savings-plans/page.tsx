import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddGoalButton, GoalsView } from "@/components/planning/goals-view";
import { api } from "@/lib/api/server";
import type { GoalDetail, GoalList } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Savings plans" };

export default async function SavingsPlansPage() {
  const list = await api<GoalList>("/goals", { query: { savingsPlan: true } });
  // Each plan's month-by-month planned vs actual comes with its detail.
  const details = await Promise.all(list.items.filter((g) => g.status === "active" || g.status === "paused").map((g) => api<GoalDetail>(`/goals/${g.id}`)));
  return (
    <PageShell title="Savings plans" crumbs={[{ label: "Goals", href: "/goals" }]} actions={<AddGoalButton label="Start a savings plan" />} width="wide">
      <GoalsView list={list} variant="savings" details={details} />
    </PageShell>
  );
}
