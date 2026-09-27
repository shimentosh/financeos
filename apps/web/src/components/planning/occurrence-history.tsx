"use client";

import { formatDay } from "@expensewise/core";
import { ArrowRight, Undo2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, StatusBadge } from "@/components/app/blocks";
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
import type { OccurrenceView } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { DueActions } from "./payment-dialogs";
import { PriceChangeBadge } from "./shared";

/** A stop-sign confirmation (delete, cancel, end). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  destructive = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  destructive?: boolean;
  children?: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children && <div className="space-y-3 px-6 pb-2">{children}</div>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>Keep it</AlertDialogClose>
          <Button variant={destructive ? "destructive" : "default"} size="sm" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const STATUS_LABEL: Record<string, string> = { scheduled: "Scheduled", paid: "Paid", skipped: "Skipped", cancelled: "Cancelled" };

/**
 * Every due instance, newest first: what was expected, what was paid and
 * when, the transaction that settled it, and any price change against the
 * payment before.
 */
export function OccurrenceTable({
  occurrences,
  onPay,
  onSkip,
  onUndo,
  canWrite,
  renewal,
}: {
  occurrences: OccurrenceView[];
  onPay: (occurrence: OccurrenceView) => void;
  onSkip: (occurrence: OccurrenceView) => void;
  onUndo: (occurrence: OccurrenceView) => void;
  canWrite: boolean;
  renewal?: boolean;
}) {
  const { money } = useApp();
  const byId = new Map(occurrences.map((o) => [o.id, o]));
  if (occurrences.length === 0) return <EmptyNote>Nothing recorded yet. Payments appear here as they fall due.</EmptyNote>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>{renewal ? "Renewal" : "Due"}</th>
            <th className="hidden sm:table-cell">Status</th>
            <th className="text-right!">Amount</th>
            <th className="hidden md:table-cell">Transaction</th>
            <th className="w-28" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {occurrences.map((o) => {
            const previous = o.priceChange ? byId.get(o.priceChange.previousOccurrenceId) : undefined;
            return (
              <tr key={o.id} className={cn(o.overdue && "bg-red-500/5")}>
                <td className="px-3 py-2">
                  <div className="tabular-nums">{formatDay(o.dueDate)}</div>
                  {o.paidOn && o.paidOn !== o.dueDate && <div className="text-xs text-muted-foreground">Paid {formatDay(o.paidOn)}</div>}
                  {o.note && <div className="max-w-56 truncate text-xs text-muted-foreground">{o.note}</div>}
                  <div className="sm:hidden">
                    <StatusBadge status={o.overdue ? "overdue" : o.status} label={o.overdue ? "Not recorded" : STATUS_LABEL[o.status]} />
                  </div>
                </td>
                <td className="hidden px-3 py-2 sm:table-cell">
                  <StatusBadge status={o.overdue ? "overdue" : o.status} label={o.overdue ? "Payment not recorded" : STATUS_LABEL[o.status]} />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="font-medium tabular-nums">{money(o.paidAmount ?? o.amount, o.currency)}</div>
                  {o.status === "paid" && o.paidAmount !== null && o.paidAmount !== o.amount && !o.priceChange && (
                    <div className="text-[11px] text-muted-foreground tabular-nums">expected {money(o.amount, o.currency)}</div>
                  )}
                  {o.priceChange && (
                    <div className="mt-0.5 flex flex-wrap items-center justify-end gap-1 text-[11px] text-muted-foreground">
                      <PriceChangeBadge change={o.priceChange} money={money} currency={o.currency} />
                      {o.priceChange.previousTransactionId ? (
                        <Link
                          href={previous?.transaction?.href ?? `/transactions?period=all_time&ids=${o.priceChange.previousTransactionId}`}
                          className="tabular-nums hover:text-foreground hover:underline"
                        >
                          {money(o.priceChange.previous, o.currency)}
                        </Link>
                      ) : (
                        <span className="tabular-nums">{money(o.priceChange.previous, o.currency)}</span>
                      )}
                      <ArrowRight className="size-3" />
                      {o.transaction ? (
                        <Link href={o.transaction.href} className="tabular-nums hover:text-foreground hover:underline">
                          {money(o.priceChange.current, o.currency)}
                        </Link>
                      ) : (
                        <span className="tabular-nums">{money(o.priceChange.current, o.currency)}</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="hidden px-3 py-2 md:table-cell">
                  {o.transaction ? (
                    <Link href={o.transaction.href} className="group block min-w-0">
                      <span className="block truncate text-xs group-hover:underline">
                        {o.transaction.accountName ?? "Transaction"} · {formatDay(o.transaction.date, "short")}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {o.transaction.status === "void" ? "Voided" : o.transaction.createdByPayment ? "Recorded here" : "Linked existing"}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {canWrite && o.status === "scheduled" && <DueActions compact onPay={() => onPay(o)} onSkip={() => onSkip(o)} className="justify-end" />}
                  {canWrite && (o.status === "paid" || o.status === "skipped") && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onUndo(o)}
                      title={o.transaction?.createdByPayment ? "Voids the transaction this payment created" : "Unlinks; the transaction stays"}
                    >
                      <Undo2 className="size-3.5" /> Undo
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
