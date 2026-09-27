"use client";

import { Crown, LogOut, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { clientApi, errorMessage } from "@/lib/api/client";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { isPlanLimit, PlanLimitNotice, ROLE_LABELS, type TeamMember } from "./shared";

/** After leaving or deleting a workspace: a full reload into whichever workspace the API made active. */
function reloadIntoApp() {
  invalidateApiCache();
  window.location.assign("/");
}

/**
 * The irreversible part of workspace settings. Owners can hand the workspace
 * over or delete it; everyone else can leave. Nobody can leave or delete their
 * only workspace.
 */
export function WorkspaceDangerZone({ members }: { members: TeamMember[] }) {
  const { me, workspace } = useApp();
  const isOwner = workspace.role === "owner";
  const onlyWorkspace = me.workspaces.length <= 1;
  const [dialog, setDialog] = useState<"leave" | "transfer" | "delete" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);

  return (
    <section className="rounded-xl border border-destructive/30 bg-card">
      <div className="space-y-1 p-4 pb-2">
        <h2 className="text-sm font-semibold">Danger zone</h2>
        <p className="text-xs text-muted-foreground">
          {isOwner ? "Hand this workspace to someone else, or delete it for good." : "Stop being part of this workspace."}
        </p>
      </div>
      <div className="divide-y divide-border px-4">
        {isOwner ? (
          <>
            <DangerRow
              icon={<Crown className="size-3.5" />}
              title="Transfer ownership"
              description="Make another member the owner. Their plan covers the workspace from then on, and you stay as an admin."
              action={
                <Button size="sm" variant="outline" onClick={() => setDialog("transfer")}>
                  Transfer
                </Button>
              }
            />
            <DangerRow
              icon={<Trash2 className="size-3.5" />}
              title="Delete workspace"
              description={
                onlyWorkspace
                  ? "This is your only workspace, so it can't be deleted. Create another one first, or delete your account instead."
                  : `Deletes ${workspace.name} with every account, transaction, file and report in it, for everyone. This can't be undone.`
              }
              action={
                <Button size="sm" variant="destructive-outline" disabled={onlyWorkspace} onClick={() => setDialog("delete")}>
                  Delete
                </Button>
              }
            />
          </>
        ) : (
          <DangerRow
            icon={<LogOut className="size-3.5" />}
            title="Leave workspace"
            description={
              onlyWorkspace
                ? "This is your only workspace, so you can't leave it. Create another one first."
                : `You lose access to ${workspace.name}. Records you added stay. An owner or admin can invite you back.`
            }
            action={
              <Button size="sm" variant="destructive-outline" disabled={onlyWorkspace} onClick={() => setDialog("leave")}>
                Leave
              </Button>
            }
          />
        )}
      </div>
      <div className="h-2" />
      <LeaveDialog open={dialog === "leave"} onOpenChange={close} />
      {isOwner && <TransferDialog open={dialog === "transfer"} onOpenChange={close} members={members} />}
      {isOwner && <DeleteDialog open={dialog === "delete"} onOpenChange={close} />}
    </section>
  );
}

function DangerRow({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function LeaveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace } = useApp();
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    setBusy(true);
    try {
      await clientApi("/workspaces/current/leave", { method: "POST", body: {} });
      toast.success(`You left ${workspace.name}`);
      reloadIntoApp();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave {workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>You lose access right away. To come back, an owner or admin has to invite you again.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" size="sm" loading={busy} onClick={() => void leave()}>
            Leave workspace
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function TransferDialog({ open, onOpenChange, members }: { open: boolean; onOpenChange: (open: boolean) => void; members: TeamMember[] }) {
  const { me, workspace } = useApp();
  const router = useRouter();
  const others = members.filter((member) => member.userId !== me.user.id);
  const eligible = others.filter((member) => member.emailVerified);
  const unverified = others.length - eligible.length;
  const [userId, setUserId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<string | null>(null);
  const target = eligible.find((member) => member.userId === userId);

  const transfer = async () => {
    if (!target) return;
    setBusy(true);
    setLimit(null);
    try {
      await clientApi("/workspaces/current/transfer", { method: "POST", body: { userId: target.userId } });
      toast.success(`${target.name} now owns ${workspace.name}. You're an admin.`);
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      if (isPlanLimit(error)) setLimit(`${target.name}'s plan has no room for another workspace. ${error.message}`);
      else toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer ownership</DialogTitle>
          <DialogDescription>
            The new owner can manage the plan, members and delete the workspace. You stay as an admin; only they can hand it back.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {eligible.length ? (
            <div className="space-y-1">
              <Label>New owner</Label>
              <Select value={userId} onValueChange={(v) => typeof v === "string" && setUserId(v)}>
                <SelectTrigger>
                  <SelectValue>{target ? `${target.name} (${target.email})` : "Choose a member"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.name} · {ROLE_LABELS[member.role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              {others.length
                ? "Nobody here can own the workspace yet: the new owner must have verified their email address."
                : "You're the only member. Invite the person who should own it first; once they've joined, you can hand it over."}
            </p>
          )}
          {eligible.length > 0 && unverified > 0 && (
            <p className="text-xs text-muted-foreground">
              {unverified === 1 ? "One member isn't" : `${unverified} members aren't`} listed because they haven't verified their email address yet.
            </p>
          )}
          {limit && <PlanLimitNotice message={limit} />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} disabled={!target} onClick={() => void transfer()}>
            Transfer ownership
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace } = useApp();
  const id = useId();
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = confirmName.trim() === workspace.name.trim();

  const remove = async () => {
    setBusy(true);
    try {
      await clientApi("/workspaces/current", { method: "DELETE", body: { confirmName: confirmName.trim() } });
      toast.success(`${workspace.name} was deleted`);
      reloadIntoApp();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirmName("");
        onOpenChange(next);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every account, transaction, attachment, budget and report in this workspace is deleted for all its members. This can't be undone. Export anything
            you want to keep first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1 px-6 pb-4">
          <Label htmlFor={`${id}-confirm`}>
            Type <span className="font-semibold">{workspace.name}</span> to confirm
          </Label>
          <Input id={`${id}-confirm`} autoComplete="off" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" size="sm" loading={busy} disabled={!matches} onClick={() => void remove()}>
            Delete workspace
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
