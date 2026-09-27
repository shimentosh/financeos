"use client";

import { formatDay, minorToInput, parseMoneyInput, today } from "@expensewise/core";
import { AlertTriangle, ExternalLink, Link2, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog as CenterDialog,
  DialogFooter as CenterFooter,
  DialogHeader as CenterHeader,
  DialogPanel as CenterPanel,
  DialogPopup as CenterPopup,
  DialogTitle as CenterTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import { ApiError } from "@/lib/api/shared";
import type { DuplicateIssues, MarkPaidBody, MarkPaidResult, PaymentCandidate } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { accountOptions, Field, FormError, fromOption, NONE, OptionSelect, useCatalog } from "./shared";

/** What a payment dialog needs to know about the due payment. */
export type PayTarget = {
  occurrenceId: string;
  name: string;
  dueDate: string;
  amount: number;
  currency: string;
  accountId: string | null;
  direction: "in" | "out";
  /** Subscriptions talk about renewals; everything else about payments. */
  renewal?: boolean;
};

function refreshPlanning(router: ReturnType<typeof useRouter>) {
  invalidateApiCache("/commitments");
  invalidateApiCache("/subscriptions");
  router.refresh();
}

/**
 * Records a due payment. When a matching transaction already exists the API
 * answers 409 with candidates: the user links one ("Link this payment") or
 * records a new one anyway. A different amount can become the new expected
 * amount for future payments.
 */
export function MarkPaidDialog({ target, onClose, onDone }: { target: PayTarget | null; onClose: () => void; onDone?: (result: MarkPaidResult) => void }) {
  const id = useId();
  const router = useRouter();
  const { money, workspace, isBusiness } = useApp();
  const { accounts } = useCatalog({ projects: isBusiness });
  const [paidOn, setPaidOn] = useState(today(workspace.timezone));
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [updateFuture, setUpdateFuture] = useState(false);
  const [candidates, setCandidates] = useState<PaymentCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    const day = today(workspace.timezone);
    setPaidOn(target.dueDate < day ? target.dueDate : day);
    setAmount(minorToInput(target.amount, target.currency));
    setAccountId(target.accountId);
    setNote("");
    setAttachments([]);
    setUpdateFuture(false);
    setCandidates(null);
    setError(null);
  }, [target, workspace.timezone]);

  const parsed = target ? parseMoneyInput(amount || "0", target.currency) : null;
  const changed = target !== null && parsed !== null && parsed > 0 && parsed !== target.amount;
  const noun = target?.renewal ? "renewal" : target?.direction === "in" ? "receipt" : "payment";

  const send = async (extra: Pick<MarkPaidBody, "existingTransactionId" | "force"> = {}, key = "save") => {
    if (!target) return;
    setError(null);
    if (!extra.existingTransactionId && (parsed === null || parsed <= 0)) return setError("Enter the amount paid, e.g. 1,850");
    setBusy(key);
    try {
      const body: MarkPaidBody = {
        paidOn,
        amount: parsed ?? undefined,
        currency: target.currency,
        accountId,
        note: note.trim() || null,
        updateFutureAmount: changed && updateFuture,
        attachmentFileIds: attachments.length ? attachments.map((file) => file.id) : undefined,
        ...extra,
      };
      const result = await clientApi<MarkPaidResult>(`/occurrences/${target.occurrenceId}/pay`, { method: "POST", body });
      toast.success(result.created ? `${target.name} ${noun} recorded` : `${target.name} linked to the existing transaction`, {
        description: result.commitment.nextDueDate ? `Next due ${formatDay(result.commitment.nextDueDate)}` : undefined,
      });
      if (result.priceChange) {
        const pct = result.priceChange.percent === null ? "" : ` (${result.priceChange.percent > 0 ? "+" : ""}${result.priceChange.percent}%)`;
        toast.info(`Price changed${pct}`, {
          description: `${money(result.priceChange.previous, target.currency)} → ${money(result.priceChange.current, target.currency)}. ${result.amountUpdated ? "Future payments use the new amount." : "Future payments still expect the old amount."}`,
        });
      }
      refreshPlanning(router);
      setAttachments([]);
      onDone?.(result);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "possible_duplicate") {
        const issues = err.body?.issues as unknown as DuplicateIssues | undefined;
        setCandidates(issues?.candidates ?? []);
      } else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };

  // Receipts uploaded for a payment that was never recorded are removed again.
  const cancel = () => {
    discardNewAttachments(attachments);
    setAttachments([]);
    onClose();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && cancel()}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{target ? `Record ${target.name} ${noun}` : "Record payment"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {target && (
              <p className="text-sm text-muted-foreground">
                Due {formatDay(target.dueDate)} · expected {money(target.amount, target.currency)}
              </p>
            )}
            {candidates && (
              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="size-4" /> This {noun} may already be recorded
                </p>
                <p className="text-xs text-muted-foreground">
                  Link the matching transaction so the money is counted once, or record a new one if it really is a separate payment.
                </p>
                <ul className="space-y-2">
                  {candidates.map((candidate) => (
                    <li key={candidate.id} className="rounded-md border border-border bg-card p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{candidate.merchant ?? candidate.description ?? "Transaction"}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDay(candidate.date)} · {candidate.accountName ?? "No account"} · {Math.round(candidate.score * 100)}% match
                          </p>
                          <p className="text-[11px] text-muted-foreground">{candidate.reasons.join(" · ")}</p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">{money(candidate.amount, candidate.currency)}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="xs"
                          loading={busy === candidate.id}
                          onClick={() => void send({ existingTransactionId: candidate.id }, candidate.id)}
                        >
                          <Link2 className="size-3.5" /> Link this payment
                        </Button>
                        <Link
                          href={candidate.href}
                          target="_blank"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          View <ExternalLink className="size-3" />
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
                <Button type="button" size="xs" variant="outline" loading={busy === "force"} onClick={() => void send({ force: true }, "force")}>
                  <Plus className="size-3.5" /> Create new anyway
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={target?.direction === "in" ? "Received on" : "Paid on"} htmlFor={`${id}-date`}>
                <Input
                  id={`${id}-date`}
                  type="date"
                  required
                  value={paidOn}
                  onChange={(e) => {
                    setPaidOn(e.target.value);
                    setCandidates(null);
                  }}
                />
              </Field>
              <Field label={`Amount (${target?.currency ?? ""})`} htmlFor={`${id}-amount`}>
                <Input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setCandidates(null);
                  }}
                />
              </Field>
            </div>
            {changed && target && parsed !== null && (
              <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <Checkbox checked={updateFuture} onCheckedChange={(checked) => setUpdateFuture(checked === true)} className="mt-0.5" />
                <span>
                  Use {money(parsed, target.currency)} for future {target.renewal ? "renewals" : "payments"} too
                  <span className="block text-xs text-muted-foreground">
                    Otherwise only this {noun} changes; the next one still expects {money(target.amount, target.currency)}.
                  </span>
                </span>
              </label>
            )}
            <Field label={target?.direction === "in" ? "Into account" : "Paid from"} htmlFor={`${id}-account`}>
              <OptionSelect
                id={`${id}-account`}
                value={accountId ?? NONE}
                onChange={(v) => setAccountId(fromOption(v))}
                options={accountOptions(accounts, "Choose an account")}
                placeholder="Choose an account"
              />
            </Field>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </Field>
            <AttachmentField
              value={attachments}
              onChange={setAttachments}
              label={target?.direction === "in" ? "Proof of payment" : "Receipt or invoice"}
              hint="Optional. Saved with the transaction this records."
            />
            <FormError message={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy === "save"} disabled={Boolean(candidates)}>
              Record {noun}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export type SkipTarget = { occurrenceId: string; name: string; dueDate: string };

/** Skip one due payment (it will not be recorded); the schedule moves on. */
export function SkipDialog({ target, onClose }: { target: SkipTarget | null; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the note whenever another payment is chosen
  useEffect(() => setNote(""), [target]);
  const skip = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await clientApi(`/occurrences/${target.occurrenceId}/skip`, { method: "POST", body: { note: note.trim() || null } });
      toast.success(`Skipped ${target.name} for ${formatDay(target.dueDate)}`);
      refreshPlanning(router);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CenterDialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <CenterPopup className="max-w-sm">
        <CenterHeader>
          <CenterTitle>Skip {target?.name}?</CenterTitle>
        </CenterHeader>
        <CenterPanel className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The {target ? formatDay(target.dueDate) : ""} payment is marked as skipped and no transaction is recorded. The next one is scheduled as usual.
          </p>
          <Field label="Why (optional)" htmlFor={`${id}-note`}>
            <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Paid in cash, waived this month…" />
          </Field>
        </CenterPanel>
        <CenterFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Keep it
          </Button>
          <Button size="sm" loading={busy} onClick={() => void skip()}>
            Skip payment
          </Button>
        </CenterFooter>
      </CenterPopup>
    </CenterDialog>
  );
}

/** Puts a paid or skipped occurrence back to scheduled. */
export async function undoPayment(occurrenceId: string, router: ReturnType<typeof useRouter>) {
  try {
    const result = await clientApi<{ voidedTransactionId: string | null; unlinkedTransactionId: string | null }>(`/occurrences/${occurrenceId}/undo`, {
      method: "POST",
      body: {},
    });
    toast.success(
      result.voidedTransactionId
        ? "Payment undone; its transaction was voided"
        : result.unlinkedTransactionId
          ? "Payment undone; the transaction stays in the ledger, unlinked"
          : "Back to scheduled",
    );
    refreshPlanning(router);
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  }
}

/** The small "Record / Skip" pair on a due row. */
export function DueActions({ onPay, onSkip, className, compact }: { onPay: () => void; onSkip: () => void; className?: string; compact?: boolean }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      <Button size="xs" variant="outline" onClick={onPay}>
        {compact ? "Paid" : "Mark paid"}
      </Button>
      <Button size="xs" variant="ghost" onClick={onSkip}>
        Skip
      </Button>
    </div>
  );
}
