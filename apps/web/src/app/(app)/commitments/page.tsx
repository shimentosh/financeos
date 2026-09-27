import { addDays, endOfMonth, startOfWeek, today } from "@expensewise/core";
import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { AddCommitmentButton, type CommitmentsTab, CommitmentsView, type CommitmentsViewProps } from "@/components/planning/commitments-view";
import { api } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { AnnualCommitments, CalendarData, CommitmentList, Upcoming } from "@/lib/api/types/planning";

export const metadata: Metadata = { title: "Commitments" };

const TABS: CommitmentsTab[] = ["upcoming", "calendar", "all", "annual"];

export default async function CommitmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = fromSearchParams(await searchParams);
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const day = today(workspace.timezone);
  const tab: CommitmentsTab = TABS.includes(params.tab as CommitmentsTab) ? (params.tab as CommitmentsTab) : "upcoming";
  const filters = { kind: params.kind, direction: params.direction, projectId: params.projectId, categoryId: params.categoryId };
  const props: CommitmentsViewProps = { tab, today: day, filters: params };

  if (tab === "upcoming") {
    const days = ["7", "30", "90"].includes(params.days ?? "") ? Number(params.days) : 30;
    props.upcoming = await api<Upcoming>("/commitments/upcoming", { query: { days, kind: filters.kind, direction: filters.direction } });
  } else if (tab === "calendar") {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month ?? "") ? (params.month as string) : day.slice(0, 7);
    const first = `${month}-01`;
    const from = startOfWeek(first, 1);
    const to = addDays(startOfWeek(endOfMonth(first), 1), 6);
    props.calendar = { month, data: await api<CalendarData>("/commitments/calendar", { query: { from, to, ...filters } }) };
  } else if (tab === "all") {
    const status = params.status === "all" ? undefined : (params.status ?? "active,paused");
    props.all = await api<CommitmentList>("/commitments", {
      query: { status, kind: filters.kind, q: params.q, subscriptions: params.subscriptions ?? "exclude" },
    });
  } else {
    const year = /^\d{4}$/.test(params.year ?? "") ? Number(params.year) : Number(day.slice(0, 4));
    props.annual = await api<AnnualCommitments>("/commitments/annual", { query: { year, kind: filters.kind, direction: filters.direction } });
  }

  return (
    <PageShell title="Commitments" actions={<AddCommitmentButton />} width="wide">
      <CommitmentsView {...props} />
    </PageShell>
  );
}
