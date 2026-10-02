"use client";

import { formatDay, minorToInput, today } from "@expensewise/core";
import { AlarmClock, CircleAlert, CircleCheck, FileText, HandCoins, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { EmptyNote, EmptyState, Facts, ProgressBar, Section, StatCard, StatusBadge, type Tone } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";

import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { AgingBucket, Receivable, ReceivableDetail, ReceivableKind, ReceivableList, ReceivableStatus } from "@/lib/api/types/wealth";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import {
  AccountSelect,
  CategorySelect,
  ConfirmDialog,
  CurrencySelect,
  Field,
  FormError,
  LinkedTransactions,
  MoneyInput,
  NewParamOpener,
  ParamTabs,
  ProjectSelect,
  RECEIVABLE_KIND_LABELS,
  SwitchRow,
  toMinor,
  useFocusHighlight,
  useRefresh,
} from "./shared";

const STATUS_TABS: Array<{ value: "all" | ReceivableStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "pending", label: "Pending" },
  { value: "partially_paid", label: "Partly paid" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

const BUCKETS: Array<{ key: AgingBucket; label: string; tone: Tone }> = [
  { key: "current", label: "Not yet due", tone: "good" },
  { key: "0-30", label: "1–30 days late", tone: "warn" },
  { key: "31-60", label: "31–60 days", tone: "warn" },
  { key: "61-90", label: "61–90 days", tone: "danger" },
  { key: "90+", label: "Over 90 days", tone: "danger" },
];

function DueLine({ item }: { item: Receivable }) {
  if (item.status === "paid")
    return (
      <span className="text-xs text-muted-foreground">
        Paid
        {item.lastPaymentDate ? ` ${formatDay(item.lastPaymentDate, "short")}` : ""}
      </span>
    );
  if (item.status === "cancelled") return <span className="text-xs text-muted-foreground">Cancelled</span>;
  if (item.status === "overdue") return <span className="text-xs font-medium text-red-600 dark:text-red-400">{item.daysOverdue} days overdue</span>;
  return <span className="text-xs text-muted-foreground">{item.dueDate ? `Due ${formatDay(item.dueDate, "short")}` : "No due date"}</span>;
}

// ------------------------------------------------------------------- list

export function ReceivablesView({ list, status, focus, projectFilter }: { list: ReceivableList; status: string; focus?: string; projectFilter?: boolean }) {
  const { money, canWrite, isBusiness } = useApp();
  const [creating, setCreating] = useState<ReceivableKind | null>(null);
  const [paying, setPaying] = useState<Receivable | null>(null);
  const openCreate = useCallback(() => setCreating("invoice"), []);
  const highlighted = useFocusHighlight(focus);
  const { totals } = list;
  const items = status === "all" ? list.items : list.items.filter((item) => item.status === status);

  const dialogs = (
    <>
      <Suspense>
        <NewParamOpener onNew={openCreate} />
      </Suspense>
      <ReceivableFormDialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)} defaultKind={creating ?? "invoice"} />
      {paying && <ReceivablePaymentDialog open onOpenChange={(open) => !open && setPaying(null)} receivable={paying} />}
    </>
  );

  const createButtons = canWrite ? (
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={() => setCreating("invoice")}>
        <FileText className="size-3.5" /> Add invoice
      </Button>
      <Button size="sm" variant="outline" onClick={() => setCreating("loan")}>
        <HandCoins className="size-3.5" /> Record money lent
      </Button>
    </div>
  ) : undefined;

  if (list.items.length === 0 && !projectFilter) {
    return (
      <>
        <EmptyState
          icon={HandCoins}
          title="Keep track of money owed to you"
          description="Invoices a client has not paid yet, or money you lent to a friend. Record payments as they arrive; overdue ones reach your AI Inbox at 1, 7 and 30 days."
          action={createButtons}
        />
        {dialogs}
      </>
    );
  }

  const agingMax = Math.max(1, ...BUCKETS.map((b) => totals.aging[b.key]));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Owed to you"
          value={money(totals.outstanding)}
          hint={`${totals.byStatus.pending.count + totals.byStatus.partially_paid.count + totals.byStatus.overdue.count} open`}
          tone="good"
        />
        <StatCard
          icon={AlarmClock}
          label="Overdue"
          value={money(totals.overdueAmount)}
          hint={totals.overdueCount ? `${totals.overdueCount} past due` : "Nothing overdue"}
          tone={totals.overdueCount ? "danger" : "default"}
          href={totals.overdueCount ? "/wealth/receivables?status=overdue" : undefined}
        />
        <StatCard
          icon={CircleAlert}
          label="Partly paid"
          value={money(totals.byStatus.partially_paid.outstanding)}
          hint={`${totals.byStatus.partially_paid.count} still open`}
          href="/wealth/receivables?status=partially_paid"
        />
        <StatCard
          icon={CircleCheck}
          label="Paid in full"
          value={String(totals.byStatus.paid.count)}
          hint={money(totals.byStatus.paid.amount)}
          href="/wealth/receivables?status=paid"
        />
      </div>

      <Section title="Ageing" hint="What is still owed, by how late it is">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {BUCKETS.map((bucket) => (
            <div key={bucket.key} className="min-w-0 space-y-1">
              <p className="truncate text-xs text-muted-foreground">{bucket.label}</p>
              <p
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  bucket.tone === "danger" && totals.aging[bucket.key] > 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {money(totals.aging[bucket.key])}
              </p>
              <ProgressBar value={(totals.aging[bucket.key] / agingMax) * 100} tone={bucket.tone} />
            </div>
          ))}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-2">
        <ParamTabs
          param="status"
          label="Status"
          value={status}
          options={STATUS_TABS.map((t) => ({
            ...t,
            count: t.value === "all" ? list.items.length : totals.byStatus[t.value].count,
          }))}
        />
        {projectFilter && (
          <Link href="/wealth/receivables" className="rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent">
            One project only ✕
          </Link>
        )}
        {canWrite && (
          <div className="ms-auto flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setCreating("loan")}>
              <HandCoins className="size-3.5" /> Lend money
            </Button>
          </div>
        )}
      </div>

      {list.unconvertible.length > 0 && (
        <Link
          href="/settings/currency"
          className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
        >
          <CircleAlert className="size-3.5 shrink-0" />
          {list.unconvertible.map((u) => `${u.title} (${u.currency})`).join(", ")} — no exchange rate, left out of the totals. Add a rate.
        </Link>
      )}

      {items.length === 0 ? (
        <EmptyNote>Nothing {STATUS_TABS.find((t) => t.value === status)?.label.toLowerCase() ?? ""} right now.</EmptyNote>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Owed by</th>
                <th className="hidden md:table-cell">Due</th>
                {isBusiness && <th className="hidden lg:table-cell">Project</th>}
                <th className="hidden text-right! md:table-cell">Amount</th>
                <th className="text-right!">Remaining</th>
                <th className="hidden w-28 sm:table-cell">Status</th>
                {canWrite && <th className="w-16" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr
                  key={item.id}
                  data-focus-id={item.id}
                  className={cn("transition-colors [&>td]:px-3 [&>td]:py-2", highlighted === item.id && "bg-amber-500/10")}
                >
                  <td className="min-w-0">
                    <Link href={`/wealth/receivables/${item.id}`} className="block truncate font-medium hover:underline underline-offset-4">
                      {item.counterpartyName}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[item.title, item.reference, item.kind !== "invoice" ? RECEIVABLE_KIND_LABELS[item.kind] : null].filter(Boolean).join(" · ")}
                    </span>
                    <span className="md:hidden">
                      <DueLine item={item} />
                    </span>
                  </td>
                  <td className="hidden md:table-cell">
                    <DueLine item={item} />
                  </td>
                  {isBusiness && <td className="hidden text-xs text-muted-foreground lg:table-cell">{item.projectName ?? "—"}</td>}
                  <td className="hidden text-right tabular-nums md:table-cell">{money(item.amount, item.currency)}</td>
                  <td className="text-right">
                    <span className="block font-medium tabular-nums">{money(item.remaining, item.currency)}</span>
                    {item.paid > 0 && item.remaining > 0 && (
                      <span className="block text-xs text-muted-foreground tabular-nums">{money(item.paid, item.currency)} paid</span>
                    )}
                  </td>
                  <td className="hidden sm:table-cell">
                    <StatusBadge status={item.status} />
                  </td>
                  {canWrite && (
                    <td className="text-right">
                      {item.remaining > 0 && item.status !== "cancelled" && (
                        <Button size="xs" variant="outline" onClick={() => setPaying(item)}>
                          Paid
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialogs}
    </div>
  );
}

export function AddReceivableButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add invoice
      </Button>
      <ReceivableFormDialog open={open} onOpenChange={setOpen} defaultKind="invoice" />
    </>
  );
}

// ------------------------------------------------------------------- forms

export function ReceivableFormDialog({
  open,
  onOpenChange,
  receivable,
  defaultKind = "invoice",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receivable?: Receivable | null;
  defaultKind?: ReceivableKind;
}) {
  const id = useId();
  const router = useRouter();
  const refresh = useRefresh();
  const { workspace, isBusiness } = useApp();
  const [kind, setKind] = useState<ReceivableKind>(defaultKind);
  const [counterparty, setCounterparty] = useState("");
  const [title, setTitle] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [issueDate, setIssueDate] = useState(today(workspace.timezone));
  const [dueDate, setDueDate] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [fromAccount, setFromAccount] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setKind(receivable?.kind ?? defaultKind);
    setCounterparty(receivable?.counterpartyName ?? "");
    setTitle(receivable?.title ?? "");
    setReference(receivable?.reference ?? "");
    setAmount(receivable ? minorToInput(receivable.amount, receivable.currency) : "");
    setCurrency(receivable?.currency ?? workspace.baseCurrency);
    setIssueDate(receivable?.issueDate ?? today(workspace.timezone));
    setDueDate(receivable?.dueDate ?? "");
    setCategoryId(receivable?.categoryId ?? null);
    setProjectId(receivable?.projectId ?? null);
    setNotes(receivable?.notes ?? "");
    setFromAccount(true);
    setAccountId(null);
  }, [open, receivable, defaultKind, workspace.baseCurrency, workspace.timezone]);

  const invoice = kind === "invoice";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const minor = toMinor(amount, currency);
    if (!minor) return setError("Enter the amount owed");
    if (!receivable && !invoice && fromAccount && !accountId) return setError("Choose the account the money left");
    const body = {
      kind,
      counterpartyName: counterparty.trim(),
      title: title.trim() || (invoice ? `Invoice ${reference.trim()}`.trim() : `Loan to ${counterparty.trim()}`),
      reference: reference.trim() || null,
      amount: minor,
      currency,
      issueDate,
      dueDate: dueDate || null,
      categoryId: invoice ? categoryId : null,
      projectId,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      if (receivable) {
        await clientApi(`/receivables/${receivable.id}`, {
          method: "PATCH",
          body,
        });
        toast.success("Saved");
        refresh();
      } else {
        const created = await clientApi<ReceivableDetail>("/receivables", {
          method: "POST",
          body: {
            ...body,
            lentFromAccountId: !invoice && fromAccount ? accountId : null,
          },
        });
        toast.success(invoice ? "Invoice added" : "Loan recorded");
        refresh();
        router.push(`/wealth/receivables/${created.id}`);
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{receivable ? "Edit receivable" : invoice ? "Add invoice" : "Record money lent"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {!receivable && (
              <div className="flex gap-1.5">
                {(["invoice", "loan", "other"] as const).map((k) => (
                  <Button key={k} type="button" size="xs" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)}>
                    {RECEIVABLE_KIND_LABELS[k]}
                  </Button>
                ))}
              </div>
            )}
            <Field label={invoice ? "Customer" : "Who owes you"} htmlFor={`${id}-who`}>
              <Input
                id={`${id}-who`}
                required
                maxLength={120}
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder={invoice ? "Acme Ltd" : "Rafiq"}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="For" htmlFor={`${id}-title`}>
                <Input
                  id={`${id}-title`}
                  maxLength={160}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={invoice ? "Website build" : "Short-term loan"}
                />
              </Field>
              <Field label={invoice ? "Invoice no." : "Reference"} htmlFor={`${id}-ref`}>
                <Input id={`${id}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder={invoice ? "INV-001" : "Optional"} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount" htmlFor={`${id}-amount`}>
                <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={currency} required />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <CurrencySelect id={`${id}-currency`} value={currency} onChange={setCurrency} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={invoice ? "Issued" : "Lent on"} htmlFor={`${id}-issued`}>
                <Input id={`${id}-issued`} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
              </Field>
              <Field label="Due" htmlFor={`${id}-due`}>
                <Input id={`${id}-due`} type="date" value={dueDate} min={issueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            </div>
            {invoice && (
              <Field label="Income category" htmlFor={`${id}-category`} hint="Payments are recorded as income here, when they arrive.">
                <CategorySelect id={`${id}-category`} kind="income" value={categoryId} onChange={setCategoryId} enabled={open} />
              </Field>
            )}
            {isBusiness && (
              <Field label="Project" htmlFor={`${id}-project`}>
                <ProjectSelect id={`${id}-project`} value={projectId} onChange={setProjectId} enabled={open} />
              </Field>
            )}
            {!receivable && !invoice && (
              <div className="space-y-2 rounded-lg border border-border px-3 py-2">
                <SwitchRow
                  id={`${id}-lent`}
                  title="The money left one of my accounts"
                  hint="Recorded as a loan out — not an expense."
                  checked={fromAccount}
                  onCheckedChange={setFromAccount}
                />
                {fromAccount && <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} enabled={open} />}
              </div>
            )}
            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {receivable ? "Save" : invoice ? "Add invoice" : "Record loan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function ReceivablePaymentDialog({ open, onOpenChange, receivable }: { open: boolean; onOpenChange: (open: boolean) => void; receivable: Receivable }) {
  const id = useId();
  const refresh = useRefresh();
  const { workspace, money } = useApp();
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [date, setDate] = useState(today(workspace.timezone));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(minorToInput(receivable.remaining, receivable.currency));
    setAccountId(null);
    setDate(today(workspace.timezone));
    setReference("");
    setNote("");
    setAttachments([]);
    setError(null);
  }, [open, receivable, workspace.timezone]);

  // Receipts uploaded for something that was never recorded are removed again.
  const close = (next: boolean) => {
    if (!next) discardNewAttachments(attachments);
    onOpenChange(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const minor = toMinor(amount, receivable.currency);
    if (!minor) return setError("Enter the amount received");
    if (!accountId) return setError("Choose the account it arrived in");
    if (!attachments.length) return setError("Attach the proof of payment. If a file is still uploading, wait for it to finish.");
    setSaving(true);
    setError(null);
    try {
      await clientApi(`/receivables/${receivable.id}/payments`, {
        method: "POST",
        body: {
          amount: minor,
          accountId,
          date,
          reference: reference.trim() || null,
          note: note.trim() || null,
          attachmentFileIds: attachments.length ? attachments.map((file) => file.id) : undefined,
        },
      });
      toast.success(minor >= receivable.remaining ? "Paid in full" : "Part payment recorded");
      refresh();
      setAttachments([]);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Money received · {receivable.counterpartyName}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {money(receivable.remaining, receivable.currency)} still owed for {receivable.title}.{" "}
              {receivable.kind === "invoice" ? "The payment is recorded as income." : "The repayment is not income — it returns money you lent."}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount" htmlFor={`${id}-amount`}>
                <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={receivable.currency} required />
              </Field>
              <Field label="Received on" htmlFor={`${id}-date`}>
                <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </Field>
            </div>
            <Field label="Into account" htmlFor={`${id}-account`}>
              <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} enabled={open} />
            </Field>
            <Field label="Reference" htmlFor={`${id}-ref`}>
              <Input id={`${id}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="TrxID, cheque no." />
            </Field>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <AttachmentField
              value={attachments}
              onChange={setAttachments}
              label="Proof of payment (required)"
              hint="A bank slip, bKash screenshot or receipt."
            />
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

export function ReceivableDetailView({ receivable }: { receivable: ReceivableDetail }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const open = receivable.status !== "paid" && receivable.status !== "cancelled";
  const linked = receivable.transactions.length;
  const share = receivable.amount > 0 ? Math.round((receivable.paid / receivable.amount) * 100) : 0;

  const remove = async () => {
    try {
      await clientApi(`/receivables/${receivable.id}`, {
        method: "DELETE",
        query: { voidLinked: linked > 0 },
      });
      toast.success("Deleted");
      refresh();
      router.push("/wealth/receivables");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const setCancelled = async (cancelled: boolean) => {
    try {
      await clientApi(`/receivables/${receivable.id}`, {
        method: "PATCH",
        body: { status: cancelled ? "cancelled" : "pending" },
      });
      toast.success(cancelled ? "Cancelled" : "Reopened");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              {[RECEIVABLE_KIND_LABELS[receivable.kind], receivable.reference, receivable.currency].filter(Boolean).join(" · ")}
              <StatusBadge status={receivable.status} />
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{money(receivable.remaining, receivable.currency)}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              still owed of {money(receivable.amount, receivable.currency)} · {money(receivable.paid, receivable.currency)} received
            </p>
            <ProgressBar value={share} tone={receivable.status === "overdue" ? "danger" : "good"} className="mt-2" />
            <div className="mt-2">
              <DueLine item={receivable} />
            </div>
            {receivable.baseRemaining === null && (
              <Link href="/settings/currency" className="block text-xs text-amber-600 hover:underline dark:text-amber-400">
                No {receivable.currency} exchange rate — left out of net worth. Add one.
              </Link>
            )}
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {open && (
                <Button size="sm" onClick={() => setPaying(true)}>
                  <HandCoins className="size-3.5" /> Record payment
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              {receivable.status === "cancelled" ? (
                <Button size="sm" variant="ghost" onClick={() => void setCancelled(false)}>
                  Reopen
                </Button>
              ) : (
                open && (
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>
                    Cancel
                  </Button>
                )
              )}
              <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </div>
          )}
        </div>
        <Section title="Details">
          <Facts
            items={[
              {
                label: receivable.kind === "invoice" ? "Customer" : "Owed by",
                value: receivable.counterpartyName,
              },
              { label: "For", value: receivable.title },
              {
                label: receivable.kind === "invoice" ? "Issued" : "Lent on",
                value: formatDay(receivable.issueDate),
              },
              {
                label: "Due",
                value: receivable.dueDate ? formatDay(receivable.dueDate) : "—",
              },
              receivable.categoryName ? { label: "Category", value: receivable.categoryName } : false,
              receivable.projectName ? { label: "Project", value: receivable.projectName } : false,
              receivable.lastPaymentDate
                ? {
                    label: "Last payment",
                    value: formatDay(receivable.lastPaymentDate),
                  }
                : false,
              receivable.notes ? { label: "Notes", value: receivable.notes } : false,
            ]}
          />
        </Section>
      </div>

      <Section title="Payments" hint={receivable.kind === "invoice" ? "Income linked to this invoice" : "The loan and repayments linked to it"}>
        {linked ? (
          <LinkedTransactions items={receivable.transactions} empty="" />
        ) : (
          <EmptyNote
            action={
              canWrite && open ? (
                <Button size="xs" variant="outline" onClick={() => setPaying(true)}>
                  <HandCoins className="size-3.5" /> Record a payment
                </Button>
              ) : undefined
            }
          >
            Nothing received yet.
          </EmptyNote>
        )}
      </Section>

      <ReceivableFormDialog open={editing} onOpenChange={setEditing} receivable={receivable} />
      <ReceivablePaymentDialog open={paying} onOpenChange={setPaying} receivable={receivable} />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel what is owed?"
        description="Use this when it will not be paid (written off or withdrawn). It leaves net worth and the overdue reminders stop; payments already received stay."
        confirmLabel="Cancel it"
        onConfirm={() => setCancelled(true)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this receivable?"
        description={
          linked
            ? `Its ${linked} linked transaction${linked === 1 ? " is" : "s are"} voided too, so balances and income change back. To keep the history, cancel it instead.`
            : "It is removed, with its reminders."
        }
        confirmLabel={linked ? "Delete and void" : "Delete"}
        onConfirm={remove}
      />
    </div>
  );
}
