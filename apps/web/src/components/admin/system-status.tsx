import { CheckCircle2, CircleAlert } from "lucide-react";
import Link from "next/link";
import { Section } from "@/components/app/blocks";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";

export type AdminSystem = {
  version: string;
  environment: string;
  node: string;
  uptimeSeconds: number;
  database: { ok: boolean; latencyMs: number; poolMax: number };
  migrations: { applied: number; expected: number; pending: string[]; lastAppliedAt: number | null } | null;
  ready: boolean;
  worker: { mode: string; heartbeat: { at: string; instance: string; ageSeconds: number; healthy: boolean } | null };
  schedules: Array<{ name: string; lastSlot: string; runs: number }>;
  observability: { errorReporting: boolean; logFormat: string; trustProxy: string };
};

const uptime = (seconds: number) =>
  seconds < 3600 ? `${Math.round(seconds / 60)} min` : seconds < 86_400 ? `${Math.round(seconds / 3600)} h` : `${Math.round(seconds / 86_400)} days`;

function Row({ label, ok, children }: { label: string; ok?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {ok !== undefined &&
          (ok ? <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden /> : <CircleAlert className="size-3.5 text-amber-600" aria-hidden />)}
        {label}
      </dt>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  );
}

/** Admin overview: whether this installation is healthy — migrations, database, worker, schedules, error reporting. */
export function SystemStatus({ data }: { data: AdminSystem }) {
  const heartbeat = data.worker.heartbeat;
  const pending = data.migrations?.pending ?? [];
  return (
    <Section title="System health" hint={`Version ${data.version} · ${data.environment} · Node ${data.node} · up ${uptime(data.uptimeSeconds)}`}>
      <div className="grid gap-x-8 md:grid-cols-2">
        <dl>
          <Row label="Ready for traffic" ok={data.ready}>
            {data.ready ? "Yes" : "No — see migrations"}
          </Row>
          <Row label="Database" ok={data.database.ok}>
            {data.database.ok ? `${data.database.latencyMs} ms · pool ${data.database.poolMax}` : "Unreachable"}
          </Row>
          <Row label="Migrations" ok={pending.length === 0 && data.migrations !== null}>
            {data.migrations
              ? pending.length
                ? `${pending.length} pending: ${pending.join(", ")}`
                : `${data.migrations.applied} applied${data.migrations.lastAppliedAt ? ` · last ${formatDateTime(new Date(data.migrations.lastAppliedAt).toISOString())}` : ""}`
              : "Unknown"}
          </Row>
        </dl>
        <dl>
          <Row label={`Worker (${data.worker.mode})`} ok={Boolean(heartbeat?.healthy)}>
            {heartbeat ? `${heartbeat.healthy ? "Running" : "Silent"} · last beat ${timeAgo(heartbeat.at)}` : "No heartbeat yet"}
          </Row>
          <Row label="Error reporting" ok={data.observability.errorReporting}>
            {data.observability.errorReporting ? "Sentry on" : "Off (set SENTRY_DSN)"}
          </Row>
          <Row label="Logs">
            {data.observability.logFormat === "json" ? "JSON" : "Text"} · trust proxy {data.observability.trustProxy}
          </Row>
        </dl>
      </div>
      {data.schedules.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {data.schedules.slice(0, 12).map((schedule) => (
            <Link
              key={schedule.name}
              href="/admin/jobs"
              className={cn(
                "rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
              )}
              title={`${schedule.runs} runs`}
            >
              {schedule.name} · {timeAgo(schedule.lastSlot)}
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}
