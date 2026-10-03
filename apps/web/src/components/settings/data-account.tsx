"use client";

import { Building2, Download, FileJson, FileSpreadsheet, TriangleAlert, User, UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientApi, errorMessage } from "@/lib/api/client";
import { ApiError } from "@/lib/api/shared";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { SettingsCard } from "./settings-page";

export type DeletionCheck = {
  email: string;
  canDelete: boolean;
  blocking: Array<{ id: string; name: string; kind: string; otherMembers: number }>;
  deletes: Array<{ id: string; name: string; kind: string; transactions: number }>;
  leaves: Array<{ id: string; name: string; kind: string; role: string }>;
};

/** Downloads a file from the API, so a refusal shows as a message instead of a broken download. */
async function downloadFrom(path: string, fallbackName: string) {
  const response = await fetch(`/api${path}`, { credentials: "same-origin" });
  if (response.status === 401) {
    window.location.href = `/sign-in?expired=1&next=${encodeURIComponent(window.location.pathname)}`;
    return;
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The export failed (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExportRow({
  icon: Icon,
  title,
  description,
  path,
  filename,
  disabled,
}: {
  icon: typeof FileJson;
  title: string;
  description: ReactNode;
  path: string;
  filename: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await downloadFrom(path, filename);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button size="sm" variant="outline" loading={busy} disabled={disabled} onClick={() => void run()}>
        <Download className="size-3.5" /> Download
      </Button>
    </li>
  );
}

function WorkspaceLine({ name, kind, children }: { name: string; kind: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          kind === "business" ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "bg-sky-500/10 text-sky-600 dark:text-sky-400",
        )}
      >
        {kind === "business" ? <Building2 className="size-3.5" /> : <User className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {children}
    </li>
  );
}

export function DataAccountSettings({ check }: { check: DeletionCheck }) {
  const { workspace, canManage } = useApp();
  const router = useRouter();
  const id = useId();
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const matches = confirmEmail.trim().toLowerCase() === check.email.toLowerCase();

  const openWorkspace = async (workspaceId: string) => {
    setOpening(workspaceId);
    try {
      await clientApi("/me/active-workspace", { method: "POST", body: { workspaceId } });
      router.push("/settings/workspace");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
      setOpening(null);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      await clientApi("/account", { method: "DELETE", body: { confirmEmail: confirmEmail.trim() } });
      // The session is gone with the account; ?expired clears its cookie.
      window.location.href = "/sign-in?expired=1&deleted=1";
    } catch (error) {
      setDeleting(false);
      toast.error(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) router.refresh();
    }
  };

  return (
    <>
      <SettingsCard
        title="Export your data"
        description={
          <>
            Your records are yours. Workspace exports cover <span className="font-medium text-foreground">{workspace.name}</span>; switch workspace to export
            another.
          </>
        }
      >
        <ul className="divide-y divide-border">
          <ExportRow
            icon={FileJson}
            title="Everything in this workspace"
            description={
              canManage
                ? "JSON: accounts, categories, transactions and ledger entries, subscriptions, budgets, goals, assets, loans, invoices, file details and the recent audit log."
                : "Only the workspace owner or an admin can export the whole workspace."
            }
            path="/account/export"
            filename="financeos-export.json"
            disabled={!canManage}
          />
          <ExportRow
            icon={FileSpreadsheet}
            title="Transactions"
            description={
              canManage
                ? "CSV for spreadsheets: every transaction with its original, account and base-currency amounts."
                : "Only the workspace owner or an admin can export transactions."
            }
            path="/account/export/transactions.csv"
            filename="financeos-transactions.csv"
            disabled={!canManage}
          />
          <ExportRow
            icon={User}
            title="Your profile"
            description="JSON: your details, preferences, workspace memberships and signed-in devices."
            path="/account/me/export"
            filename="financeos-profile.json"
          />
        </ul>
        <p className="text-xs text-muted-foreground">Receipts and other files are not inside the export; open them from their transactions.</p>
      </SettingsCard>

      <section className="rounded-xl border border-destructive/32 bg-card">
        <div className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive-foreground">
              <TriangleAlert className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Delete your account</h2>
              <p className="text-xs text-muted-foreground">
                Permanent. Your sign-in, your settings and every workspace you own alone are deleted, with all their records and files. Export first if you
                might need them.
              </p>
            </div>
          </div>

          {check.blocking.length > 0 && (
            <div className="space-y-2 rounded-lg bg-warning/8 p-3">
              <p className="text-sm font-medium text-warning-foreground">First hand over or delete the workspaces you share</p>
              <p className="text-xs text-muted-foreground">
                Other people use these workspaces. Transfer ownership to one of them, or delete the workspace, in Workspace &amp; members.
              </p>
              <ul className="divide-y divide-border">
                {check.blocking.map((w) => (
                  <WorkspaceLine key={w.id} name={w.name} kind={w.kind}>
                    <Badge variant="outline">
                      {w.otherMembers} other {w.otherMembers === 1 ? "member" : "members"}
                    </Badge>
                    <Button size="xs" variant="outline" loading={opening === w.id} onClick={() => void openWorkspace(w.id)}>
                      Manage
                    </Button>
                  </WorkspaceLine>
                ))}
              </ul>
            </div>
          )}

          {check.deletes.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Deleted with your account</p>
              <ul className="divide-y divide-border">
                {check.deletes.map((w) => (
                  <WorkspaceLine key={w.id} name={w.name} kind={w.kind}>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {w.transactions === 0 ? "No transactions" : `${w.transactions.toLocaleString()} ${w.transactions === 1 ? "transaction" : "transactions"}`}
                    </span>
                  </WorkspaceLine>
                ))}
              </ul>
            </div>
          )}

          {check.leaves.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">You will leave (their owners keep them)</p>
              <ul className="divide-y divide-border">
                {check.leaves.map((w) => (
                  <WorkspaceLine key={w.id} name={w.name} kind={w.kind}>
                    <Badge variant="outline" className="capitalize">
                      <UserMinus className="size-3" /> {w.role}
                    </Badge>
                  </WorkspaceLine>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor={`${id}-confirm`}>
              Type <span className="font-mono text-xs">{check.email}</span> to confirm
            </Label>
            <Input
              id={`${id}-confirm`}
              type="email"
              autoComplete="off"
              disabled={!check.canDelete}
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="destructive" loading={deleting} disabled={!check.canDelete || !matches} onClick={() => void deleteAccount()}>
            Delete my account
          </Button>
        </div>
      </section>
    </>
  );
}
