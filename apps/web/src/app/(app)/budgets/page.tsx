import { isDay, today } from "@financeos/core";
import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddBudgetButton, BudgetsView } from "@/components/planning/budgets-view";
import { api } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { BudgetList } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Budgets" };

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = fromSearchParams(await searchParams);
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const list = await api<BudgetList>("/budgets", { query: { date: isDay(params.date) ? params.date : undefined } });
  return (
    <PageShell title="Budgets" actions={<AddBudgetButton />} width="wide">
      <BudgetsView list={list} today={today(workspace.timezone)} />
    </PageShell>
  );
}
