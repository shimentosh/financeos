import { isDay } from "@financeos/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { BudgetDetailView } from "@/components/planning/budget-detail";
import { apiOrNull } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { BudgetDetail } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Budget" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = fromSearchParams(await searchParams);
  const periods = query.periods === "12" ? 12 : 6;
  const budget = await apiOrNull<BudgetDetail>(`/budgets/${id}`, { query: { date: isDay(query.date) ? query.date : undefined, periods } });
  if (!budget) notFound();
  return (
    <PageShell title={budget.name} crumbs={[{ label: "Budgets", href: "/budgets" }]} backHref="/budgets" width="wide">
      <BudgetDetailView budget={budget} periods={periods} />
    </PageShell>
  );
}
