"use client";

import { ArrowRight, CircleAlert, ExternalLink, RotateCw, Scale } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { RunBalance, RunDetail, RunSummary, SyncStart } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { formatDuration, TRIGGER_LABEL, transactionsHref } from "./shared";

/** Runs as a dense table; the row opens the run. */
export function RunsTable({ runs, onOpen, showConnection = true }: { runs: RunSummary[]; onOpen: (id: string) => void; showConnection?: boolean }) {
  const { locale } = useApp();
  const n = (value: number) => value.toLocaleString(locale);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>Started</th>
            {showConnection && <th className="hidden md:table-cell">Connection</th>}
            <th className="hidden sm:table-cell">Trigger</th>
            <th>Status</th>
            <th className="hidden text-right! lg:table-cell">Found</th>
            <th className="text-right!">Created</th>
            <th className="hidden text-right! md:table-cell">Duplicates</th>
            <th className="hidden text-right! md:table-cell">Errors</th>
            <th className="hidden text-right! lg:table-cell">Duration</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <tr key={run.id} onClick={() => onOpen(run.id)} className="cursor-pointer transition-colors hover:bg-accent/40 [&>td]:px-3 [&>td]:py-2">
              <td className="whitespace-nowrap">
                <span className="block text-xs tabular-nums" title={formatDateTime(run.startedAt)}>
                  {timeAgo(run.startedAt)}
                </span>
                {showConnection && <span className="block max-w-40 truncate text-[11px] text-muted-foreground md:hidden">{run.connectionName}</span>}
              </td>
              {showConnection && <td className="hidden max-w-48 truncate text-xs md:table-cell">{run.connectionName ?? "—"}</td>}
              <td className="hidden text-xs text-muted-foreground sm:table-cell">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</td>
              <td>
                <div className="flex items-center gap-1.5">
                  <StatusBadge status={run.status} label={run.status === "running" ? "Running" : undefined} />
                  {run.needsReview > 0 && (
                    <span className="hidden rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 sm:inline dark:text-amber-300">
                      {run.needsReview} to review
                    </span>
                  )}
                </div>
              </td>
              <td className="hidden text-right text-xs tabular-nums lg:table-cell">{n(run.recordsFound)}</td>
              <td className="text-right text-xs tabular-nums">{n(run.created + run.updated)}</td>
              <td className="hidden text-right text-xs tabular-nums text-muted-foreground md:table-cell">{n(run.duplicates)}</td>
              <td
                className={cn(
                  "hidden text-right text-xs tabular-nums md:table-cell",
                  run.errors > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
                )}
              >
                {n(run.errors)}
              </td>
              <td className="hidden text-right text-xs tabular-nums text-muted-foreground lg:table-cell">{formatDuration(run.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" | "good" }) {
  const { locale } = useApp();
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "danger" && value > 0 && "text-red-600 dark:text-red-400",
          tone === "warn" && value > 0 && "text-amber-600 dark:text-amber-400",
          tone === "good" && value > 0 && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {value.toLocaleString(locale)}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

/** Reported balance against the books on the same day. */
export function BalanceComparison({ balances, accountName }: { balances: RunBalance[]; accountName?: (id: string | null) => string | null }) {
  const { money } = useApp();
  if (!balances.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>Account</th>
            <th className="hidden sm:table-cell">As of</th>
            <th className="text-right!">Source says</th>
            <th className="text-right!">Books say</th>
            <th className="text-right!">Difference</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {balances.map((balance) => {
            const currency = balance.currency ?? undefined;
            const off = balance.difference !== null && balance.difference !== 0;
            return (
              <tr key={`${balance.accountId}-${balance.currency}-${balance.asOf}`} className="[&>td]:px-3 [&>td]:py-2">
                <td className="max-w-40 truncate text-xs">
                  {balance.accountId ? (
                    <Link href={`/accounts/${balance.accountId}`} className="hover:underline">
                      {accountName?.(balance.accountId) ?? "Account"}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Not mapped</span>
                  )}
                </td>
                <td className="hidden text-xs tabular-nums text-muted-foreground sm:table-cell">{balance.asOf ?? "—"}</td>
                <td className="text-right text-xs tabular-nums">{money(balance.balance, currency)}</td>
                <td className="text-right text-xs tabular-nums">{balance.bookBalance === null ? "—" : money(balance.bookBalance, currency)}</td>
                <td
                  className={cn(
                    "text-right text-xs font-medium tabular-nums",
                    off ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {balance.difference === null ? "—" : balance.difference === 0 ? "Matches" : money(balance.difference, currency, { signed: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {balances.some((b) => b.difference) && (
        <p className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <Scale className="size-3.5" />
          Differences usually mean drafts still waiting for review, or history before the connection started. Reconcile from the account page.
        </p>
      )}
    </div>
  );
}

function DetailList({
  title,
  items,
  tone,
}: {
  title: string;
  items: Array<{ key: string; label: string | null; message: string; href?: string | null }>;
  tone: "danger" | "muted" | "warn";
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-semibold">
        {title} <span className="font-normal text-muted-foreground">({items.length})</span>
      </h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 px-3 py-2 text-xs">
            <span
              className={cn(
                "mt-1 size-1.5 shrink-0 rounded-full",
                tone === "danger" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-muted-foreground/50",
              )}
            />
            <span className="min-w-0 flex-1">
              {item.label && <code className="me-1.5 break-all font-mono text-[11px] text-muted-foreground">{item.label}</code>}
              <span className="break-words">{item.message}</span>
            </span>
            {item.href && (
              <Link href={item.href} className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground hover:text-foreground">
                Open <ArrowRight className="size-3" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One run in a side panel: counts, every error/skip/review line, reported
 * balances, and retry. Polls while the run is still going.
 */
export function RunDetailDialog({
  runId,
  onClose,
  onChanged,
  accountName,
}: {
  runId: string | null;
  onClose: () => void;
  /** A retry started a new run: show it instead. */
  onChanged?: (runId: string) => void;
  accountName?: (id: string | null) => string | null;
}) {
  const { canManage } = useApp();
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const lastStatus = useRef<string | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      setRun(await clientApi<RunDetail>(`/sync-runs/${id}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    setRun(null);
    setError(null);
    lastStatus.current = null;
    if (runId) void load(runId);
  }, [runId, load]);

  // A queued or running sync: check again every two seconds, for up to five minutes.
  useEffect(() => {
    if (!runId || run?.status !== "running") return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      if (ticks > 150) return clearInterval(timer);
      void load(runId);
    }, 2000);
    return () => clearInterval(timer);
  }, [runId, run?.status, load]);

  // When a run we watched finishes, refresh whatever page is behind the panel.
  useEffect(() => {
    if (!run) return;
    if (lastStatus.current === "running" && run.status !== "running") router.refresh();
    lastStatus.current = run.status;
  }, [run, router]);

  const retry = async () => {
    if (!run) return;
    setRetrying(true);
    try {
      const result = await clientApi<SyncStart>(`/sync-runs/${run.id}/retry`, { method: "POST" });
      toast.success(result.status === "queued" ? "Retrying from where it stopped" : "A sync is already running");
      invalidateApiCache("/integrations");
      if (result.runId) onChanged?.(result.runId);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  const retryable = run && canManage && (run.status === "failed" || run.status === "partial") && run.trigger !== "webhook";

  return (
    <Dialog open={runId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>{run ? `${TRIGGER_LABEL[run.trigger] ?? run.trigger} sync` : "Sync run"}</DialogTitle>
          <DialogDescription>
            {run ? (
              <>
                {run.connectionName} · started {formatDateTime(run.startedAt)}
                {run.finishedAt ? ` · took ${formatDuration(run.durationMs)}` : ""}
              </>
            ) : (
              "Loading…"
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {error && (
            <p className="flex items-center gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
              <CircleAlert className="size-4" />
              {error}
            </p>
          )}
          {!run && !error && (
            <div className="space-y-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-20" />
              <Skeleton className="h-32" />
            </div>
          )}
          {run && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} label={run.status === "running" ? "Running" : undefined} />
                {run.status === "running" && <span className="text-xs text-muted-foreground">Updating every few seconds…</span>}
                {run.message && run.status !== "running" && <span className="text-xs text-muted-foreground">{run.message}</span>}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Count label="Found" value={run.recordsFound} />
                <Count label="Created" value={run.created} tone="good" />
                <Count label="Updated" value={run.updated} />
                <Count label="Skipped" value={run.skipped} />
                <Count label="Already imported" value={run.duplicates} />
                <Count label="Errors" value={run.errors} tone="danger" />
              </div>
              {run.reviewDetails.length > 0 && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <span>{run.reviewDetails.length} records look like transactions already in your books and were saved as drafts.</span>
                  <Link
                    href={transactionsHref(run.reviewDetails.map((d) => d.transactionId).filter((id): id is string => Boolean(id)))}
                    className="inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-4 hover:underline"
                  >
                    Review <ArrowRight className="size-3" />
                  </Link>
                </div>
              )}
              <DetailList title="Errors" tone="danger" items={run.errorDetails.map((d, i) => ({ key: `e${i}`, label: d.externalId, message: d.message }))} />
              <DetailList
                title="Possible duplicates"
                tone="warn"
                items={run.reviewDetails.map((d, i) => ({
                  key: `r${i}`,
                  label: d.externalId,
                  message: d.message,
                  href: d.transactionId ? transactionsHref([d.transactionId]) : null,
                }))}
              />
              <DetailList title="Skipped" tone="muted" items={run.skippedDetails.map((d, i) => ({ key: `s${i}`, label: d.externalId, message: d.message }))} />
              {run.balances.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold">Balance check</h3>
                  <BalanceComparison balances={run.balances} accountName={accountName} />
                </div>
              )}
              {run.status !== "running" && !run.errorDetails.length && !run.skippedDetails.length && !run.reviewDetails.length && (
                <p className="text-xs text-muted-foreground">
                  {run.created
                    ? "Everything it found was imported."
                    : run.recordsFound
                      ? "Everything it found was already in your books."
                      : "Nothing new since the last sync."}
                </p>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {run && (
            <Button variant="ghost" size="sm" render={<Link href={`/integrations/${run.connectionId}`} />}>
              <ExternalLink className="size-3.5" /> Connection
            </Button>
          )}
          {retryable && (
            <Button size="sm" variant="outline" loading={retrying} onClick={() => void retry()}>
              <RotateCw className="size-3.5" /> Retry
            </Button>
          )}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
