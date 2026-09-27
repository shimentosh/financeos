import type { ReactNode } from "react";
import { AppShell } from "@/components/app/app-shell";
import { OnboardingGate } from "@/components/onboarding/onboarding-gate";
import { api } from "@/lib/api/server";
import type { CurrentWorkspace, Me, TransactionPage } from "@/lib/api/types";

export const dynamic = "force-dynamic";

async function inboxCount(): Promise<number> {
  // The AI Inbox summary when available; drafts awaiting review otherwise.
  try {
    const inbox = await api<{ summary: Record<string, number> }>("/inbox");
    return Object.values(inbox.summary).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  } catch {
    const drafts = await api<TransactionPage>("/transactions", { query: { status: ["draft", "pending"], pageSize: 1 } }).catch(() => null);
    return drafts?.total ?? 0;
  }
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [me, workspace, count] = await Promise.all([api<Me>("/me"), api<CurrentWorkspace>("/workspaces/current"), inboxCount()]);
  // New accounts finish first-run setup first (flag set at sign-up; older accounts never have it).
  if ((me.preferences as { onboarded?: boolean }).onboarded === false) return <OnboardingGate>{children}</OnboardingGate>;
  return (
    <AppShell me={me} workspace={workspace} inboxCount={count}>
      {children}
    </AppShell>
  );
}
