"use client";

import { CircleAlert, History, ListChecks, Plug, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyState, StatCard } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Account } from "@/lib/api/types";
import type { Connection, Page, RunSummary, SyncTrigger } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { Pager } from "./detail-tabs";
import { RunDetailDialog, RunsTable } from "./runs";
import { TRIGGER_LABEL } from "./shared";

const ALL = "__all__";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: ALL, label: "Any status" },
  { value: "succeeded", label: "Succeeded" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
  { value: "failed,partial", label: "Failed or partial" },
  { value: "running", label: "Running" },
];

export type SyncHistoryFilters = { connectionId?: string; status?: string; trigger?: string; from?: string; to?: string; runId?: string };

export function SyncHistoryView({
  runs,
  connections,
  accounts,
  filters,
}: {
  runs: Page<RunSummary>;
  connections: Connection[];
  accounts: Account[];
  filters: SyncHistoryFilters;
}) {
  const { locale } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [runId, setRunId] = useState<string | null>(filters.runId ?? null);

  useEffect(() => setRunId(filters.runId ?? null), [filters.runId]);

  const update = (changes: Record<string, string | null | undefined>, resetPage = true) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "" || value === ALL) params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.delete("page");
    startTransition(() => router.push(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false }));
  };

  const openRun = (id: string | null) => {
    setRunId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("runId", id);
    else url.searchParams.delete("runId");
    window.history.replaceState(null, "", url);
  };

  const filtered = Boolean(filters.connectionId || filters.status || filters.trigger || filters.from || filters.to);
  const pageRuns = runs.items;
  const errors = pageRuns.reduce((sum, run) => sum + run.errors, 0);
  const created = pageRuns.reduce((sum, run) => sum + run.created + run.updated, 0);
  const failed = pageRuns.filter((run) => run.status === "failed").length;
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? null;

  if (!connections.length && !runs.total) {
    return (
      <EmptyState
        icon={History}
        title="No syncs yet"
        description="Connect a bank, a wallet, Stripe or your own app, and every sync and webhook delivery shows up here with what it imported and why anything was skipped."
        action={
          <Button size="sm" render={<Link href="/integrations" />}>
            <Plug className="size-3.5" /> Connect an app
          </Button>
        }
      />
    );
  }

  return (
    <div className={cn("space-y-4 transition-opacity", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.connectionId ?? ALL} onValueChange={(v) => typeof v === "string" && update({ connectionId: v })}>
          <SelectTrigger size="sm" className="w-48">
            <SelectValue>
              {filters.connectionId ? (connections.find((c) => c.id === filters.connectionId)?.name ?? "Connection") : "All connections"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All connections</SelectItem>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status ?? ALL} onValueChange={(v) => typeof v === "string" && update({ status: v })}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue>{STATUS_OPTIONS.find((o) => o.value === (filters.status ?? ALL))?.label ?? filters.status}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.trigger ?? ALL} onValueChange={(v) => typeof v === "string" && update({ trigger: v })}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue>{filters.trigger ? (TRIGGER_LABEL[filters.trigger as SyncTrigger] ?? filters.trigger) : "Any trigger"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any trigger</SelectItem>
            {(Object.keys(TRIGGER_LABEL) as SyncTrigger[]).map((trigger) => (
              <SelectItem key={trigger} value={trigger}>
                {TRIGGER_LABEL[trigger]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Input
            size="sm"
            type="date"
            aria-label="From"
            className="w-36"
            value={filters.from ?? ""}
            onChange={(e) => update({ from: e.target.value || null })}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input size="sm" type="date" aria-label="To" className="w-36" value={filters.to ?? ""} onChange={(e) => update({ to: e.target.value || null })} />
        </div>
        {filtered && (
          <Button size="xs" variant="ghost" onClick={() => update({ connectionId: null, status: null, trigger: null, from: null, to: null })}>
            <X className="size-3.5" /> Clear
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={History} label={filtered ? "Matching runs" : "Runs"} value={runs.total.toLocaleString(locale)} />
        <StatCard icon={ListChecks} label="Records added (this page)" value={created.toLocaleString(locale)} tone="good" />
        <StatCard
          icon={CircleAlert}
          label="Failed runs (this page)"
          value={failed.toLocaleString(locale)}
          tone={failed ? "danger" : "default"}
          href={failed ? "/integrations/sync-history?status=failed" : undefined}
        />
        <StatCard icon={TriangleAlert} label="Record errors (this page)" value={errors.toLocaleString(locale)} tone={errors ? "warn" : "default"} />
      </div>

      {pageRuns.length === 0 ? (
        <EmptyState
          icon={History}
          title="No runs match these filters"
          description="Try a wider date range, or clear the filters."
          action={
            <Button size="sm" variant="outline" onClick={() => update({ connectionId: null, status: null, trigger: null, from: null, to: null })}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <>
          <RunsTable runs={pageRuns} onOpen={openRun} />
          <Pager page={runs.page} pageSize={runs.pageSize} total={runs.total} onPage={(page) => update({ page: String(page) }, false)} />
        </>
      )}

      <RunDetailDialog runId={runId} onClose={() => openRun(null)} onChanged={(id) => openRun(id)} accountName={accountName} />
    </div>
  );
}
