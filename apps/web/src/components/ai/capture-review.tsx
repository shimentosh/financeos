"use client";

import { today } from "@expensewise/core";
import { AlertTriangle, ArrowLeft, Camera, Copy, ExternalLink, FileText, Minus, Plus, Repeat, RotateCcw, Sparkles, Trash2, ZoomIn } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { clientApi, errorMessage } from "@/lib/api/client";
import { ApiError } from "@/lib/api/shared";
import type { Account, Category, Project } from "@/lib/api/types";
import type { CaptureConfirmResult, CaptureView, DuplicateConflict } from "@/lib/api/types/ai";
import { cn } from "@/lib/cn";
import { formatDateTime, formatDay } from "@/lib/format";
import { toast } from "@/lib/toast";
import { blankRow, DraftEditor, type DraftRow, rowFromDraft, rowToItem } from "./draft-editor";
import { CAPTURE_KIND, Callout, StageBadge, transactionsHref, usd } from "./shared";
import { SubscriptionCard, type SubscriptionDecision, subscriptionBody, subscriptionForm } from "./subscription-card";

const READING = new Set(["received", "processing"]);
const FINISHED = new Set(["confirmed", "posted", "discarded"]);

function buildRows(view: CaptureView, defaults: { currency: string; date: string; accountId?: string }): DraftRow[] {
  const rows = view.drafts.map(rowFromDraft);
  const reviewable = view.capture.stage === "suggested" || view.capture.stage === "failed";
  if (!rows.length && reviewable && view.capture.method !== "duplicate") rows.push(blankRow("manual-0", defaults));
  return rows;
}

/**
 * The review screen: what was read, beside the file it was read from. Every
 * field shows how sure the reader was and where the value came from; nothing
 * is posted until "Confirm & post".
 */
export function CaptureReview({
  initial,
  accounts,
  categories,
  projects,
  from,
}: {
  initial: CaptureView;
  accounts: Account[];
  categories: Category[];
  projects: Project[];
  from: string | null;
}) {
  const router = useRouter();
  const { workspace, canWrite, money } = useApp();
  const [view, setView] = useState(initial);
  const defaults = useMemo(
    () => ({ currency: workspace.baseCurrency, date: today(workspace.timezone), accountId: accounts.length === 1 ? accounts[0]?.id : undefined }),
    [workspace.baseCurrency, workspace.timezone, accounts],
  );
  const [rows, setRows] = useState<DraftRow[]>(() => buildRows(initial, defaults));
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const suggestion = view.subscription;
  const [showSub, setShowSub] = useState(Boolean(suggestion));
  const [subDecision, setSubDecision] = useState<SubscriptionDecision>(suggestion ? "later" : "track");
  const [subForm, setSubForm] = useState(() => subscriptionForm(suggestion, workspace.baseCurrency));
  const [subError, setSubError] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<"confirm" | "discard" | "retry" | null>(null);
  const [conflicts, setConflicts] = useState<{ items: DuplicateConflict[]; keys: string[] } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const manualCount = useRef(1);

  const stage = view.capture.stage;
  const reading = READING.has(stage);
  const readOnly = !canWrite || FINISHED.has(stage) || reading;
  const back = from === "inbox" ? "/ai/inbox" : "/capture";
  const kind = CAPTURE_KIND[view.capture.kind];

  // Rebuild the form whenever a new reading arrives (after polling or a retry).
  const version = `${view.capture.stage}:${view.capture.processedAt ?? ""}:${view.drafts.map((d) => d.transaction.id).join(",")}`;
  const lastVersion = useRef(version);
  useEffect(() => {
    if (lastVersion.current === version) return;
    lastVersion.current = version;
    setRows(buildRows(view, defaults));
    setRowErrors({});
    setConflicts(null);
    if (view.subscription) {
      setShowSub(true);
      setSubDecision("later");
      setSubForm(subscriptionForm(view.subscription, workspace.baseCurrency));
    }
  }, [version, view, defaults, workspace.baseCurrency]);

  // While it is still being read, check back every 1.5 seconds.
  useEffect(() => {
    if (!reading) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await clientApi<CaptureView>(`/captures/${view.capture.id}`);
        if (!cancelled && !READING.has(next.capture.stage)) setView(next);
      } catch {
        // The next tick tries again.
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reading, view.capture.id]);

  const updateRow = (next: DraftRow) => {
    setRows((current) => current.map((row) => (row.key === next.key ? next : row)));
    setRowErrors((current) => {
      const { [next.key]: _, ...rest } = current;
      return rest;
    });
  };

  const addRow = (seed?: { merchant?: string | null; date?: string | null }) => {
    const key = `manual-${manualCount.current++}`;
    setRows((current) => [...current, blankRow(key, { ...defaults, merchant: seed?.merchant, date: seed?.date ?? defaults.date })]);
  };

  const confirm = async (allowDuplicates = false) => {
    const active = rows.filter((row) => row.include && !row.posted);
    if (!active.length) return toast.error("Include at least one transaction", { description: "Or discard the capture if there is nothing to record." });
    const errors: Record<string, string> = {};
    const items: Record<string, unknown>[] = [];
    for (const row of active) {
      const result = rowToItem(row);
      if (result.ok) items.push(result.item);
      else errors[row.key] = result.error;
    }
    setRowErrors(errors);
    if (Object.keys(errors).length) return toast.error("Some details are missing", { description: "Check the highlighted transactions." });
    const sub = subscriptionBody(showSub ? subDecision : "later", subForm);
    if (!sub.ok) {
      setSubError(sub.error);
      return;
    }
    setSubError(null);
    setBusy("confirm");
    try {
      const result = await clientApi<CaptureConfirmResult>(`/captures/${view.capture.id}/confirm`, {
        method: "POST",
        body: { transactions: items, rememberMerchant: remember, allowDuplicates, ...(sub.value !== undefined ? { subscription: sub.value } : {}) },
      });
      const posted = result.postedTransactionIds;
      toast.success(posted.length === 1 ? "Posted to the ledger" : `${posted.length} transactions posted`, {
        action: posted.length ? { label: "View", onClick: () => router.push(transactionsHref(posted)) } : undefined,
      });
      const subscription = result.subscription;
      if (subscription.status === "created") {
        toast.success("Subscription tracked", {
          description: "Renewal reminders are on.",
          action: { label: "Open", onClick: () => router.push(`/subscriptions/${subscription.subscriptionId}`) },
        });
      } else if (subscription.status === "failed") {
        toast.warning("Posted, but the subscription wasn't created", { description: `${subscription.message}. It is waiting in the AI Inbox.` });
      } else if (subscription.status === "deferred") {
        toast.info("Subscription question saved to the AI Inbox");
      }
      router.push(back);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "possible_duplicate") {
        setConflicts({ items: (error.body?.issues as unknown as DuplicateConflict[] | undefined) ?? [], keys: active.map((row) => row.key) });
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy("discard");
    try {
      await clientApi(`/captures/${view.capture.id}/discard`, { method: "POST", body: {} });
      toast.success("Capture discarded");
      setDiscardOpen(false);
      router.push(back);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    try {
      const next = await clientApi<CaptureView>(`/captures/${view.capture.id}/retry`, { method: "POST", body: { force: Boolean(view.duplicateOf) } });
      setView(next);
      if (next.capture.stage === "failed") toast.error(next.capture.error ?? "Still couldn't read it");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const postedIds = view.postedTransactionIds;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{kind.label}</h1>
            <StageBadge stage={stage} />
            {view.capture.isSubscription && (
              <span className="inline-flex items-center gap-1 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-700 dark:text-violet-300">
                <Repeat className="size-3" /> Subscription
              </span>
            )}
          </div>
          <MethodLine view={view} />
        </div>
        <Button size="sm" variant="ghost" render={<Link href={back} />}>
          <ArrowLeft className="size-3.5" /> {from === "inbox" ? "AI Inbox" : "Capture"}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <Preview view={view} className="lg:sticky lg:top-14" />

        <div className="flex min-w-0 flex-col gap-4">
          {reading && (
            <div className="space-y-3 rounded-xl border border-border bg-card p-4" aria-live="polite">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Spinner className="size-4" /> Reading this capture…
              </p>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}

          {stage === "failed" && (
            <Callout
              tone="danger"
              title="Couldn't read this automatically"
              action={
                canWrite && view.capture.retryable ? (
                  <Button size="xs" variant="outline" loading={busy === "retry"} onClick={() => void retry()}>
                    <RotateCcw className="size-3" /> Try again
                  </Button>
                ) : undefined
              }
            >
              {view.capture.error ?? "Something went wrong."} You can enter the details below from the file.
            </Callout>
          )}

          {view.duplicateOf && (stage === "suggested" || stage === "failed") && (
            <Callout
              tone="warn"
              icon={Copy}
              title={`You captured this exact file on ${formatDateTime(view.duplicateOf.capturedAt)}`}
              action={
                <Button size="xs" variant="outline" render={<Link href={`/capture/${view.duplicateOf.captureId}`} />}>
                  Open it
                </Button>
              }
            >
              It wasn't read again, so nothing was charged twice.{" "}
              {view.duplicateOf.transactionIds.length > 0 && (
                <Link href={transactionsHref(view.duplicateOf.transactionIds)} className="underline underline-offset-4">
                  See its transactions
                </Link>
              )}
              {canWrite && (
                <span className="mt-2 flex flex-wrap gap-2">
                  <Button size="xs" variant="outline" loading={busy === "retry"} onClick={() => void retry()}>
                    <RotateCcw className="size-3" /> Read it again anyway
                  </Button>
                  {!rows.length && (
                    <Button size="xs" variant="ghost" onClick={() => addRow()}>
                      Enter by hand
                    </Button>
                  )}
                </span>
              )}
            </Callout>
          )}

          {view.capture.method === "manual" && view.capture.fallbackReason && stage === "suggested" && (
            <Callout tone="info" title="Enter the details from the file">
              {view.capture.fallbackReason}. Everything else still works: rules, merchant memory and duplicate checks run when you post.
            </Callout>
          )}

          {view.capture.notes.length > 0 && !readOnly && (
            <div className="rounded-xl border border-border bg-card px-4 py-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="size-3.5" /> What the reader noticed
              </p>
              <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
                {view.capture.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          {view.unresolved.length > 0 && !readOnly && (
            <Callout tone="warn" title="Some amounts couldn't be read">
              <ul className="mt-1 space-y-1">
                {view.unresolved.map((line) => (
                  <li key={line.index} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {line.merchant ?? "A payment"}
                      {line.date ? ` on ${formatDay(line.date)}` : ""}
                    </span>
                    <Button size="xs" variant="outline" onClick={() => addRow({ merchant: line.merchant, date: line.date })}>
                      <Plus className="size-3" /> Add it
                    </Button>
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {rows.map((row, index) => (
            <DraftEditor
              key={row.key}
              row={row}
              index={index}
              count={rows.length}
              accounts={accounts}
              categories={categories}
              projects={projects}
              readOnly={readOnly}
              error={rowErrors[row.key]}
              onChange={updateRow}
              onRemove={row.id ? undefined : () => setRows((current) => current.filter((r) => r.key !== row.key))}
            />
          ))}

          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => addRow()}>
                <Plus className="size-3.5" /> Add a transaction by hand
              </Button>
              {!showSub && (
                <Button size="sm" variant="ghost" onClick={() => setShowSub(true)}>
                  <Repeat className="size-3.5" /> This is a subscription
                </Button>
              )}
            </div>
          )}

          {showSub && !readOnly && (
            <SubscriptionCard
              suggestion={suggestion}
              decision={subDecision}
              onDecision={setSubDecision}
              form={subForm}
              onForm={setSubForm}
              disabled={busy !== null}
              error={subError}
            />
          )}

          {conflicts && (
            <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" role="alert">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" /> These look like transactions already in your books
              </p>
              <ul className="space-y-2 text-xs">
                {conflicts.items.map((conflict) => {
                  const row = rows.find((r) => r.key === conflicts.keys[conflict.index]);
                  return (
                    <li key={conflict.index} className="space-y-1">
                      <p className="font-medium">{row?.merchant || row?.description || `Transaction ${conflict.index + 1}`}</p>
                      {conflict.matches.map((match) => (
                        <Link
                          key={match.transactionId}
                          href={transactionsHref([match.transactionId])}
                          className="block text-muted-foreground underline-offset-4 hover:underline"
                        >
                          {formatDay(match.date)} · {money(match.amount, match.currency)} · {match.merchant ?? "—"} — {match.reasons.join(", ")}
                        </Link>
                      ))}
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={busy === "confirm"} onClick={() => void confirm(true)}>
                  Post anyway
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConflicts(null)}>
                  Let me check
                </Button>
              </div>
            </div>
          )}

          {FINISHED.has(stage) ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
              <p className="text-sm text-muted-foreground">
                {stage === "discarded"
                  ? "This capture was discarded; nothing from it is in your books."
                  : `${postedIds.length} transaction${postedIds.length === 1 ? "" : "s"} posted${view.capture.confirmedAt ? ` on ${formatDateTime(view.capture.confirmedAt)}` : ""}.`}
              </p>
              <div className="flex gap-2">
                {postedIds.length > 0 && (
                  <Button size="sm" variant="outline" render={<Link href={transactionsHref(postedIds)} />}>
                    View transactions <ExternalLink className="size-3.5" />
                  </Button>
                )}
                <Button size="sm" render={<Link href="/capture" />}>
                  <Camera className="size-3.5" /> Capture another
                </Button>
              </div>
            </div>
          ) : (
            canWrite &&
            !reading && (
              <div className="sticky bottom-[calc(var(--tab-bar-total)+0.5rem)] z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2">
                  <Checkbox id="capture-remember" checked={remember} onCheckedChange={(checked) => setRemember(Boolean(checked))} />
                  <Label htmlFor="capture-remember" className="font-normal">
                    Remember this merchant
                  </Label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="destructive-outline" onClick={() => setDiscardOpen(true)} disabled={busy !== null}>
                    <Trash2 className="size-3.5" /> Discard
                  </Button>
                  {(view.capture.retryable || view.duplicateOf) && stage !== "failed" && (
                    <Button size="sm" variant="outline" loading={busy === "retry"} disabled={busy !== null} onClick={() => void retry()}>
                      <RotateCcw className="size-3.5" /> Read again
                    </Button>
                  )}
                  <Button
                    size="sm"
                    loading={busy === "confirm"}
                    disabled={busy !== null || !rows.some((r) => r.include && !r.posted)}
                    onClick={() => void confirm(false)}
                  >
                    Confirm &amp; post
                  </Button>
                </div>
              </div>
            )
          )}
        </div>
      </div>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this capture?</AlertDialogTitle>
            <AlertDialogDescription>Its drafts are removed and nothing is posted. The file stays attached to the capture record.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" size="sm" loading={busy === "discard"} onClick={() => void discard()}>
              Discard
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function MethodLine({ view }: { view: CaptureView }) {
  const c = view.capture;
  const seconds = c.durationMs ? `${(c.durationMs / 1000).toFixed(1)} s` : null;
  let text: string;
  if (c.method === "ai") text = ["Read by AI", c.model, seconds, c.costUsd > 0 ? usd(c.costUsd) : null].filter(Boolean).join(" · ");
  else if (c.method === "parser") text = "Read by the built-in parser, no AI used";
  else if (c.method === "duplicate") text = "Not read: the same file was captured before";
  else if (c.method === "manual") text = "Enter the details by hand";
  else if (READING.has(c.stage)) text = "Reading…";
  else text = `Captured ${formatDateTime(c.createdAt)}`;
  return (
    <p className="text-xs text-muted-foreground">
      {text}
      {c.method && ` · captured ${formatDateTime(c.createdAt)}`}
    </p>
  );
}

const ZOOMS = [1, 1.5, 2, 3];

function Preview({ view, className }: { view: CaptureView; className?: string }) {
  const [zoom, setZoom] = useState(0);
  const [broken, setBroken] = useState(false);
  const c = view.capture;
  const file = c.file;
  const isImage = file?.contentType.startsWith("image/") && !broken;

  if (!c.fileUrl) {
    return (
      <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{c.kind === "voice" ? "What you said" : "What you wrote"}</p>
        <blockquote className="whitespace-pre-wrap border-s-2 border-violet-500/50 ps-3 text-base leading-relaxed">{c.inputText}</blockquote>
      </div>
    );
  }

  if (!isImage) {
    return (
      <div className={cn("flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-4 py-10 text-center", className)}>
        <FileText className="size-10 text-muted-foreground" />
        <div>
          <p className="truncate text-sm font-medium">{file?.filename ?? "File"}</p>
          <p className="text-xs text-muted-foreground">{broken ? "This image can't be shown in the browser (for example HEIC)." : "PDFs open in a new tab."}</p>
        </div>
        <Button size="sm" variant="outline" render={<a href={c.fileUrl} target="_blank" rel="noreferrer" />}>
          Open file <ExternalLink className="size-3.5" />
        </Button>
      </div>
    );
  }

  const scale = ZOOMS[zoom] ?? 1;
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">{file?.filename}</span>
        <div className="flex items-center gap-0.5">
          <Button size="icon-xs" variant="ghost" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
            <Minus className="size-3.5" />
          </Button>
          <span className="w-9 text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom in"
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Open full size" render={<a href={c.fileUrl} target="_blank" rel="noreferrer" />}>
            <ZoomIn className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="max-h-80 overflow-auto bg-muted/40 lg:max-h-[calc(100vh-10rem)]">
        <button
          type="button"
          aria-label={scale === 1 ? "Zoom in" : "Zoom out"}
          onClick={() => setZoom((z) => (z === 0 ? 2 : 0))}
          className={cn("block", scale === 1 ? "cursor-zoom-in" : "cursor-zoom-out")}
          style={{ width: `${scale * 100}%` }}
        >
          {/* biome-ignore lint/performance/noImgElement: authenticated file route, not a static asset */}
          <img src={c.fileUrl} alt={`${CAPTURE_KIND[c.kind].label} being reviewed`} onError={() => setBroken(true)} className="block h-auto w-full" />
        </button>
      </div>
    </div>
  );
}
