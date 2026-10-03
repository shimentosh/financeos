"use client";

import {
  COMMON_CURRENCIES,
  currencyDecimals,
  endOfMonth,
  minorToInput,
  monthKey,
  parseMoneyInput,
  type TransactionType,
  TYPE_LABELS,
  TYPE_RULES,
  today,
} from "@financeos/core";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Account, Category, Project, Transaction, TransactionDetail } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { toast } from "@/lib/toast";
import { invalidateApiCache, useApi } from "@/lib/use-api";

const NONE = "__none__";
const PRIMARY: TransactionType[] = ["expense", "income", "transfer"];
/** Types that cannot be saved without an invoice, receipt or proof of payment. */
const NEEDS_PROOF: TransactionType[] = ["income", "expense"];
const MORE: TransactionType[] = ["refund", "adjustment", "investment", "asset_purchase", "debt_payment", "loan", "equity"];

const DIRECTION_LABELS: Partial<Record<TransactionType, { in: string; out: string }>> = {
  refund: { in: "Refund received", out: "Refund issued to a customer" },
  adjustment: { in: "Increase balance", out: "Decrease balance" },
  investment: { in: "Withdrawal / sale proceeds", out: "Contribution" },
  debt_payment: { in: "Repayment received", out: "Payment made" },
  loan: { in: "Borrowed (money in)", out: "Lent (money out)" },
  equity: { in: "Owner capital in", out: "Owner drawing out" },
};

type FormState = {
  type: TransactionType;
  direction: "in" | "out";
  amount: string;
  currency: string;
  accountAmount: string;
  accountId: string;
  toAccountId: string;
  toAccountAmount: string;
  date: string;
  merchant: string;
  categoryId: string;
  projectId: string;
  description: string;
  notes: string;
  reference: string;
};

function initialState(type: TransactionType, baseCurrency: string, timezone: string, tx?: Transaction | null): FormState {
  if (tx) {
    return {
      type: tx.type,
      direction: tx.direction,
      amount: minorToInput(tx.amount, tx.currency),
      currency: tx.currency,
      accountAmount: tx.accountAmount && tx.accountAmount !== tx.amount ? String(tx.accountAmount) : "",
      accountId: tx.accountId ?? "",
      toAccountId: tx.toAccountId ?? "",
      toAccountAmount: "",
      date: tx.date,
      merchant: tx.merchant ?? "",
      categoryId: tx.categoryId ?? NONE,
      projectId: tx.projectId ?? NONE,
      description: tx.description ?? "",
      notes: tx.notes ?? "",
      reference: tx.reference ?? "",
    };
  }
  return {
    type,
    direction: TYPE_RULES[type].defaultDirection,
    amount: "",
    currency: baseCurrency,
    accountAmount: "",
    accountId: "",
    toAccountId: "",
    toAccountAmount: "",
    date: today(timezone),
    merchant: "",
    categoryId: NONE,
    projectId: NONE,
    description: "",
    notes: "",
    reference: "",
  };
}

/**
 * Income is entered per profit month: it is booked on the month's last day, or
 * today while that month is still running, so monthly reports count it there.
 */
function dayInMonth(month: string, timezone: string): string {
  const now = today(timezone);
  return month === monthKey(now) ? now : endOfMonth(`${month}-01`);
}

/**
 * Records or edits any kind of transaction. Only the fields the type needs
 * are shown; amounts are typed in major units and sent as minor units.
 * Invoices and receipts upload as they are chosen and are linked on save.
 */
export function TransactionFormDialog({
  open,
  onOpenChange,
  initialType = "expense",
  transaction,
  attachments: savedAttachments,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialType?: TransactionType;
  transaction?: Transaction | null;
  /** The transaction's current attachments when the caller already has them; otherwise they are loaded. */
  attachments?: Attachment[];
  onSaved?: (transaction: Transaction) => void;
}) {
  const id = useId();
  const router = useRouter();
  const { workspace, isBusiness } = useApp();
  const accounts = useApi<Account[]>(open ? "/accounts" : null);
  const categories = useApi<Category[]>(open ? "/categories" : null);
  const projects = useApi<Project[]>(open && isBusiness ? "/projects" : null);
  const [form, setForm] = useState<FormState>(() => initialState(initialType, workspace.baseCurrency, workspace.timezone, transaction));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Editing sends the attachment list only once it is known and changed, so an edit never unlinks files by accident.
  const [attachmentsTouched, setAttachmentsTouched] = useState(false);
  const detail = useApi<TransactionDetail>(open && transaction && !savedAttachments ? `/transactions/${transaction.id}` : null);
  const savedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setForm(initialState(initialType, workspace.baseCurrency, workspace.timezone, transaction));
    setError(null);
    setShowMore(Boolean(transaction && MORE.includes(transaction.type)));
    setAttachments(savedAttachments ?? []);
    setAttachmentsTouched(false);
    savedRef.current = false;
  }, [open, initialType, transaction, savedAttachments, workspace.baseCurrency, workspace.timezone]);

  useEffect(() => {
    if (open && !attachmentsTouched && detail.data) setAttachments(detail.data.attachments);
  }, [open, attachmentsTouched, detail.data]);

  const changeAttachments = (next: Attachment[]) => {
    setAttachments(next);
    setAttachmentsTouched(true);
  };

  // Closing without saving removes files uploaded in this form.
  const close = (next: boolean) => {
    if (!next && !savedRef.current) discardNewAttachments(attachments);
    onOpenChange(next);
  };

  // Default the account to the first one once they load.
  useEffect(() => {
    if (!open || form.accountId || !accounts.data?.length) return;
    const first = accounts.data[0];
    if (first) setForm((f) => ({ ...f, accountId: first.id, currency: transaction ? f.currency : first.currency }));
  }, [open, accounts.data, form.accountId, transaction]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const account = accounts.data?.find((a) => a.id === form.accountId);
  const toAccount = accounts.data?.find((a) => a.id === form.toAccountId);
  const rules = TYPE_RULES[form.type];
  const categoryKind = form.type === "income" || (form.type === "refund" && form.direction === "out") ? "income" : "expense";
  const usesCategory = ["expense", "income", "refund"].includes(form.type);
  const needsAccountAmount = Boolean(account && account.currency !== form.currency);
  const needsToAmount = form.type === "transfer" && toAccount && account && toAccount.currency !== account.currency;

  const categoryOptions = useMemo(() => {
    const list = (categories.data ?? []).filter((c) => c.kind === categoryKind && !c.archived);
    const parents = list.filter((c) => !c.parentId);
    return parents.flatMap((parent) => [{ ...parent, depth: 0 }, ...list.filter((c) => c.parentId === parent.id).map((child) => ({ ...child, depth: 1 }))]);
  }, [categories.data, categoryKind]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const amount = parseMoneyInput(form.amount, form.currency);
    if (!amount) return setError(`Enter the amount in ${form.currency}, e.g. 1,500 or 1500.50`);
    if (!form.accountId) return setError("Choose the account the money moved through");
    if (form.type === "transfer" && !form.toAccountId) return setError("Choose the account the money went to");
    // Income and expenses need their invoice, receipt or proof of payment. Edits wait until the saved files have loaded.
    const attachmentsKnown = !transaction || Boolean(savedAttachments || detail.data || attachmentsTouched);
    if (NEEDS_PROOF.includes(form.type) && attachmentsKnown && attachments.length === 0)
      return setError(
        `Attach the ${form.type === "income" ? "invoice or proof of payment" : "invoice or receipt"}. If a file is still uploading, wait for it to finish.`,
      );
    const accountAmount = needsAccountAmount && form.accountAmount ? parseMoneyInput(form.accountAmount, account?.currency ?? form.currency) : null;
    const toAccountAmount = needsToAmount && form.toAccountAmount ? parseMoneyInput(form.toAccountAmount, toAccount?.currency ?? form.currency) : null;

    const body = {
      type: form.type,
      direction: rules.directions.length > 1 ? form.direction : rules.defaultDirection,
      accountId: form.accountId,
      toAccountId: form.type === "transfer" ? form.toAccountId : null,
      amount,
      currency: form.currency,
      accountAmount,
      toAccountAmount,
      date: form.date,
      merchant: form.merchant.trim() || null,
      categoryId: usesCategory && form.categoryId !== NONE ? form.categoryId : null,
      projectId: form.projectId !== NONE ? form.projectId : null,
      description: form.description.trim() || null,
      notes: form.notes.trim() || null,
      reference: form.reference.trim() || null,
      ...(!transaction || attachmentsTouched ? { attachmentFileIds: attachments.map((file) => file.id) } : {}),
    };
    setSaving(true);
    try {
      const saved = transaction
        ? await clientApi<Transaction>(`/transactions/${transaction.id}`, { method: "PATCH", body })
        : await clientApi<Transaction>("/transactions", { method: "POST", body });
      toast.success(transaction ? "Transaction updated" : `${TYPE_LABELS[form.type]} recorded`);
      invalidateApiCache("/accounts");
      if (transaction) invalidateApiCache(`/transactions/${transaction.id}`);
      savedRef.current = true;
      onOpenChange(false);
      onSaved?.(saved);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const typeButton = (type: TransactionType) => (
    <button
      key={type}
      type="button"
      role="tab"
      aria-selected={form.type === type}
      onClick={() => setForm((f) => ({ ...f, type, direction: TYPE_RULES[type].defaultDirection, categoryId: NONE }))}
      className={cn(
        "flex-1 rounded-md px-2.5 py-1 text-xs transition-colors",
        form.type === type ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {TYPE_LABELS[type]}
    </button>
  );

  const accountSelect = (value: string, onChange: (v: string) => void, exclude?: string, labelId?: string) => (
    <Select value={value || null} onValueChange={(v) => typeof v === "string" && onChange(v)}>
      <SelectTrigger id={labelId}>
        <SelectValue>
          {(() => {
            const a = accounts.data?.find((x) => x.id === value);
            return a ? `${a.name} · ${a.currency}` : accounts.loading ? "Loading…" : "Choose account";
          })()}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(accounts.data ?? [])
          .filter((a) => a.id !== exclude)
          .map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name} · {a.currency}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{transaction ? "Edit transaction" : "New transaction"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-2">
              <div role="tablist" aria-label="Type" className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
                {PRIMARY.map(typeButton)}
                <button
                  type="button"
                  onClick={() => setShowMore((v) => !v)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground",
                    MORE.includes(form.type) && "bg-background font-medium text-foreground shadow-xs",
                  )}
                >
                  {MORE.includes(form.type) ? TYPE_LABELS[form.type] : "More"}
                </button>
              </div>
              {showMore && (
                <div role="tablist" aria-label="More types" className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 p-1">
                  {MORE.map(typeButton)}
                </div>
              )}
              {rules.directions.length > 1 && DIRECTION_LABELS[form.type] && (
                <div className="flex gap-1">
                  {(["out", "in"] as const).map((direction) => (
                    <Button
                      key={direction}
                      type="button"
                      size="xs"
                      variant={form.direction === direction ? "default" : "outline"}
                      onClick={() => set("direction", direction)}
                    >
                      {DIRECTION_LABELS[form.type]?.[direction]}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-amount`}>Amount</Label>
                <Input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  autoFocus
                  placeholder={currencyDecimals(form.currency) ? "0.00" : "0"}
                  value={form.amount}
                  onChange={(e) => set("amount", e.target.value)}
                  className="text-base font-medium tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-currency`}>Currency</Label>
                <Select value={form.currency} onValueChange={(v) => typeof v === "string" && set("currency", v)}>
                  <SelectTrigger id={`${id}-currency`}>
                    <SelectValue>{form.currency}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([form.currency, ...COMMON_CURRENCIES])].map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className={cn("grid gap-3", form.type === "transfer" ? "grid-cols-2" : "grid-cols-1")}>
              <div className="space-y-1">
                <Label htmlFor={`${id}-account`}>
                  {form.type === "transfer" ? "From" : rules.directions.includes("in") && form.direction === "in" ? "Into account" : "Account"}
                </Label>
                {accountSelect(form.accountId, (v) => set("accountId", v), undefined, `${id}-account`)}
              </div>
              {form.type === "transfer" && (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-to`}>To</Label>
                  {accountSelect(form.toAccountId, (v) => set("toAccountId", v), form.accountId, `${id}-to`)}
                </div>
              )}
            </div>

            {needsAccountAmount && account && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-charged`}>
                  Charged to {account.name} ({account.currency})
                </Label>
                <Input
                  id={`${id}-charged`}
                  inputMode="decimal"
                  placeholder="Leave empty to convert at your saved rate"
                  value={form.accountAmount}
                  onChange={(e) => set("accountAmount", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">What the statement shows is the most accurate conversion.</p>
              </div>
            )}
            {needsToAmount && toAccount && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-received`}>
                  Received in {toAccount.name} ({toAccount.currency})
                </Label>
                <Input
                  id={`${id}-received`}
                  inputMode="decimal"
                  placeholder="Leave empty to convert"
                  value={form.toAccountAmount}
                  onChange={(e) => set("toAccountAmount", e.target.value)}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {form.type === "income" ? (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-month`}>Profit month</Label>
                  <Input
                    id={`${id}-month`}
                    type="month"
                    required
                    value={monthKey(form.date)}
                    onChange={(e) => e.target.value && set("date", dayInMonth(e.target.value, workspace.timezone))}
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-date`}>Date</Label>
                  <Input id={`${id}-date`} type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
                </div>
              )}
              {form.type !== "transfer" && (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-merchant`}>{form.type === "income" ? "From" : "Merchant / payee"}</Label>
                  <Input
                    id={`${id}-merchant`}
                    value={form.merchant}
                    onChange={(e) => set("merchant", e.target.value)}
                    placeholder={form.type === "income" ? "Client, employer…" : "Shwapno, Uber…"}
                  />
                </div>
              )}
            </div>
            {form.type === "income" && (
              <p className="-mt-2 text-xs text-muted-foreground">
                Counts toward {formatMonth(monthKey(form.date))} in profit and project reports.
                {transaction ? "" : " The day you entered it is kept as the recorded date."}
              </p>
            )}

            {usesCategory && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-category`}>Category</Label>
                <Select value={form.categoryId} onValueChange={(v) => typeof v === "string" && set("categoryId", v)}>
                  <SelectTrigger id={`${id}-category`}>
                    <SelectValue>{categoryOptions.find((c) => c.id === form.categoryId)?.name ?? "Uncategorized"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Uncategorized</SelectItem>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className={cn(c.depth === 1 && "ps-4 text-muted-foreground")}>{c.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {isBusiness && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-project`}>Project</Label>
                <Select value={form.projectId} onValueChange={(v) => typeof v === "string" && set("projectId", v)}>
                  <SelectTrigger id={`${id}-project`}>
                    <SelectValue>{projects.data?.find((p) => p.id === form.projectId)?.name ?? "No project"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No project</SelectItem>
                    {(projects.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor={`${id}-description`}>Description</Label>
              <Input id={`${id}-description`} value={form.description} onChange={(e) => set("description", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-reference`}>Reference</Label>
                <Input id={`${id}-reference`} value={form.reference} onChange={(e) => set("reference", e.target.value)} placeholder="TrxID, invoice no." />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-notes`}>Notes</Label>
              <Textarea id={`${id}-notes`} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </div>
            <AttachmentField
              value={attachments}
              onChange={changeAttachments}
              label={`${form.type === "income" ? "Invoice or proof of payment" : "Invoice or receipt"}${NEEDS_PROOF.includes(form.type) ? " (required)" : ""}`}
              disabled={Boolean(transaction && !savedAttachments && !detail.data && !attachmentsTouched)}
              hint={
                transaction && !savedAttachments && !detail.data
                  ? "Loading attachments…"
                  : "Photos, screenshots or PDFs, up to 12 MB each. You can also paste a screenshot."
              }
            />
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {transaction ? "Save changes" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Mounted once in the app shell; listens for openAddTransaction(). */
export function GlobalTransactionForm() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<TransactionType>("expense");

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: TransactionType }>).detail;
      setType(detail?.type ?? "expense");
      setOpen(true);
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const map: Record<string, TransactionType> = { e: "expense", i: "income", t: "transfer" };
      const next = map[event.key.toLowerCase()];
      if (next && !document.querySelector("[data-slot=dialog-popup],[data-slot=sheet-popup]")) {
        event.preventDefault();
        setType(next);
        setOpen(true);
      }
    };
    window.addEventListener("ew:add-transaction", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("ew:add-transaction", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return <TransactionFormDialog open={open} onOpenChange={setOpen} initialType={type} />;
}
