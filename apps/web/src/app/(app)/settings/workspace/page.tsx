import { Suspense } from "react";
import { SettingsPage } from "@/components/settings/settings-page";
import { WorkspaceSettings } from "@/components/settings/workspace-settings";
import type { TeamInvitation, TeamMember } from "@/components/teams/shared";
import { api } from "@/lib/api/server";
import type { CurrentWorkspace } from "@/lib/api/types";

export const metadata = { title: "Workspace" };

export default async function Page() {
  const [members, workspace] = await Promise.all([api<TeamMember[]>("/workspaces/current/members"), api<CurrentWorkspace>("/workspaces/current")]);
  // Invitations carry addresses and links: only owners and admins see them.
  const canManage = workspace.role === "owner" || workspace.role === "admin";
  const invitations = canManage ? await api<TeamInvitation[]>("/workspaces/current/invitations") : null;
  return (
    <SettingsPage
      title="Workspace & members"
      description="Personal and business books stay separate: each workspace has its own accounts, categories, reports and people."
    >
      <Suspense>
        <WorkspaceSettings members={members} invitations={invitations} />
      </Suspense>
    </SettingsPage>
  );
}
