"use client";

import { type AssignableRole, assignableRolesFor, canManageMember, INVITATION_TTL_DAYS, ROLE_DESCRIPTIONS } from "@expensewise/core";
import { Check, Copy, Link2, MailPlus, MoreHorizontal, RotateCw, UserMinus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { SettingsCard } from "@/components/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { initials, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { expiresIn, type InvitationIssued, isPlanLimit, PlanLimitNotice, ROLE_LABELS, type TeamInvitation, type TeamMember, toastTeamError } from "./shared";

async function copy(text: string, label = "Link copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Copy failed: select the link and copy it by hand");
  }
}

/**
 * The people in this workspace: invite by email (owners may add admins,
 * admins add members and viewers), open invitations, and each member's role.
 */
export function TeamMembers({ members, invitations }: { members: TeamMember[]; invitations: TeamInvitation[] | null }) {
  const { workspace, canManage } = useApp();
  const [issued, setIssued] = useState<(InvitationIssued & { resent?: boolean }) | null>(null);

  return (
    <SettingsCard title="Members" description="Admins manage settings and people, members add and edit records, viewers can look but not change anything.">
      {canManage && <InviteForm onIssued={setIssued} />}
      {issued && <IssuedLink issued={issued} onDismiss={() => setIssued(null)} />}

      <ul className="divide-y divide-border">
        {members.map((member) => (
          <MemberRow key={member.id} member={member} />
        ))}
      </ul>

      {canManage && invitations && (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-medium text-muted-foreground">Pending invitations{invitations.length ? ` · ${invitations.length}` : ""}</h3>
          {invitations.length ? (
            <ul className="divide-y divide-border">
              {invitations.map((invitation) => (
                <InvitationRow key={invitation.id} invitation={invitation} onIssued={setIssued} />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              Nobody is waiting to join {workspace.name}. Invite an accountant, a co-founder or a family member above; their invitation shows here until they
              accept.
            </p>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

function InviteForm({ onIssued }: { onIssued: (issued: InvitationIssued) => void }) {
  const { workspace } = useApp();
  const router = useRouter();
  const id = useId();
  const roles = assignableRolesFor(workspace.role);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setLimit(null);
    try {
      const issued = await clientApi<InvitationIssued>("/workspaces/current/invitations", { method: "POST", body: { email: email.trim(), role } });
      onIssued(issued);
      toast.success(issued.emailSent ? `Invitation sent to ${issued.invitation.email}` : `Invitation ready for ${issued.invitation.email}`);
      setEmail("");
      router.refresh();
    } catch (error) {
      if (isPlanLimit(error)) setLimit(error.message);
      else toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor={`${id}-email`}>Invite by email</Label>
          <Input
            id={`${id}-email`}
            type="email"
            required
            autoComplete="off"
            placeholder="accountant@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Select value={role} onValueChange={(v) => typeof v === "string" && setRole(v as AssignableRole)}>
          <SelectTrigger className="w-32" aria-label="Role">
            <SelectValue>{ROLE_LABELS[role]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {roles.map((option) => (
              <SelectItem key={option} value={option}>
                {ROLE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" loading={busy} disabled={!email.includes("@")}>
          <MailPlus className="size-3.5" /> Send invite
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {ROLE_LABELS[role]}: {ROLE_DESCRIPTIONS[role].toLowerCase()} The link works once, for {INVITATION_TTL_DAYS} days, and only for someone signed in with
        this address after verifying it.
        {workspace.role === "admin" ? " Only the owner can add admins." : ""}
      </p>
      {limit && <PlanLimitNotice message={limit} />}
    </form>
  );
}

/** The link of an invitation just sent: shown once, since only its fingerprint is stored. */
function IssuedLink({ issued, onDismiss }: { issued: InvitationIssued & { resent?: boolean }; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert variant={issued.emailSent ? "success" : "info"}>
      <Link2 />
      <AlertTitle>
        {issued.emailSent ? `We emailed an invitation to ${issued.invitation.email}` : `Invitation for ${issued.invitation.email} is ready`}
      </AlertTitle>
      <AlertDescription>
        <span>
          {issued.emailSent
            ? "You can also send them this link yourself. It works once, only for them."
            : "Email isn't set up here, so copy the link and send it to them yourself. It works once, only for them."}
        </span>
        <div className="flex items-center gap-2">
          <Input readOnly value={issued.link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void copy(issued.link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
            <X className="size-3.5" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function MemberRow({ member }: { member: TeamMember }) {
  const { me, workspace, canManage } = useApp();
  const router = useRouter();
  const [role, setRole] = useState(member.role);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isMe = member.userId === me.user.id;
  const manageable = !isMe && canManageMember(workspace.role, member.role);
  const options = assignableRolesFor(workspace.role);

  const changeRole = async (next: AssignableRole) => {
    const previous = role;
    setRole(next);
    setSaving(true);
    try {
      await clientApi(`/workspaces/current/members/${member.id}`, { method: "PATCH", body: { role: next } });
      toast.success(`${member.name} is now ${next === "admin" ? "an" : "a"} ${ROLE_LABELS[next].toLowerCase()}`);
      router.refresh();
    } catch (error) {
      setRole(previous);
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await clientApi(`/workspaces/current/members/${member.id}`, { method: "DELETE" });
      toast.success(`${member.name} was removed from ${workspace.name}`);
      setConfirmRemove(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold",
          member.role === "owner" ? "bg-sky-500/10 text-sky-600 dark:text-sky-400" : "bg-muted text-muted-foreground",
        )}
      >
        {initials(member.name) || "?"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.name}
          {isMe && <span className="font-normal text-muted-foreground"> (you)</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {member.email}
          <span className="max-sm:hidden"> · joined {timeAgo(member.joinedAt)}</span>
          {canManage && !member.emailVerified && <span className="text-amber-600 dark:text-amber-400"> · email not verified</span>}
        </p>
      </div>
      {manageable ? (
        <Select value={role} onValueChange={(v) => typeof v === "string" && v !== role && void changeRole(v as AssignableRole)} disabled={saving}>
          <SelectTrigger size="sm" className="w-28" aria-label={`Role of ${member.name}`}>
            <SelectValue>{ROLE_LABELS[role]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {ROLE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Badge variant={member.role === "owner" ? "info" : "outline"} title={ROLE_DESCRIPTIONS[member.role]}>
          {ROLE_LABELS[member.role]}
        </Badge>
      )}
      {manageable ? (
        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${member.name}`} title="Remove from workspace" onClick={() => setConfirmRemove(true)}>
          <UserMinus className="size-3.5" />
        </Button>
      ) : (
        canManage && <span className="size-8 shrink-0 sm:size-7" aria-hidden />
      )}
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to {workspace.name} right away. Records they added stay in the books. You can invite them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" size="sm" loading={removing} onClick={() => void remove()}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

function InvitationRow({ invitation, onIssued }: { invitation: TeamInvitation; onIssued: (issued: InvitationIssued & { resent?: boolean }) => void }) {
  const { workspace } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const mayManage = assignableRolesFor(workspace.role).includes(invitation.role);

  const resend = async (sendEmail: boolean) => {
    setBusy(true);
    try {
      const issued = await clientApi<InvitationIssued>(`/workspaces/current/invitations/${invitation.id}/resend`, { method: "POST", body: { sendEmail } });
      onIssued({ ...issued, resent: true });
      if (sendEmail) toast.success(issued.emailSent ? `Sent a new invitation to ${invitation.email}` : "New link ready: email isn't set up, copy it below");
      else await copy(issued.link, "New link copied. The earlier link no longer works.");
      router.refresh();
    } catch (error) {
      toastTeamError(error, (href) => router.push(href));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await clientApi(`/workspaces/current/invitations/${invitation.id}`, { method: "DELETE" });
      toast.success(`Invitation for ${invitation.email} withdrawn`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
        <MailPlus className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{invitation.email}</p>
        <p className="truncate text-xs text-muted-foreground">
          {invitation.expired ? (
            <span className="text-amber-600 dark:text-amber-400">Expired · resend to give them a new link</span>
          ) : (
            <>Expires {expiresIn(invitation.expiresAt)}</>
          )}
          {invitation.invitedBy && <span className="max-sm:hidden"> · invited by {invitation.invitedBy.name}</span>}
        </p>
      </div>
      {invitation.expired && <Badge variant="warning">Expired</Badge>}
      <Badge variant="outline">{ROLE_LABELS[invitation.role]}</Badge>
      {mayManage ? (
        <Menu>
          <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${invitation.email}`} loading={busy} />}>
            <MoreHorizontal className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void resend(true)}>
              <RotateCw /> Resend email
            </MenuItem>
            <MenuItem onClick={() => void resend(false)}>
              <Copy /> Copy a new link
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void revoke()}>
              <X /> Withdraw invitation
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <span className="size-8 shrink-0 sm:size-7" aria-hidden />
      )}
    </li>
  );
}
