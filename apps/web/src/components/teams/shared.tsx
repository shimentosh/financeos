"use client";

import type { MemberRole } from "@financeos/core";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError } from "@/lib/api/shared";
import { toast } from "@/lib/toast";

export type TeamMember = {
  id: string;
  role: MemberRole;
  userId: string;
  name: string;
  email: string;
  image?: string | null;
  emailVerified: boolean;
  joinedAt: string;
};

export type TeamInvitation = {
  id: string;
  email: string;
  role: Exclude<MemberRole, "owner">;
  status: "pending" | "expired" | "accepted" | "revoked";
  expired: boolean;
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; name: string } | null;
};

/** GET /invitations/lookup: what the invitation page shows. `viewer` is set when someone is signed in. */
export type InvitationLookup = {
  workspaceName: string;
  workspaceKind: "personal" | "business";
  inviterName: string;
  role: Exclude<MemberRole, "owner">;
  /** Masked: r***@gmail.com. */
  email: string;
  status: "pending" | "expired" | "accepted" | "revoked";
  expired: boolean;
  expiresAt: string;
  viewer: { email: string; emailVerified: boolean; matches: boolean; alreadyMember: boolean; workspaceId: string | null } | null;
};

/** What creating or resending an invitation returns: the link is shown once, to copy. */
export type InvitationIssued = { invitation: TeamInvitation; link: string; emailSent: boolean };

export const ROLE_LABELS: Record<MemberRole, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

/** 402 plan_limit: the plan is full. The caller shows the upgrade path instead of a bare error. */
export function isPlanLimit(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 402 || error.code === "plan_limit");
}

/** An error toast; plan limits get a way to the plans page. */
export function toastTeamError(error: unknown, navigate: (href: string) => void) {
  if (isPlanLimit(error)) {
    toast.error(error.message, { description: "Upgrade your plan to add more.", action: { label: "See plans", onClick: () => navigate("/settings/billing") } });
    return;
  }
  toast.error(error instanceof Error ? error.message : "Something went wrong. Try again.");
}

/** The inline version of a plan-limit error, with the link to lift it. */
export function PlanLimitNotice({ message }: { message: string }) {
  return (
    <Alert variant="warning">
      <AlertTitle>Your plan is full</AlertTitle>
      <AlertDescription>
        <span>
          {message}{" "}
          <Link href="/settings/billing" className="font-medium text-foreground underline underline-offset-4">
            See plans and upgrade
          </Link>
        </span>
      </AlertDescription>
    </Alert>
  );
}

/** "in 6 days", "tomorrow", "today". */
export function expiresIn(iso: string, now = Date.now()) {
  const days = Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}
