"use client";

import { DEFAULT_REMINDER_OFFSETS, formatDay, relativeDays, today } from "@expensewise/core";
import { Ban, CalendarClock, CheckCircle2, MoreHorizontal, Paperclip, Pause, Pencil, Play, Receipt, Trash2, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryChip, EmptyNote, Facts, Section, StatCard } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { clientApi, errorMessage } from "@/lib/api/client";
import { fileUrl } from "@/lib/api/files";
import type { OccurrenceView, SubscriptionDetail } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { ConfirmDialog, OccurrenceTable } from "./occurrence-history";
import { MarkPaidDialog, type PayTarget, SkipDialog, type SkipTarget, undoPayment } from "./payment-dialogs";
import { AutoRenewBadge, DueDate, Field, PriceChangeBadge, renewalStatement } from "./shared";
import { SubscriptionFormDialog } from "./subscription-form";
import { StatusMenu } from "./subscription-status";

export function SubscriptionDetailView({ subscription: s }: { subscription: SubscriptionDetail }) {
  const { money, canWrite, workspace, isBusiness } = useApp();
  const router = useRouter();
  const id = useId();
  const day = today(workspace.timezone);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const [skipping, setSkipping] = useState<SkipTarget | null>(null);
  const [undoing, setUndoing] = useState<OccurrenceView | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(s.expiryDate ?? s.nextRenewalDate ?? day);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const statement = renewalStatement(s, money);
  const stopped = s.derivedStatus === "cancelled" || s.derivedStatus === "cancellation_pending" || s.derivedStatus === "expired";
  const paused = s.derivedStatus === "paused";
  const next = s.renewals.find((o) => o.id === s.nextOccurrenceId) ?? null;

  const payTarget = (o: OccurrenceView): PayTarget => ({
    occurrenceId: o.id,
    name: s.name,
    dueDate: o.dueDate,
    amount: o.amount,
    currency: o.currency,
    accountId: s.accountId,
    direction: "out",
    renewal: true,
  });

  const act = async (key: string, path: string, body: unknown, message: string) => {
    setBusy(key);
    try {
      await clientApi(path, { method: "POST", body });
      toast.success(message);
      invalidateApiCache("/subscriptions");
      router.refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (
      await act(
        "cancel",
        `/subscriptions/${s.id}/cancel`,
        { effectiveDate: effectiveDate || null, reason: reason.trim() || null },
        "Subscription cancelled; the history is kept",
      )
    ) {
      setCancelOpen(false);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      const result = await clientApi<{ deleted: boolean; ended: boolean }>(`/subscriptions/${s.id}`, { method: "DELETE" });
      toast.success(result.deleted ? "Subscription deleted" : "It has payment history, so it was cancelled and kept");
      invalidateApiCache("/subscriptions");
      if (result.deleted) router.push("/subscriptions");
      router.refresh();
      setDeleteOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reminders = s.reminderOffsets?.length ? s.reminderOffsets : (workspace.settings.reminderOffsets ?? DEFAULT_REMINDER_OFFSETS);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusMenu subscription={s} today={day} />
                <AutoRenewBadge autoRenew={s.autoRenew} />
                {s.categoryName && <CategoryChip name={s.categoryName} icon={s.categoryIcon} />}
              </div>
              <p className="mt-2 text-3xl font-semibold tabular-nums">{money(s.amount, s.currency)}</p>
              <p className="text-sm text-muted-foreground">
                {s.billingLabel}
                {s.currency !== s.baseCurrency && s.baseAmount !== null ? ` · ≈ ${money(s.baseAmount)}` : ""} ·{" "}
                {money(s.monthlyEquivalentBase ?? s.monthlyEquivalent, s.monthlyEquivalentBase !== null ? undefined : s.currency)}/month
              </p>
            </div>
            {canWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button aria-label="More actions" size="icon-sm" variant="ghost" />}>
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <Pencil className="size-3.5" /> Edit
                  </DropdownMenuItem>
                  {!stopped &&
                    (paused ? (
                      <DropdownMenuItem onClick={() => void act("resume", `/subscriptions/${s.id}/resume`, undefined, "Resumed")}>
                        <Play className="size-3.5" /> Resume
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => void act("pause", `/subscriptions/${s.id}/pause`, undefined, "Paused; reminders stop until you resume")}>
                        <Pause className="size-3.5" /> Pause
                      </DropdownMenuItem>
                    ))}
                  {stopped ? (
                    <DropdownMenuItem onClick={() => void act("resume", `/subscriptions/${s.id}/resume`, undefined, "Reactivated")}>
                      <Play className="size-3.5" /> Reactivate
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => setCancelOpen(true)}>
                      <Ban className="size-3.5" /> Cancel subscription
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="size-3.5" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <p
            className={cn(
              "rounded-lg px-3 py-2 text-sm",
              statement.tone === "info" && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
              statement.tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
              statement.tone === "muted" && "bg-muted text-muted-foreground",
            )}
          >
            {statement.text}
          </p>

          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {next && (
                <Button size="sm" onClick={() => setPaying(payTarget(next))}>
                  <CheckCircle2 className="size-3.5" /> Mark {formatDay(next.dueDate, "short")} as paid
                </Button>
              )}
              {next && (
                <Button size="sm" variant="outline" onClick={() => setSkipping({ occurrenceId: next.id, name: s.name, dueDate: next.dueDate })}>
                  Skip
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              {!stopped && (
                <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
                  <Ban className="size-3.5" /> Cancel
                </Button>
              )}
            </div>
          )}
        </div>

        <Section title="Details">
          <Facts
            items={[
              { label: "Provider", value: s.provider },
              s.planName ? { label: "Plan", value: s.planName } : false,
              { label: "Next renewal", value: <DueDate date={s.nextRenewalDate} today={day} /> },
              { label: "Expiry date", value: s.expiryDate ? <DueDate date={s.expiryDate} today={day} /> : "—" },
              { label: "Cancellation deadline", value: s.cancellationDeadline ? <DueDate date={s.cancellationDeadline} today={day} /> : "None" },
              s.trialEndsOn ? { label: "Trial ends", value: <DueDate date={s.trialEndsOn} today={day} /> } : false,
              { label: "Purchased", value: s.purchaseDate ? formatDay(s.purchaseDate) : "—" },
              { label: "Started", value: s.startDate ? formatDay(s.startDate) : "—" },
              s.cancelledAt ? { label: "Cancelled", value: formatDay(s.cancelledAt.slice(0, 10)) } : false,
              { label: "Paid from", value: s.accountName ?? "—" },
              { label: "Category", value: s.categoryName ?? "Uncategorized" },
              isBusiness ? { label: "Project", value: s.projectName ?? "No project" } : false,
              {
                label: "Annual cost",
                value: <span className="tabular-nums">{money(s.annualCostBase ?? s.annualCost, s.annualCostBase !== null ? undefined : s.currency)}</span>,
              },
              {
                label: "Reminders",
                value: `${reminders.map((o) => (o === 0 ? "on the day" : `${o}d`)).join(", ")}${s.reminderOffsets?.length ? "" : " (default)"}`,
              },
              {
                label: "Invoice",
                value: s.attachmentFileId ? (
                  <a
                    href={fileUrl(s.attachmentFileId)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    <Paperclip className="size-3.5" aria-hidden /> Open
                  </a>
                ) : canWrite ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Attach
                  </button>
                ) : (
                  "—"
                ),
              },
            ]}
          />
          {s.notes && <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm">{s.notes}</p>}
        </Section>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={Receipt}
          label="Renewals paid"
          value={s.stats.paidCount}
          hint={s.stats.skippedCount ? `${s.stats.skippedCount} skipped` : "Since the purchase"}
        />
        <StatCard
          icon={Wallet}
          label="Total paid"
          value={money(s.stats.totalPaidBase)}
          hint="From the linked transactions"
          href={s.stats.transactionsHref ?? undefined}
        />
        <StatCard
          icon={CalendarClock}
          label="Last paid"
          value={s.stats.lastPaidOn ? formatDay(s.stats.lastPaidOn, "short") : "—"}
          hint={s.stats.lastPaidOn ? relativeDays(s.stats.lastPaidOn, day) : "No payment yet"}
        />
        <StatCard
          icon={TrendingUp}
          label="Price changes"
          value={s.priceChanges.length}
          hint={
            s.priceChanges[0]
              ? `Latest ${s.priceChanges[0].percent !== null ? `${s.priceChanges[0].percent > 0 ? "+" : ""}${s.priceChanges[0].percent}%` : ""}`
              : "Same price so far"
          }
          tone={s.priceChanges[0]?.direction === "increase" ? "warn" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <Section
          title="Renewal history"
          hint="Each renewal with the transaction that paid it"
          href={s.stats.transactionsHref ?? undefined}
          linkLabel="All payments"
        >
          <OccurrenceTable
            renewal
            occurrences={s.renewals}
            canWrite={canWrite}
            onPay={(o) => setPaying(payTarget(o))}
            onSkip={(o) => setSkipping({ occurrenceId: o.id, name: s.name, dueDate: o.dueDate })}
            onUndo={setUndoing}
          />
        </Section>
        <div className="space-y-4">
          <Section title="Upcoming renewals">
            {s.upcomingRenewals.length === 0 ? (
              <EmptyNote>No renewals scheduled.</EmptyNote>
            ) : (
              <ul className="divide-y divide-border">
                {s.upcomingRenewals.map((r) => (
                  <li key={r.date} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <DueDate date={r.date} today={day} />
                    <span className="font-medium tabular-nums">{money(r.amount, r.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {s.priceChanges.length > 0 && (
            <Section title="Price changes">
              <ul className="space-y-2">
                {s.priceChanges.map((p) => (
                  <li key={p.occurrenceId} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span>{formatDay(p.paidOn ?? p.dueDate)}</span>
                      <PriceChangeBadge change={p} money={money} currency={p.currency} />
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {p.previousTransactionId ? (
                        <Link className="hover:text-foreground hover:underline" href={`/transactions?period=all_time&ids=${p.previousTransactionId}`}>
                          {money(p.previous, p.currency)}
                        </Link>
                      ) : (
                        money(p.previous, p.currency)
                      )}{" "}
                      →{" "}
                      {p.transactionId ? (
                        <Link className="hover:text-foreground hover:underline" href={`/transactions?period=all_time&ids=${p.transactionId}`}>
                          {money(p.current, p.currency)}
                        </Link>
                      ) : (
                        money(p.current, p.currency)
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>

      <SubscriptionFormDialog open={editing} onOpenChange={setEditing} subscription={s} />
      <MarkPaidDialog target={paying} onClose={() => setPaying(null)} />
      <SkipDialog target={skipping} onClose={() => setSkipping(null)} />
      <ConfirmDialog
        open={undoing !== null}
        onOpenChange={(open) => !open && setUndoing(null)}
        title="Undo this payment?"
        description={
          undoing?.transaction?.createdByPayment
            ? "The renewal goes back to scheduled and the transaction recorded for it is voided."
            : undoing?.transaction
              ? "The renewal goes back to scheduled. The linked transaction stays in your ledger, just no longer attached to this renewal."
              : "The renewal goes back to scheduled."
        }
        confirmLabel="Undo payment"
        busy={busy === "undo"}
        onConfirm={async () => {
          if (!undoing) return;
          setBusy("undo");
          if (await undoPayment(undoing.id, router)) setUndoing(null);
          setBusy(null);
        }}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel ${s.name}?`}
        description="Renewals and reminders stop. You'll still get a notice before access ends, and the payment history stays."
        confirmLabel="Cancel subscription"
        busy={busy === "cancel"}
        onConfirm={() => void cancel()}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Access ends" htmlFor={`${id}-effective`}>
            <Input id={`${id}-effective`} type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </Field>
          <Field label="Reason" htmlFor={`${id}-reason`}>
            <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${s.name}?`}
        description={
          s.stats.paidCount
            ? "It has payment history, so it will be cancelled and kept rather than deleted. Transactions are never removed."
            : "It has no payments, so it is removed completely."
        }
        confirmLabel={s.stats.paidCount ? "Cancel and keep" : "Delete"}
        busy={busy === "delete"}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
