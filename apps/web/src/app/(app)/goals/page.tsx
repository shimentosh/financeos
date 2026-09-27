import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { AddGoalButton, GoalsView } from "@/components/planning/goals-view";
import { api } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { GoalList } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Financial goals" };

export default async function GoalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = fromSearchParams(await searchParams);
  if (params.focus && /^[0-9a-f-]{36}$/i.test(params.focus)) redirect(`/goals/${params.focus}`);
  const list = await api<GoalList>("/goals");
  return (
    <PageShell title="Financial goals" crumbs={[{ label: "Goals" }]} actions={<AddGoalButton />} width="wide">
      <GoalsView list={list} variant="all" />
    </PageShell>
  );
}
