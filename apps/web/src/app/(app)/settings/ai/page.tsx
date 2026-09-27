import { type AgentMemoryItem, monthKey, today } from "@expensewise/core";
import { AiUsageReport } from "@/components/ai/usage-report";
import { AgentMemorySettings } from "@/components/settings/agent-memory";
import { AiSettings } from "@/components/settings/misc-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { api, apiOrNull } from "@/lib/api/server";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { AiStatusView, AiUsageReportView } from "@/lib/api/types/ai";

export const metadata = { title: "AI" };

export default async function Page({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams;
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const currentMonth = monthKey(today(workspace.timezone));
  const wanted = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= currentMonth ? month : currentMonth;
  const [status, usage, memory] = await Promise.all([
    apiOrNull<AiStatusView>("/ai/status").catch(() => null),
    apiOrNull<AiUsageReportView>("/ai/usage", { query: { month: wanted } }).catch(() => null),
    apiOrNull<AgentMemoryItem[]>("/copilot/memory").catch(() => null),
  ]);
  // The settings form takes the budget as a plain number.
  const settingsStatus = status ? { ...status, budget: status.budget.limitUsd } : null;
  return (
    <SettingsPage title="AI" description="AI suggests; the ledger decides. Control what it may do on its own.">
      <AiSettings status={settingsStatus} usage={wanted === currentMonth ? usage : null} />
      <AgentMemorySettings items={memory ?? []} />
      {usage && <AiUsageReport usage={usage} currentMonth={currentMonth} />}
    </SettingsPage>
  );
}
