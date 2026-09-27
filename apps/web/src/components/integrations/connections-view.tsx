"use client";

import { Activity, CircleAlert, History, Landmark, Plug, PlugZap, RefreshCw, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyState, StatCard, StatusBadge } from "@/components/app/blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Account, Project } from "@/lib/api/types";
import type { CatalogEntry, Connection, SyncStart } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { ConnectDialog } from "./connection-form";
import { CATEGORY_ORDER, CapabilityChips, HealthBadge, ProviderTile, providerIcon } from "./shared";

export function ConnectionsView({
  connections,
  catalog,
  accounts,
  projects,
}: {
  connections: Connection[];
  catalog: CatalogEntry[];
  accounts: Account[];
  projects: Project[];
}) {
  const { canManage, locale } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [connecting, setConnecting] = useState<CatalogEntry | null>(null);

  // `?connect=<provider>` opens the connect form (links from docs and empty states).
  useEffect(() => {
    const provider = searchParams.get("connect");
    if (!provider || !canManage) return;
    const entry = catalog.find((e) => e.provider === provider && e.connectable);
    if (entry) setConnecting(entry);
    router.replace(pathname, { scroll: false });
  }, [searchParams, catalog, canManage, router, pathname]);

  const active = connections.filter((c) => c.status !== "disconnected");
  const attention = active.filter((c) => c.health === "failing" || c.health === "degraded" || c.health === "stale");
  const records = connections.reduce((sum, c) => sum + c.recordsTotal, 0);
  const lastSync = connections
    .map((c) => c.lastSyncedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const demos = catalog.filter((e) => e.provider === "demo_bank" || e.provider === "demo_payments");

  return (
    <div className="space-y-6">
      {connections.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Connect the apps your money flows through"
          description={
            <>
              Capture is what you type, scan or upload. Connect brings transactions in on their own: banks and wallets, Stripe, and your own apps through the
              API or a webhook. Try a sandbox first: it imports three months of realistic data you can review, and nothing leaves the server.
            </>
          }
          action={
            canManage ? (
              <div className="flex flex-wrap justify-center gap-2">
                {demos.map((entry) => (
                  <Button key={entry.provider} size="sm" variant={entry.provider === "demo_bank" ? "default" : "outline"} onClick={() => setConnecting(entry)}>
                    <Sparkles className="size-3.5" /> Try {entry.displayName}
                  </Button>
                ))}
                <Button size="sm" variant="outline" render={<Link href="/integrations/import" />}>
                  <Upload className="size-3.5" /> Import a statement
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Ask a workspace owner or admin to connect apps.</p>
            )
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              icon={PlugZap}
              label="Connected"
              value={active.length.toLocaleString(locale)}
              hint={`${connections.length - active.length} disconnected`}
              tone="good"
            />
            <StatCard
              icon={CircleAlert}
              label="Need attention"
              value={attention.length.toLocaleString(locale)}
              hint={attention.length ? attention.map((c) => c.name).join(", ") : "All healthy"}
              tone={attention.some((c) => c.health === "failing") ? "danger" : attention.length ? "warn" : "default"}
              href={attention.length ? "/integrations/sync-history?status=failed,partial" : undefined}
            />
            <StatCard
              icon={Landmark}
              label="Records imported"
              value={records.toLocaleString(locale)}
              hint="Across every connection"
              href="/transactions?source=integration&period=all_time"
            />
            <StatCard icon={History} label="Last sync" value={lastSync ? timeAgo(lastSync) : "—"} hint="See every run" href="/integrations/sync-history" />
          </div>
          <section className="space-y-2">
            <h2 className="px-1 text-xs font-medium text-muted-foreground">Your connections</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {connections.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
              ))}
            </div>
          </section>
        </>
      )}

      <Catalog catalog={catalog} onConnect={setConnecting} />
      <ConnectDialog
        entry={connecting}
        open={connecting !== null}
        onOpenChange={(open) => !open && setConnecting(null)}
        accounts={accounts}
        projects={projects}
      />
    </div>
  );
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const { canManage, locale } = useApp();
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const canSync = canManage && connection.capabilities.sync && connection.status !== "disconnected";

  const syncNow = async () => {
    setSyncing(true);
    try {
      const result = await clientApi<SyncStart>(`/integrations/${connection.id}/sync`, { method: "POST" });
      toast.success(result.status === "queued" ? "Sync started" : "A sync is already running", {
        action: result.runId ? { label: "Follow", onClick: () => router.push(`/integrations/${connection.id}?tab=runs&run=${result.runId}`) } : undefined,
      });
      invalidateApiCache("/integrations");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSyncing(false);
    }
  };

  const lastLine = connection.lastSyncedAt
    ? `Synced ${timeAgo(connection.lastSyncedAt)}`
    : connection.capabilities.sync
      ? "Not synced yet"
      : connection.capabilities.webhook
        ? "Waiting for the first event"
        : "Never used";

  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4", connection.status === "disconnected" && "opacity-75")}>
      <div className="flex items-start justify-between gap-3">
        <Link href={`/integrations/${connection.id}`} className="flex min-w-0 items-center gap-2.5 hover:opacity-90">
          <ProviderTile icon={connection.icon} category={connection.category} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{connection.name}</p>
            <p className="truncate text-xs text-muted-foreground">{connection.displayName}</p>
          </div>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={connection.status} label={connection.status === "needs_attention" ? "Needs attention" : undefined} />
          {connection.status !== "disconnected" && <HealthBadge health={connection.health} />}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Records</dt>
        <dd className="text-right tabular-nums">{connection.recordsTotal.toLocaleString(locale)}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd className="truncate text-right">{connection.accountName ?? "Chosen per record"}</dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd className="text-right">{connection.trustLevel === "trusted" ? "Posts automatically" : "Review first"}</dd>
      </dl>
      {connection.errorMessage && connection.status !== "disconnected" && (
        <p className="line-clamp-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">{connection.errorMessage}</p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
          <Activity className="size-3.5 shrink-0" />
          {lastLine}
        </span>
        <div className="flex shrink-0 gap-1.5">
          {canSync && (
            <Button size="xs" variant="outline" loading={syncing} onClick={() => void syncNow()}>
              <RefreshCw className="size-3.5" /> Sync now
            </Button>
          )}
          <Button size="xs" variant="ghost" render={<Link href={`/integrations/${connection.id}`} />}>
            Open
          </Button>
        </div>
      </div>
    </div>
  );
}

function Catalog({ catalog, onConnect }: { catalog: CatalogEntry[]; onConnect: (entry: CatalogEntry) => void }) {
  const { canManage } = useApp();
  const byCategory = (a: CatalogEntry, b: CatalogEntry) =>
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.displayName.localeCompare(b.displayName);
  // What can be connected today gets a card; the roadmap is one quiet line.
  const ready = catalog.filter((entry) => entry.available).sort(byCategory);
  const soon = catalog.filter((entry) => !entry.available).sort(byCategory);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Add a connection</h2>
        <p className="text-xs text-muted-foreground">
          {canManage
            ? "Everything imported is checked for duplicates and runs through your rules first."
            : "Only workspace owners and admins can connect apps."}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {ready.map((entry) => (
          <CatalogCard key={entry.provider} entry={entry} canManage={canManage} onConnect={() => onConnect(entry)} />
        ))}
      </div>
      {soon.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="me-1 text-xs text-muted-foreground">Coming soon</span>
          {soon.map((entry) => {
            const Icon = providerIcon(entry.icon);
            return (
              <span
                key={entry.provider}
                title={entry.description}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
              >
                <Icon className="size-3.5" aria-hidden />
                {entry.displayName}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CatalogCard({ entry, canManage, onConnect }: { entry: CatalogEntry; canManage: boolean; onConnect: () => void }) {
  let action: React.ReactNode;
  if (!entry.available) {
    action = (
      <Badge variant="secondary" size="sm">
        Coming soon
      </Badge>
    );
  } else if (entry.href) {
    action = (
      <Button size="xs" variant="outline" render={<Link href={entry.href} />}>
        <Upload className="size-3.5" /> Import a file
      </Button>
    );
  } else if (entry.connectable && canManage) {
    action = (
      <Button size="xs" variant="outline" onClick={onConnect}>
        <Plug className="size-3.5" /> Connect
      </Button>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-border bg-card p-4", !entry.available && "bg-card/50")}>
      <div className="flex items-start gap-2.5">
        <span className={cn(!entry.available && "opacity-60")}>
          <ProviderTile icon={entry.icon} category={entry.category} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", !entry.available && "text-muted-foreground")}>{entry.displayName}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <CapabilityChips capabilities={entry.capabilities} />
        {action}
      </div>
    </div>
  );
}
