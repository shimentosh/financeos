"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { clientApi, errorMessage } from "@/lib/api/client";
import { toast } from "@/lib/toast";

type DeletionCheck = {
  email: string;
  canDelete: boolean;
  blocking: Array<{ id: string; name: string; otherMembers: number }>;
  deletes: Array<{ id: string; name: string; transactions: number }>;
  leaves: Array<{ id: string; name: string }>;
};

/**
 * Admin → Users → Delete: shows what goes with the person (workspaces they own
 * alone, with every record and file) and what blocks it (workspaces shared
 * with others), then deletes after the admin types their email.
 */
export function DeleteUserDialog({ user, onOpenChange }: { user: { id: string; email: string } | null; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [check, setCheck] = useState<DeletionCheck | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCheck(null);
    setConfirm("");
    if (!user) return;
    clientApi<DeletionCheck>(`/admin/users/${encodeURIComponent(user.id)}/deletion-check`)
      .then(setCheck)
      .catch((error) => toast.error(errorMessage(error)));
  }, [user]);

  const remove = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await clientApi(`/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      toast.success(`${user.email} was deleted`);
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={user !== null} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user?.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            {!check
              ? "Checking what belongs to this account…"
              : !check.canDelete
                ? "This person owns workspaces other people still use. Those need a new owner, or to be deleted, before the account can go."
                : "Their sign-in, sessions and memberships are removed and a running card subscription is cancelled. This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {check && (
          <div className="space-y-2 px-6 text-sm">
            {check.blocking.length > 0 && (
              <p className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive-foreground">
                Shared: {check.blocking.map((w) => `${w.name} (${w.otherMembers} other ${w.otherMembers === 1 ? "person" : "people"})`).join(", ")}
              </p>
            )}
            {check.canDelete && check.deletes.length > 0 && (
              <p>
                Deleted with every record and file:{" "}
                <span className="font-medium">{check.deletes.map((w) => `${w.name} (${w.transactions} transactions)`).join(", ")}</span>
              </p>
            )}
            {check.canDelete && check.leaves.length > 0 && (
              <p className="text-muted-foreground">Removed from: {check.leaves.map((w) => w.name).join(", ")} (those stay with their owners).</p>
            )}
            {check.canDelete && (
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={`Type ${check.email} to confirm`}
                aria-label="Type the email to confirm"
              />
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={remove}
            loading={busy}
            disabled={!check?.canDelete || confirm.trim().toLowerCase() !== check.email.toLowerCase()}
          >
            Delete user
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
