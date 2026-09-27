import { ShieldAlert } from "lucide-react";
import { AdminTable } from "@/components/admin/admin-page";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export type PlatformAuditRow = {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

const LABELS: Record<string, string> = {
  "user.banned": "Suspended a user",
  "user.unbanned": "Lifted a suspension",
  "user.role_changed": "Changed a role",
  "user.impersonated": "Started impersonating",
  "user.impersonation_stopped": "Stopped impersonating",
  "user.sessions_revoked": "Signed a user out everywhere",
  "user.session_revoked": "Signed out one session",
  "user.removed": "Removed a user",
  "user.password_set": "Set a user's password",
  "user.updated": "Edited a user",
  "user.created": "Created a user",
  "account.deleted": "Deleted their account",
  "workspace.deleted": "Deleted a workspace",
};

const DANGER = new Set(["user.banned", "user.removed", "account.deleted", "workspace.deleted", "user.password_set"]);

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null);

function target(row: PlatformAuditRow) {
  const d = row.details;
  if (row.targetType === "workspace") return text(d.name) ?? row.targetId?.slice(0, 8) ?? "—";
  return text(d.targetEmail) ?? row.targetId?.slice(0, 12) ?? "—";
}

function summary(row: PlatformAuditRow) {
  const d = row.details;
  switch (row.action) {
    case "user.banned":
      return [text(d.reason), d.expiresInSeconds ? `for ${Math.round(Number(d.expiresInSeconds) / 86_400)} days` : null].filter(Boolean).join(" · ") || null;
    case "user.role_changed":
    case "user.created":
      return d.role ? `role: ${text(d.role)}` : null;
    case "user.updated":
      return Array.isArray(d.fields) ? `fields: ${d.fields.join(", ")}` : null;
    case "workspace.deleted":
      return [
        text(d.reason)?.replace(/_/g, " "),
        d.transactions !== undefined ? `${text(d.transactions)} transactions` : null,
        d.files ? `${text(d.files)} files` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "account.deleted":
      return Array.isArray(d.workspacesDeleted) ? `${d.workspacesDeleted.length} workspaces deleted` : null;
    default:
      return null;
  }
}

/** Admin actions on users and deletions of accounts and workspaces: the installation's own audit trail. */
export function PlatformAuditSection({ items }: { items: PlatformAuditRow[] }) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">Platform actions</h2>
        <p className="text-xs text-muted-foreground">
          Suspensions, role changes, impersonation, and account and workspace deletions. Kept after the people involved are gone.
        </p>
      </div>
      <AdminTable
        headers={["When", "Action", "By", "Target", "Details", "IP"]}
        empty={
          items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <ShieldAlert className="size-4" />
              </span>
              <p className="text-sm font-medium">No platform actions yet</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                When an admin suspends someone, changes a role or signs in as a user, or when an account is deleted, it is recorded here.
              </p>
            </div>
          ) : undefined
        }
      >
        {items.map((row) => (
          <tr key={row.id}>
            <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(row.createdAt)}</td>
            <td className="text-xs">
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  {LABELS[row.action] ?? row.action}
                  {DANGER.has(row.action) && (
                    <Badge variant="error" size="sm">
                      !
                    </Badge>
                  )}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{row.action}</span>
              </span>
            </td>
            <td className="max-w-48 truncate text-xs">{row.actorEmail ?? row.actorId?.slice(0, 12) ?? "system"}</td>
            <td className="max-w-48 truncate text-xs">
              <Badge variant="outline" className="me-1 capitalize">
                {row.targetType}
              </Badge>
              {target(row)}
            </td>
            <td className="max-w-64 truncate text-xs text-muted-foreground">{summary(row) ?? "—"}</td>
            <td className="font-mono text-[11px] text-muted-foreground">{row.ip ?? "—"}</td>
          </tr>
        ))}
      </AdminTable>
    </section>
  );
}
