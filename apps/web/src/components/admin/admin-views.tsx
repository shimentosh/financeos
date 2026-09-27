"use client";

import { Activity, Ban, Bot, Building2, CheckCircle2, CircleAlert, Database, LogOut, Play, RotateCcw, Shield, Trash2, UserCog, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyNote, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { BarsChart, SERIES } from "@/components/charts/charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientApi, errorMessage } from "@/lib/api/client";
import { authClient } from "@/lib/auth-client";
import { formatDateTime, timeAgo, titleFromKind } from "@/lib/format";
import { toast } from "@/lib/toast";
import { AdminTable } from "./admin-page";
import { DeleteUserDialog } from "./delete-user-dialog";

export type AdminOverview = {
  users: number;
  workspaces: number;
  transactions: number;
  activeSessions: number;
  ai: { configured: boolean; provider: string; model: string | null; callsThisMonth: number; costThisMonthUsd: number; failuresThisMonth: number };
  jobs: Record<string, number>;
  events: { pending: number; failed: number };
  integrations: Record<string, number>;
  database: { size: string };
  storage: string;
  worker: string;
  signUp: string;
};

const usd = (value: number) => `$${value.toFixed(2)}`;

export function AdminOverviewView({ data }: { data: AdminOverview }) {
  const failingIntegrations = (data.integrations.error ?? 0) + (data.integrations.needs_attention ?? 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard icon={Users} label="Users" value={data.users.toLocaleString()} hint={`${data.activeSessions} active sessions`} href="/admin/users" />
        <StatCard
          icon={Building2}
          label="Workspaces"
          value={data.workspaces.toLocaleString()}
          hint={`${data.transactions.toLocaleString()} transactions`}
          href="/admin/workspaces"
        />
        <StatCard
          icon={Bot}
          label="AI this month"
          value={usd(data.ai.costThisMonthUsd)}
          hint={data.ai.configured ? `${data.ai.callsThisMonth} calls · ${data.ai.model}` : "No provider configured"}
          href="/admin/ai"
          tone={data.ai.failuresThisMonth ? "warn" : "default"}
        />
        <StatCard
          icon={Activity}
          label="Job queue"
          value={(data.jobs.queued ?? 0).toLocaleString()}
          hint={`${data.jobs.dead ?? 0} dead · ${data.jobs.running ?? 0} running`}
          href="/admin/jobs"
          tone={data.jobs.dead ? "danger" : "default"}
        />
        <StatCard
          icon={failingIntegrations ? CircleAlert : CheckCircle2}
          label="Integrations"
          value={String(Object.values(data.integrations).reduce((a, b) => a + b, 0))}
          hint={failingIntegrations ? `${failingIntegrations} need attention` : "All healthy"}
          href="/admin/integrations"
          tone={failingIntegrations ? "warn" : "good"}
        />
        <StatCard
          icon={Database}
          label="Database"
          value={data.database.size}
          hint={`${data.events.pending} events pending`}
          tone={data.events.failed ? "warn" : "default"}
        />
      </div>
      <Section title="Instance">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[
            {
              label: "AI provider",
              value: data.ai.configured ? `${data.ai.provider} · ${data.ai.model}` : "None (deterministic parsing only)",
              href: "/admin/ai",
            },
            { label: "File storage", value: data.storage, href: "/admin/storage" },
            { label: "Background worker", value: titleFromKind(data.worker), href: "/admin/jobs" },
            { label: "Sign-up", value: titleFromKind(data.signUp) },
            { label: "Failed events", value: String(data.events.failed), href: "/admin/jobs" },
            { label: "AI failures this month", value: String(data.ai.failuresThisMonth), href: "/admin/ai" },
          ].map(({ label, value, href }) => (
            <div key={label} className="flex justify-between gap-3 border-b border-border/60 pb-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate text-right">
                {href ? (
                  <Link href={href} className="underline-offset-4 hover:underline">
                    {value}
                  </Link>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  banReason: string | null;
  createdAt: string;
  workspaces: number;
  lastSeen: string | null;
};

export function AdminUsersView({ page, currentUserId }: { page: { items: AdminUser[]; total: number }; currentUserId: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; email: string } | null>(null);

  const act = async (id: string, work: () => Promise<{ error?: { message?: string } | null }>, done: string) => {
    setBusy(id);
    const result = await work();
    setBusy(null);
    if (result.error) return toast.error(result.error.message ?? "That did not work");
    toast.success(done);
    router.refresh();
  };

  return (
    <div className="space-y-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          router.push(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        }}
        className="flex max-w-sm gap-2"
      >
        <Input size="sm" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" type="submit" variant="outline">
          Search
        </Button>
      </form>
      <AdminTable headers={["User", "Role", "Workspaces", "Last seen", "Joined", { label: "Actions", align: "right" }]}>
        {page.items.map((user) => (
          <tr key={user.id}>
            <td className="max-w-0 min-w-48">
              <p className="truncate font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </td>
            <td>
              <span className="flex items-center gap-1.5">
                <Badge variant={user.role === "admin" ? "info" : "outline"} className="capitalize">
                  {user.role}
                </Badge>
                {user.banned && <Badge variant="error">Suspended</Badge>}
              </span>
            </td>
            <td className="tabular-nums">{user.workspaces}</td>
            <td className="text-xs text-muted-foreground">{user.lastSeen ? timeAgo(user.lastSeen) : "—"}</td>
            <td className="text-xs text-muted-foreground">{formatDateTime(user.createdAt)}</td>
            <td className="text-right">
              {user.id !== currentUserId && (
                <div className="flex justify-end gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy === user.id}
                    onClick={() =>
                      void act(
                        user.id,
                        () => authClient.admin.setRole({ userId: user.id, role: user.role === "admin" ? "user" : "admin" }),
                        user.role === "admin" ? "Admin role removed" : "Made admin",
                      )
                    }
                  >
                    <UserCog className="size-3.5" /> {user.role === "admin" ? "Revoke admin" : "Make admin"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy === user.id}
                    onClick={() => void act(user.id, () => authClient.admin.revokeUserSessions({ userId: user.id }), "Signed out everywhere")}
                  >
                    <LogOut className="size-3.5" /> Sign out
                  </Button>
                  {user.banned ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy === user.id}
                      onClick={() => void act(user.id, () => authClient.admin.unbanUser({ userId: user.id }), "Access restored")}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={busy === user.id}
                      onClick={() => {
                        const reason = window.prompt(`Suspend ${user.email}? Reason (shown in the audit trail):`);
                        if (reason !== null)
                          void act(user.id, () => authClient.admin.banUser({ userId: user.id, banReason: reason || "Suspended by admin" }), "User suspended");
                      }}
                    >
                      <Ban className="size-3.5" /> Suspend
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy === user.id}
                    onClick={() => setDeleting({ id: user.id, email: user.email })}
                    aria-label={`Delete ${user.email}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </AdminTable>
      <p className="text-xs text-muted-foreground">{page.total} users</p>
      <DeleteUserDialog user={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}

type AdminWorkspace = {
  id: string;
  name: string;
  kind: string;
  baseCurrency: string;
  createdAt: string;
  members: number;
  transactions: number;
  connections: number;
  aiCostUsd: number;
  owner: string | null;
};

export function AdminWorkspacesView({ page }: { page: { items: AdminWorkspace[]; total: number } }) {
  return (
    <AdminTable
      headers={[
        "Workspace",
        "Kind",
        "Owner",
        { label: "Members", align: "right" },
        { label: "Transactions", align: "right" },
        { label: "Integrations", align: "right" },
        { label: "AI (month)", align: "right" },
        "Created",
      ]}
    >
      {page.items.map((ws) => (
        <tr key={ws.id}>
          <td className="font-medium">{ws.name}</td>
          <td>
            <Badge variant="outline" className="capitalize">
              {ws.kind}
            </Badge>{" "}
            <span className="text-xs text-muted-foreground">{ws.baseCurrency}</span>
          </td>
          <td className="text-xs text-muted-foreground">{ws.owner ?? "—"}</td>
          <td className="text-right tabular-nums">{ws.members}</td>
          <td className="text-right tabular-nums">{ws.transactions.toLocaleString()}</td>
          <td className="text-right tabular-nums">{ws.connections}</td>
          <td className="text-right tabular-nums">{usd(ws.aiCostUsd)}</td>
          <td className="text-xs text-muted-foreground">{formatDateTime(ws.createdAt)}</td>
        </tr>
      ))}
    </AdminTable>
  );
}

type Job = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  dedupeKey: string | null;
};
type Schedule = { name: string; cron: string; description: string; lastRun: { at: string; ok: boolean; error?: string } | null };

export function AdminJobsView({ data }: { data: { stats: Record<string, number>; registered: string[]; schedules: Schedule[]; items: Job[] } }) {
  const router = useRouter();
  const retry = async (id: string) => {
    try {
      await clientApi(`/admin/jobs/${id}/retry`, { method: "POST" });
      toast.success("Queued again");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const run = async (name: string) => {
    try {
      await clientApi("/admin/schedules/run", { method: "POST", body: { name } });
      toast.success(`${name} ran`);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {["queued", "running", "succeeded", "failed", "dead"].map((status) => (
          <a key={status} href={`/admin/jobs?status=${status}`} className="rounded-full bg-muted px-3 py-1 text-xs hover:bg-accent">
            <span className="capitalize">{status}</span> <span className="tabular-nums text-muted-foreground">{data.stats[status] ?? 0}</span>
          </a>
        ))}
      </div>
      <Section title="Scheduled tasks" hint="Run where the worker runs; each fans out one job per workspace.">
        <AdminTable headers={["Task", "Schedule", "Last run", { label: "", align: "right" }]}>
          {data.schedules.map((task) => (
            <tr key={task.name}>
              <td>
                <p className="font-medium">{task.name}</p>
                <p className="text-xs text-muted-foreground">{task.description}</p>
              </td>
              <td className="font-mono text-xs">{task.cron}</td>
              <td className="text-xs">
                {task.lastRun ? (
                  <span className={task.lastRun.ok ? "text-muted-foreground" : "text-red-600"}>
                    {task.lastRun.ok ? timeAgo(task.lastRun.at) : task.lastRun.error}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="text-right">
                <Button size="xs" variant="outline" onClick={() => void run(task.name)}>
                  <Play className="size-3" /> Run now
                </Button>
              </td>
            </tr>
          ))}
        </AdminTable>
      </Section>
      <Section title="Recent jobs">
        <AdminTable headers={["Type", "Status", "Attempts", "Created", "Error", { label: "", align: "right" }]}>
          {data.items.map((job) => (
            <tr key={job.id}>
              <td className="font-mono text-xs">{job.type}</td>
              <td>
                <StatusBadge status={job.status === "dead" ? "failed" : job.status} label={job.status} />
              </td>
              <td className="tabular-nums">
                {job.attempts}/{job.maxAttempts}
              </td>
              <td className="text-xs text-muted-foreground">{timeAgo(job.createdAt)}</td>
              <td className="max-w-72 truncate text-xs text-red-600 dark:text-red-400" title={job.lastError ?? undefined}>
                {job.lastError ?? ""}
              </td>
              <td className="text-right">
                {(job.status === "dead" || job.status === "failed") && (
                  <Button size="xs" variant="ghost" onClick={() => void retry(job.id)}>
                    <RotateCcw className="size-3" /> Retry
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </AdminTable>
      </Section>
      <p className="text-xs text-muted-foreground">Registered job types: {data.registered.join(", ") || "none"}</p>
    </div>
  );
}

type AiUsage = {
  days: number;
  byDay: Array<{ day: string; calls: number; cost: number }>;
  byFeature: Array<{ feature: string; calls: number; cost: number; inputTokens: number; outputTokens: number; failures: number; avgLatency: number }>;
  byWorkspace: Array<{ workspaceId: string | null; name: string | null; calls: number; cost: number }>;
};

export function AdminAiView({ data }: { data: AiUsage }) {
  const total = data.byDay.reduce((sum, d) => sum + d.cost, 0);
  return (
    <div className="space-y-4">
      <Section title={`AI spend · last ${data.days} days`} hint={`${usd(total)} across ${data.byDay.reduce((s, d) => s + d.calls, 0)} calls`}>
        {data.byDay.length ? (
          <BarsChart
            data={data.byDay.map((d) => ({ label: d.day, cost: Math.round(d.cost * 100) }))}
            series={[{ key: "cost", label: "Cost", color: SERIES.primary }]}
            format={(v) => usd(v / 100)}
            tickFormat={(label) => label.slice(5)}
            height={180}
          />
        ) : (
          <EmptyNote>No AI calls in this period.</EmptyNote>
        )}
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="By feature">
          <AdminTable
            headers={[
              "Feature",
              { label: "Calls", align: "right" },
              { label: "Tokens in/out", align: "right" },
              { label: "Avg ms", align: "right" },
              { label: "Cost", align: "right" },
            ]}
          >
            {data.byFeature.map((row) => (
              <tr key={row.feature}>
                <td>
                  {row.feature}
                  {row.failures ? <span className="ms-1.5 text-xs text-red-600">{row.failures} failed</span> : null}
                </td>
                <td className="text-right tabular-nums">{row.calls}</td>
                <td className="text-right text-xs tabular-nums">
                  {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
                </td>
                <td className="text-right tabular-nums">{row.avgLatency}</td>
                <td className="text-right tabular-nums">{usd(row.cost)}</td>
              </tr>
            ))}
          </AdminTable>
        </Section>
        <Section title="By workspace">
          <AdminTable headers={["Workspace", { label: "Calls", align: "right" }, { label: "Cost", align: "right" }]}>
            {data.byWorkspace.map((row) => (
              <tr key={row.workspaceId ?? "none"}>
                <td>{row.name ?? "—"}</td>
                <td className="text-right tabular-nums">{row.calls}</td>
                <td className="text-right tabular-nums">{usd(row.cost)}</td>
              </tr>
            ))}
          </AdminTable>
        </Section>
      </div>
    </div>
  );
}

type AdminIntegration = {
  id: string;
  name: string;
  provider: string;
  status: string;
  workspaceName: string;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  errorMessage: string | null;
  recordsTotal: number;
};

export function AdminIntegrationsView({ data }: { data: { connections: AdminIntegration[]; runsLast7Days: Record<string, number> } }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Sync runs, last 7 days:{" "}
        {Object.entries(data.runsLast7Days)
          .map(([status, value]) => `${value} ${status}`)
          .join(" · ") || "none"}
      </p>
      <AdminTable
        headers={["Connection", "Workspace", "Status", "Last sync", { label: "Failures", align: "right" }, { label: "Records", align: "right" }, "Error"]}
      >
        {data.connections.map((c) => (
          <tr key={c.id}>
            <td>
              <p className="font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">{c.provider}</p>
            </td>
            <td className="text-xs">{c.workspaceName}</td>
            <td>
              <StatusBadge status={c.status} />
            </td>
            <td className="text-xs text-muted-foreground">{c.lastSyncedAt ? timeAgo(c.lastSyncedAt) : "never"}</td>
            <td className="text-right tabular-nums">{c.consecutiveFailures}</td>
            <td className="text-right tabular-nums">{c.recordsTotal.toLocaleString()}</td>
            <td className="max-w-64 truncate text-xs text-red-600 dark:text-red-400" title={c.errorMessage ?? undefined}>
              {c.errorMessage ?? ""}
            </td>
          </tr>
        ))}
      </AdminTable>
    </div>
  );
}

type AdminAuditRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: string;
  actorId: string | null;
  workspaceName: string;
  createdAt: string;
};

export function AdminAuditView({ data }: { data: { items: AdminAuditRow[] } }) {
  return (
    <AdminTable headers={["When", "Action", "Workspace", "Actor", "Entity"]}>
      {data.items.map((row) => (
        <tr key={row.id}>
          <td className="text-xs text-muted-foreground">{formatDateTime(row.createdAt)}</td>
          <td className="font-mono text-xs">{row.action}</td>
          <td className="text-xs">{row.workspaceName}</td>
          <td className="text-xs">
            <Badge variant="outline" className="capitalize">
              {row.actorType}
            </Badge>
          </td>
          <td className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">
            {row.entityType} {row.entityId?.slice(0, 8)}
          </td>
        </tr>
      ))}
    </AdminTable>
  );
}

export { Shield };
