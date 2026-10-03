"use client";

import { monthKey, TYPE_LABELS } from "@financeos/core";
import { AlertTriangle, Check, FileText, Loader2, Paperclip, Pencil, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { ConfidenceMeter, Facts, StatusBadge } from "@/components/app/blocks";
import { TransactionFormDialog } from "@/components/app/transaction-form";
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
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { clientApi, errorMessage } from "@/lib/api/client";
import { ATTACHMENT_ACCEPT, attachmentProblem, deleteFile, fileUrl, uploadFile } from "@/lib/api/files";
import type { TransactionDetail } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatBytes, formatDateTime, formatDay, titleFromKind } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import { toast } from "@/lib/toast";

const ACTION_LABELS: Record<string, string> = {
  "transaction.created": "Created",
  "transaction.imported": "Imported",
  "transaction.updated": "Edited",
  "transaction.amount_changed": "Amount changed",
  "transaction.confirmed": "Confirmed and posted",
  "transaction.deleted": "Deleted",
};

export function TransactionDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (transactionId: string) => {
    setError(null);
    try {
      setDetail(await clientApi<TransactionDetail>(`/transactions/${transactionId}`));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the open transaction changes
  useEffect(() => {
    setDetail(null);
    if (id) void load(id);
  }, [id]);

  const confirm = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await clientApi(`/transactions/${detail.id}/confirm`, { method: "POST", body: {} });
      toast.success("Posted to the ledger");
      await load(detail.id);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await clientApi(`/transactions/${detail.id}`, { method: "DELETE", body: { reason: "Deleted by user" } });
      toast.success("Transaction deleted");
      setConfirmDelete(false);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const incoming = detail && detail.type !== "transfer" && detail.direction === "in";
  const fields = detail?.aiConfidence?.fields ?? {};

  return (
    <>
      <Dialog open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
        <DialogPopup className="w-full max-w-lg">
          <DialogHeader>
            <DialogTitle>{detail ? (detail.counterpartyName ?? detail.merchant ?? TYPE_LABELS[detail.type]) : "Transaction"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            {error && <p className="text-sm text-destructive-foreground">{error}</p>}
            {!detail && !error && (
              <div className="space-y-3">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {detail && (
              <>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className={cn("text-3xl font-semibold tabular-nums", incoming && "text-money-in")}>
                      {detail.type === "transfer"
                        ? money(detail.amount, detail.currency)
                        : money(incoming ? detail.amount : -detail.amount, detail.currency, { signed: Boolean(incoming) })}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{TYPE_LABELS[detail.type]}</span>
                      <span>·</span>
                      {detail.type === "income" ? (
                        <span>
                          Profit month {formatMonth(monthKey(detail.date))} · recorded {formatDateTime(detail.createdAt)}
                        </span>
                      ) : (
                        <span>{formatDay(detail.date, "long")}</span>
                      )}
                      <StatusBadge status={detail.status} label={detail.status === "draft" ? "Needs review" : undefined} />
                    </div>
                  </div>
                  {detail.aiConfidence && <ConfidenceMeter value={detail.aiConfidence.overall} />}
                </div>

                {detail.reviewReason && detail.status !== "posted" && (
                  <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {detail.reviewReason}
                  </p>
                )}

                {detail.possibleDuplicates.length > 0 && (
                  <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="size-4" /> Possible duplicate
                    </p>
                    {detail.possibleDuplicates.map((match) => (
                      <p key={match.id} className="text-xs text-muted-foreground">
                        {formatDay(match.transaction.date)} · {money(match.transaction.amount, match.transaction.currency)} ·{" "}
                        {match.transaction.merchant ?? match.transaction.description ?? "—"} — {match.reasons.join(", ")} ({Math.round(match.score * 100)}%)
                      </p>
                    ))}
                  </div>
                )}

                <Facts
                  items={[
                    detail.type === "transfer"
                      ? { label: "From → to", value: `${detail.accountName ?? "—"} → ${detail.toAccountName ?? "—"}` }
                      : { label: "Account", value: detail.accountName ?? "—" },
                    detail.type !== "transfer" && {
                      label: "Category",
                      value: (
                        <span className="inline-flex items-center gap-2">
                          {detail.categoryName ?? "Uncategorized"}
                          {fields.category !== undefined && <ConfidenceMeter value={fields.category} />}
                        </span>
                      ),
                    },
                    detail.projectName ? { label: "Project", value: detail.projectName } : false,
                    detail.merchant ? { label: "Merchant", value: detail.merchant } : false,
                    detail.reference ? { label: "Reference", value: <span className="font-mono text-xs">{detail.reference}</span> } : false,
                    { label: "Source", value: titleFromKind(detail.source) },
                    detail.description ? { label: "Description", value: detail.description } : false,
                  ]}
                />

                {(detail.currency !== detail.baseCurrency || (detail.accountAmount !== null && detail.accountAmount !== detail.amount)) && (
                  <div className="rounded-lg border border-border p-3 text-sm">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Currency</p>
                    <Facts
                      items={[
                        { label: "Original", value: money(detail.amount, detail.currency) },
                        detail.accountAmount !== null && detail.accountCurrency
                          ? { label: "Charged to account", value: money(detail.accountAmount, detail.accountCurrency) }
                          : false,
                        detail.baseAmount !== null ? { label: "In base currency", value: money(detail.baseAmount, detail.baseCurrency ?? undefined) } : false,
                        detail.fxRate
                          ? {
                              label: "Rate used",
                              value: `1 ${detail.currency} = ${Number(detail.fxRate).toLocaleString("en", { maximumFractionDigits: 4 })} ${detail.baseCurrency}`,
                            }
                          : false,
                      ]}
                    />
                  </div>
                )}

                {detail.notes && <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm">{detail.notes}</p>}

                {detail.commitment && (
                  <p className="text-sm">
                    Pays <span className="font-medium">{detail.commitment.name}</span> due {formatDay(detail.commitment.dueDate)}.{" "}
                    <Link href={`/commitments?focus=${detail.commitment.commitmentId}`} className="text-muted-foreground underline-offset-4 hover:underline">
                      View commitment
                    </Link>
                  </p>
                )}

                <DetailAttachments
                  transactionId={detail.id}
                  attachments={detail.attachments}
                  canEdit={canWrite && detail.status !== "void"}
                  onChanged={() => {
                    void load(detail.id);
                    router.refresh();
                  }}
                />

                {detail.entries.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Ledger entries</p>
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-xs">
                        <tbody className="divide-y divide-border">
                          {detail.entries.map((entry) => (
                            <tr key={entry.id} className="[&>td]:px-3 [&>td]:py-1.5">
                              <td>{entry.accountName}</td>
                              <td className={cn("text-right tabular-nums", entry.amount > 0 && "text-money-in")}>
                                {money(entry.amount, entry.currency, { signed: true })}
                              </td>
                              <td className="text-right text-muted-foreground tabular-nums">
                                {money(entry.baseAmount, detail.baseCurrency ?? undefined, { signed: true })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">History</p>
                  <ol className="relative space-y-2 border-s border-border ps-4">
                    {detail.history.map((event) => (
                      <li key={event.id} className="text-xs">
                        <span className="absolute -start-1 mt-1 size-2 rounded-full bg-border" />
                        <span className="font-medium">{ACTION_LABELS[event.action] ?? titleFromKind(event.action.split(".").pop() ?? event.action)}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {event.actorType === "user" ? "you" : event.actorType} · {formatDateTime(event.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </DialogPanel>
          {detail && canWrite && detail.status !== "void" && (
            <DialogFooter className="justify-between">
              <Button variant="destructive-outline" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" /> Edit
                </Button>
                {detail.status !== "posted" && (
                  <Button size="sm" loading={busy} onClick={() => void confirm()}>
                    <Check className="size-3.5" /> Confirm
                  </Button>
                )}
              </div>
            </DialogFooter>
          )}
        </DialogPopup>
      </Dialog>

      <TransactionFormDialog
        open={editing}
        onOpenChange={setEditing}
        transaction={detail}
        attachments={detail?.attachments}
        onSaved={() => {
          if (detail) void load(detail.id);
        }}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this transaction?</AlertDialogTitle>
            <AlertDialogDescription>
              Its ledger entries are removed and balances change. The record stays in the audit log, and an integration will not import it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" size="sm" loading={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * The invoices and receipts behind a transaction: open them, attach another
 * (it is linked at once), or unlink one. Unlinking keeps the file, which a
 * capture or another record may still use.
 */
function DetailAttachments({
  transactionId,
  attachments,
  canEdit,
  onChanged,
}: {
  transactionId: string;
  attachments: TransactionDetail["attachments"];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const link = async (ids: string[], message: string) => {
    await clientApi(`/transactions/${transactionId}`, { method: "PATCH", body: { attachmentFileIds: ids } });
    toast.success(message);
    onChanged();
  };

  const attach = async (files: File[]) => {
    if (!files.length) return;
    const room = 10 - attachments.length;
    const chosen = files.slice(0, room);
    const problem = chosen.map((file) => attachmentProblem(file)).find(Boolean);
    if (problem) return void toast.error(problem);
    setBusy(true);
    const uploaded: string[] = [];
    try {
      for (const file of chosen) uploaded.push((await uploadFile(file, "receipt")).id);
      await link([...attachments.map((file) => file.id), ...uploaded], uploaded.length === 1 ? "File attached" : `${uploaded.length} files attached`);
    } catch (error) {
      for (const id of uploaded) void deleteFile(id).catch(() => undefined);
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (id: string) => {
    setBusy(true);
    try {
      await link(
        attachments.filter((file) => file.id !== id).map((file) => file.id),
        "Attachment removed from this transaction",
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (!attachments.length && !canEdit) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Attachments</p>
        {canEdit && attachments.length > 0 && attachments.length < 10 && (
          <Button size="xs" variant="ghost" onClick={() => input.current?.click()} loading={busy}>
            <Paperclip aria-hidden /> Attach
          </Button>
        )}
      </div>
      {attachments.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {attachments.map((file) => (
            <div key={file.id} className="group relative min-w-0">
              {file.contentType.startsWith("image/") && !/hei[cf]/.test(file.contentType) ? (
                <a href={fileUrl(file.id)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border">
                  {/* biome-ignore lint/performance/noImgElement: authenticated file route, not a static asset */}
                  <img src={fileUrl(file.id)} alt={file.filename} className="h-32 w-full object-cover" />
                </a>
              ) : (
                <a
                  href={fileUrl(file.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 pe-9 text-sm hover:bg-accent/40"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate">{file.filename}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
                  </span>
                </a>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void unlink(file.id)}
                  disabled={busy}
                  className="absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground opacity-0 shadow-xs transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                  aria-label={`Remove ${file.filename} from this transaction`}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void attach([...event.dataTransfer.files]);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Paperclip className="size-4" aria-hidden />}
          Attach the invoice or receipt
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          void attach(chosen);
        }}
      />
    </div>
  );
}
