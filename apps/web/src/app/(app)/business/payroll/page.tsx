import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { PayrollUnavailable, PayrollView } from "@/components/business/payroll";
import { api, apiOrNull } from "@/lib/api/server";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { EmployeeList, PayrollRun, PayrollRunDetail } from "@/lib/api/types/business";

export const metadata: Metadata = { title: "Payroll" };

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ tab?: string; run?: string }> }) {
  const [{ tab: rawTab, run: runId }, workspace] = await Promise.all([searchParams, api<CurrentWorkspace>("/workspaces/current")]);
  if (workspace.kind !== "business") {
    return (
      <PageShell title="Payroll">
        <PayrollUnavailable />
      </PageShell>
    );
  }
  const tab = rawTab === "runs" || runId ? "runs" : "employees";
  const [employees, runs] = await Promise.all([api<EmployeeList>("/payroll/employees"), api<PayrollRun[]>("/payroll/runs")]);
  // The runs tab opens the chosen run, or the latest one.
  const selectedId = tab === "runs" ? (runId ?? runs[0]?.id) : undefined;
  const run = selectedId ? await apiOrNull<PayrollRunDetail>(`/payroll/runs/${selectedId}`) : null;
  return (
    <PageShell title="Payroll" crumbs={[{ label: "Business" }]} width="wide">
      <PayrollView tab={tab} employees={employees} runs={runs} run={run} />
    </PageShell>
  );
}
