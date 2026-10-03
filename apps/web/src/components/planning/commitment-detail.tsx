"use client";

import { formatDay, today } from "@financeos/core";
import { ExternalLink, Pause, Pencil, Play, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Facts, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { CommitmentDetail, OccurrenceView } from "@/lib/api/types/planning";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { CommitmentFormDialog } from "./commitment-form";
import { ConfirmDialog, OccurrenceTable } from "./occurrence-history";
import { MarkPaidDialog, type PayTarget, SkipDialog, type SkipTarget, undoPayment } from "./payment-dialogs";
import { DueDate, KindIcon } from "./shared";

/** One commitment: schedule, payment history, stats and every action on it. */
export function CommitmentDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { money, canWrite, workspace, isBusiness } = useApp();
  const router = useRouter();
  const day = today(workspace.timezone);
  const [detail, setDetail] = useState<CommitmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const [skipping, setSkipping] = useState<SkipTarget | null>(null);
  const [undoing, setUndoing] = useState<OccurrenceView | null>(null);
  const [confirm, setConfirm] = useState<"end" | "delete" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (commitmentId: string) => {
    setError(null);
    try {
      setDetail(await clientApi<CommitmentDetail>(`/commitments/${commitmentId}`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    if (id) void load(id);
  }, [id, load]);

  const reload = () => {
    if (id) void load(id);
    invalidateApiCache("/commitments");
    router.refresh();
  };

  const act = async (key: string, path: string, method: "POST" | "DELETE", message: string) => {
    setBusy(key);
    try {
      const result = await clientApi<{ deleted?: boolean }>(path, { method });
      toast.success(message);
      if (key === "delete" && result?.deleted) {
        onClose();
        invalidateApiCache("/commitments");
        router.refresh();
      } else reload();
      setConfirm(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const payTarget = (o: OccurrenceView): PayTarget | null =>
    detail
      ? {
          occurrenceId: o.id,
          name: detail.name,
          dueDate: o.dueDate,
          amount: o.amount,
          currency: o.currency,
          accountId: detail.accountId,
          direction: detail.direction,
          renewal: Boolean(detail.subscriptionId),
        }
      : null;

  const c = detail;
  return (
    <>
      <Dialog open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
        <DialogPopup className="w-full max-w-xl">
          <DialogHeader>
            <DialogTitle>{c?.name ?? "Commitment"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            {error && <p className="text-sm text-destructive-foreground">{error}</p>}
            {!c && !error && (
              <div className="space-y-3">
                <Skeleton className="h-10 w-48" />
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            )}
            {c && (
              <>
                <div className="flex items-start gap-3">
                  <KindIcon kind={c.kind} direction={c.direction} className="size-10" />
                  <div className="min-w-0 flex-1">
                    <p className={c.direction === "in" ? "text-2xl font-semibold tabular-nums text-money-in" : "text-2xl font-semibold tabular-nums"}>
                      {money(c.amount, c.currency)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {c.kindLabel} · {c.frequencyLabel}
                      {c.currency !== c.baseCurrency && c.baseAmount !== null ? ` · ≈ ${money(c.baseAmount)}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={c.overdue ? "overdue" : c.status} label={c.overdue ? "Payment not recorded" : undefined} />
                      {c.autoPay && <StatusBadge status="scheduled" label={c.direction === "in" ? "Arrives automatically" : "Auto-pay"} />}
                    </div>
                  </div>
                </div>

                {c.subscriptionId && (
                  <p className="flex items-center justify-between gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-sm text-sky-700 dark:text-sky-300">
                    This is a subscription: plan, expiry and cancellation deadline live on its page.
                    <Link
                      href={`/subscriptions/${c.subscriptionId}`}
                      className="inline-flex shrink-0 items-center gap-1 font-medium underline-offset-4 hover:underline"
                    >
                      Open <ExternalLink className="size-3.5" />
                    </Link>
                  </p>
                )}

                {canWrite && (
                  <div className="flex flex-wrap gap-2">
                    {c.nextOccurrence && c.status === "active" && (
                      <Button
                        size="sm"
                        onClick={() => {
                          const occurrence = c.occurrences.find((o) => o.id === c.nextOccurrence?.id);
                          if (occurrence) setPaying(payTarget(occurrence));
                        }}
                      >
                        Mark {formatDay(c.nextOccurrence.dueDate, "short")} as {c.direction === "in" ? "received" : "paid"}
                      </Button>
                    )}
                    {!c.subscriptionId && (
                      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                        <Pencil className="size-3.5" /> Edit
                      </Button>
                    )}
                    {c.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy === "pause"}
                        onClick={() => void act("pause", `/commitments/${c.id}/pause`, "POST", "Paused; no reminders until you resume")}
                      >
                        <Pause className="size-3.5" /> Pause
                      </Button>
                    )}
                    {c.status !== "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy === "resume"}
                        onClick={() => void act("resume", `/commitments/${c.id}/resume`, "POST", "Resumed")}
                      >
                        <Play className="size-3.5" /> Resume
                      </Button>
                    )}
                    {c.status !== "ended" && (
                      <Button size="sm" variant="ghost" onClick={() => setConfirm("end")}>
                        <Square className="size-3.5" /> End
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setConfirm("delete")}>
                      <Trash2 className="size-3.5" /> Delete
                    </Button>
                  </div>
                )}

                <Facts
                  items={[
                    {
                      label: "Next due",
                      value:
                        c.status === "active" ? (
                          <DueDate date={c.nextOccurrence?.dueDate ?? c.nextDueDate} today={day} />
                        ) : c.status === "paused" ? (
                          "Paused"
                        ) : (
                          "Ended"
                        ),
                    },
                    { label: c.direction === "in" ? "From" : "Paid to", value: c.payee ?? c.counterpartyName ?? "—" },
                    { label: c.direction === "in" ? "Into" : "Paid from", value: c.accountName ?? "—" },
                    c.liabilityName ? { label: "Loan", value: c.liabilityName } : { label: "Category", value: c.categoryName ?? "Uncategorized" },
                    isBusiness ? { label: "Project", value: c.projectName ?? "No project" } : false,
                    { label: "Schedule", value: `${formatDay(c.startDate)}${c.endDate ? ` → ${formatDay(c.endDate)}` : ""}` },
                    {
                      label: "Monthly equivalent",
                      value: (
                        <span className="tabular-nums">
                          {money(c.monthlyEquivalentBase ?? c.monthlyEquivalent, c.monthlyEquivalentBase !== null ? undefined : c.currency)}
                        </span>
                      ),
                    },
                    {
                      label: "A year",
                      value: (
                        <span className="tabular-nums">{money(c.annualizedBase ?? c.annualized, c.annualizedBase !== null ? undefined : c.currency)}</span>
                      ),
                    },
                    { label: "Reminders", value: c.effectiveReminderOffsets.map((o) => (o === 0 ? "on the day" : `${o}d`)).join(", ") || "None" },
                    {
                      label: "Paid so far",
                      value: c.stats.transactionsHref ? (
                        <Link
                          href={c.stats.transactionsHref}
                          className="tabular-nums hover:underline"
                        >{`${c.stats.paidCount} · ${money(c.stats.totalPaidBase)}`}</Link>
                      ) : (
                        "Nothing yet"
                      ),
                    },
                  ]}
                />
                {c.notes && <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm">{c.notes}</p>}

                {c.upcoming.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Coming up</p>
                    <div className="flex flex-wrap gap-1.5">
                      {c.upcoming.map((u) => (
                        <span key={u.date} className="rounded-md bg-muted px-2 py-1 text-xs tabular-nums">
                          {formatDay(u.date, "short")} · {money(u.amount, u.currency)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">History</p>
                  <OccurrenceTable
                    occurrences={c.occurrences}
                    canWrite={canWrite}
                    renewal={Boolean(c.subscriptionId)}
                    onPay={(o) => setPaying(payTarget(o))}
                    onSkip={(o) => setSkipping({ occurrenceId: o.id, name: c.name, dueDate: o.dueDate })}
                    onUndo={setUndoing}
                  />
                </div>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <CommitmentFormDialog open={editing} onOpenChange={setEditing} commitment={c} onSaved={() => reload()} />
      <MarkPaidDialog target={paying} onClose={() => setPaying(null)} onDone={() => reload()} />
      <SkipDialog
        target={skipping}
        onClose={() => {
          setSkipping(null);
          reload();
        }}
      />
      <ConfirmDialog
        open={undoing !== null}
        onOpenChange={(open) => !open && setUndoing(null)}
        title="Undo this payment?"
        description={
          undoing?.transaction?.createdByPayment
            ? "It goes back to scheduled and the transaction recorded for it is voided."
            : "It goes back to scheduled. A linked transaction stays in your ledger, unlinked."
        }
        confirmLabel="Undo payment"
        busy={busy === "undo"}
        onConfirm={async () => {
          if (!undoing) return;
          setBusy("undo");
          if (await undoPayment(undoing.id, router)) {
            setUndoing(null);
            reload();
          }
          setBusy(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "end"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`End ${c?.name ?? "this commitment"}?`}
        description="No more payments are expected or reminded. Paid history stays; you can resume it later."
        confirmLabel="End commitment"
        busy={busy === "end"}
        onConfirm={() => c && void act("end", `/commitments/${c.id}/end`, "POST", "Ended; the history is kept")}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete ${c?.name ?? "this commitment"}?`}
        description={
          c?.stats.paidCount
            ? "It has payment history, so it will be ended and kept instead. Transactions are never removed."
            : "It has no payments, so it is removed completely."
        }
        confirmLabel={c?.stats.paidCount ? "End and keep" : "Delete"}
        busy={busy === "delete"}
        onConfirm={() =>
          c && void act("delete", `/commitments/${c.id}`, "DELETE", c.stats.paidCount ? "It has history, so it was ended and kept" : "Commitment deleted")
        }
      />
    </>
  );
}
