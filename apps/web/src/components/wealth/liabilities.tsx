"use client";

import { FREQUENCY_LABELS, formatDay, minorToInput, today } from "@financeos/core";
import { AlarmClock, CalendarClock, CircleAlert, HandCoins, Landmark, Pencil, Percent, Plus, Receipt, Trash2, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { EmptyNote, EmptyState, Facts, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Liability, LiabilityDetail, LiabilityKind, LiabilityList, LiabilityPaymentResult, PayableList } from "@/lib/api/types/wealth";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import {
  AccountSelect,
  CategorySelect,
  ConfirmDialog,
  CurrencySelect,
  Field,
  FormError,
  KindSelect,
  LIABILITY_KIND_LABELS,
  LinkedTransactions,
  MoneyInput,
  NewParamOpener,
  ParamTabs,
  ProjectSelect,
  SwitchRow,
  toMinor,
  useRefresh,
} from "./shared";

const ORDER: LiabilityKind[] = ["loan", "mortgage", "credit", "business_debt", "personal_debt", "payable", "other"];
const PAYABLE_KINDS: LiabilityKind[] = ["payable", "personal_debt", "business_debt"];
const SCHEDULE_FREQUENCIES = ["monthly", "quarterly", "half_yearly", "yearly", "weekly", "once"] as const;

function paidShare(item: { paid: number; total: number }) {
  return item.total > 0 ? Math.round((item.paid / item.total) * 100) : 0;
}

function DueText({ status, dueDate, daysOverdue }: { status: string; dueDate: string | null; daysOverdue: number }) {
  if (status === "paid_off") return <span className="text-xs text-muted-foreground">Paid off</span>;
  if (status === "cancelled") return <span className="text-xs text-muted-foreground">Cancelled</span>;
  if (!dueDate) return <span className="text-xs text-muted-foreground">No due date</span>;
  return (
    <span className={cn("text-xs", status === "overdue" ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>
      {status === "overdue" ? `${daysOverdue} days overdue` : `Due ${formatDay(dueDate)}`}
    </span>
  );
}

// ------------------------------------------------------------------- list

export function LiabilitiesView({
  list,
  payables,
  view,
  status,
  projectFilter,
}: {
  list: LiabilityList | null;
  payables: PayableList | null;
  view: string;
  status?: string;
  projectFilter?: boolean;
}) {
  const { money, canWrite } = useApp();
  const [creating, setCreating] = useState<LiabilityKind | null>(null);
  const [paying, setPaying] = useState<Liability | null>(null);
  const openCreate = useCallback(() => setCreating(view === "payables" ? "payable" : "loan"), [view]);

  const dialogs = (
    <>
      <Suspense>
        <NewParamOpener onNew={openCreate} />
      </Suspense>
      <LiabilityFormDialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)} defaultKind={creating ?? "loan"} />
      {paying && <PaymentDialog open onOpenChange={(open) => !open && setPaying(null)} liability={paying} />}
    </>
  );

  const tabs = (
    <ParamTabs
      param="view"
      label="View"
      value={view}
      options={[
        { value: "all", label: "All debts" },
        { value: "payables", label: "Payables" },
      ]}
    />
  );

  const filterChip = projectFilter ? (
    <Link
      href={view === "payables" ? "/wealth/liabilities?view=payables" : "/wealth/liabilities"}
      className="rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent"
    >
      One project only ✕
    </Link>
  ) : null;

  if (view === "payables" && payables) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {tabs}
          {filterChip}
        </div>
        <PayablesTable payables={payables} onPay={(id) => setPaying(list?.items.find((l) => l.id === id) ?? null)} onCreate={() => setCreating("payable")} />
        {dialogs}
      </div>
    );
  }
  if (!list) return null;

  if (list.items.length === 0 && !status && !projectFilter) {
    return (
      <div className="space-y-4">
        {tabs}
        <EmptyState
          icon={Landmark}
          title="Keep track of what you owe"
          description="Bank loans, a mortgage, money borrowed from family, or bills you still have to pay. Payments reduce the balance; interest is kept apart as an expense."
          action={
            canWrite ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setCreating("loan")}>
                  <Plus className="size-3.5" /> Add a debt
                </Button>
                <Button size="sm" variant="outline" onClick={() => setCreating("payable")}>
                  <Receipt className="size-3.5" /> Add a bill to pay
                </Button>
              </div>
            ) : undefined
          }
        />
        {dialogs}
      </div>
    );
  }

  const byKind = ORDER.map((kind) => ({
    kind,
    items: list.items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Landmark} label="Total owed" value={money(list.totals.outstanding)} hint={`${list.totals.count} open`} href="/wealth/net-worth" />
        <StatCard
          icon={AlarmClock}
          label="Overdue"
          value={money(list.totals.overdueOutstanding)}
          hint={list.totals.overdueCount ? `${list.totals.overdueCount} past due` : "Nothing overdue"}
          tone={list.totals.overdueCount ? "danger" : "default"}
          href={list.totals.overdueCount ? "/wealth/liabilities?status=overdue" : undefined}
        />
        <StatCard
          icon={Receipt}
          label="Bills and personal debts"
          value={money(payables?.totals.remaining ?? 0)}
          hint="See the Payables tab"
          href="/wealth/liabilities?view=payables"
        />
        <StatCard
          icon={Wallet}
          label="Largest group"
          value={list.groups[0] ? LIABILITY_KIND_LABELS[list.groups[0].kind] : "—"}
          hint={list.groups[0] ? money(list.groups[0].outstanding) : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {tabs}
        {filterChip}
        {status && (
          <Link href="/wealth/liabilities" className="rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent">
            Status: {status.replace(/_/g, " ")} ✕
          </Link>
        )}
      </div>

      {list.unconvertible.length > 0 && (
        <Link
          href="/settings/currency"
          className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
        >
          <CircleAlert className="size-3.5 shrink-0" />
          {list.unconvertible.map((u) => `${u.name} (${u.currency})`).join(", ")} — no exchange rate, left out of the totals. Add a rate.
        </Link>
      )}

      {byKind.length === 0 && (
        <EmptyNote
          action={
            <Button size="sm" variant="outline" render={<Link href="/wealth/liabilities" />}>
              Show all debts
            </Button>
          }
        >
          No debts with this status.
        </EmptyNote>
      )}

      {byKind.map((group) => {
        const summary = list.groups.find((g) => g.kind === group.kind);
        return (
          <section key={group.kind} className="space-y-2">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-xs font-medium text-muted-foreground">{LIABILITY_KIND_LABELS[group.kind]}</h2>
              {summary && <span className="text-xs text-muted-foreground tabular-nums">{money(summary.outstanding)} owed</span>}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border border-border bg-card p-4",
                    (item.status === "paid_off" || item.status === "cancelled") && "opacity-70",
                  )}
                >
                  <Link href={`/wealth/liabilities/${item.id}`} className="block hover:opacity-80">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{[item.counterparty, item.currency].filter(Boolean).join(" · ")}</p>
                      </div>
                      <StatusBadge status={item.status === "paid_off" ? "paid" : item.status} label={item.status.replace(/_/g, " ")} />
                    </div>
                    <p className="mt-2 text-xl font-semibold tabular-nums">{money(Math.max(0, item.outstanding), item.currency)}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      of {money(item.total, item.currency)} · {money(item.paid, item.currency)} paid
                    </p>
                    <ProgressBar value={paidShare(item)} tone={item.status === "overdue" ? "danger" : "good"} className="mt-2" />
                  </Link>
                  <div className="flex items-center justify-between gap-2">
                    <DueText status={item.status} dueDate={item.dueDate} daysOverdue={item.daysOverdue} />
                    {canWrite && item.status !== "paid_off" && item.status !== "cancelled" && (
                      <Button size="xs" variant="outline" onClick={() => setPaying(item)}>
                        <HandCoins className="size-3.5" /> Pay
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {dialogs}
    </div>
  );
}

function PayablesTable({ payables, onPay, onCreate }: { payables: PayableList; onPay: (id: string) => void; onCreate: () => void }) {
  const { money, canWrite, isBusiness } = useApp();
  const { totals } = payables;
  if (!payables.items.length) {
    return (
      <EmptyState
        icon={Receipt}
        title="No bills or personal debts"
        description="A contractor's invoice you still owe, a supplier on credit, or money borrowed from a friend. Paying a bill records the expense in its category."
        action={
          canWrite ? (
            <Button size="sm" onClick={onCreate}>
              <Plus className="size-3.5" /> Add a bill to pay
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Receipt} label="Still to pay" value={money(totals.remaining)} hint={`${totals.count} open`} />
        <StatCard
          icon={AlarmClock}
          label="Overdue"
          value={money(totals.overdue)}
          hint={`${totals.overdueCount} past due`}
          tone={totals.overdueCount ? "danger" : "default"}
        />
        <StatCard icon={CalendarClock} label="Due in 30 days" value={money(totals.dueNext30Days)} />
        <StatCard icon={Wallet} label="Tracked" value={String(payables.items.length)} hint="Including paid and cancelled" />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Owed to</th>
              <th className="hidden md:table-cell">Due</th>
              <th className="hidden text-right! md:table-cell">Amount</th>
              <th className="hidden text-right! sm:table-cell">Paid</th>
              <th className="text-right!">Remaining</th>
              <th className="hidden lg:table-cell">Category</th>
              {isBusiness && <th className="hidden lg:table-cell">Project</th>}
              <th className="w-24">Status</th>
              {canWrite && <th className="w-16" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {payables.items.map((p) => (
              <tr key={p.id} className="[&>td]:px-3 [&>td]:py-2">
                <td className="min-w-0">
                  <Link href={`/wealth/liabilities/${p.id}`} className="block truncate font-medium hover:underline underline-offset-4">
                    {p.counterparty ?? p.name}
                  </Link>
                  <span className="block truncate text-xs text-muted-foreground">
                    {p.counterparty ? p.name : LIABILITY_KIND_LABELS[p.kind]}
                    <span className="md:hidden"> · {p.dueDate ? formatDay(p.dueDate, "short") : "no due date"}</span>
                  </span>
                </td>
                <td className="hidden md:table-cell">
                  <DueText status={p.status} dueDate={p.dueDate} daysOverdue={p.daysOverdue} />
                </td>
                <td className="hidden text-right tabular-nums md:table-cell">{money(p.amount, p.currency)}</td>
                <td className="hidden text-right tabular-nums sm:table-cell">{money(p.paid, p.currency)}</td>
                <td className="text-right font-medium tabular-nums">{money(p.remaining, p.currency)}</td>
                <td className="hidden text-xs text-muted-foreground lg:table-cell">{p.categoryName ?? "—"}</td>
                {isBusiness && <td className="hidden text-xs text-muted-foreground lg:table-cell">{p.projectName ?? "—"}</td>}
                <td>
                  <StatusBadge status={p.status === "paid_off" ? "paid" : p.status} label={p.status.replace(/_/g, " ")} />
                </td>
                {canWrite && (
                  <td className="text-right">
                    {p.remaining > 0 && p.status !== "cancelled" && (
                      <Button size="xs" variant="outline" onClick={() => onPay(p.id)}>
                        Pay
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AddLiabilityButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add debt
      </Button>
      <LiabilityFormDialog open={open} onOpenChange={setOpen} defaultKind="loan" />
    </>
  );
}

// ------------------------------------------------------------------- forms

export function LiabilityFormDialog({
  open,
  onOpenChange,
  liability,
  defaultKind = "loan",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  liability?: Liability | null;
  defaultKind?: LiabilityKind;
}) {
  const id = useId();
  const router = useRouter();
  const refresh = useRefresh();
  const { workspace, isBusiness } = useApp();
  const [kind, setKind] = useState<LiabilityKind>(defaultKind);
  const [name, setName] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [principal, setPrincipal] = useState("");
  const [owed, setOwed] = useState("");
  const [rate, setRate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [received, setReceived] = useState(false);
  const [receivedInto, setReceivedInto] = useState<string | null>(null);
  const [withSchedule, setWithSchedule] = useState(false);
  const [installment, setInstallment] = useState("");
  const [frequency, setFrequency] = useState<(typeof SCHEDULE_FREQUENCIES)[number]>("monthly");
  const [firstDue, setFirstDue] = useState("");
  const [autoPay, setAutoPay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setKind(liability?.kind ?? defaultKind);
    setName(liability?.name ?? "");
    setCounterparty(liability?.counterparty ?? liability?.counterpartyName ?? "");
    setCurrency(liability?.currency ?? workspace.baseCurrency);
    setPrincipal(liability ? minorToInput(liability.principal, liability.currency) : "");
    setOwed(liability ? minorToInput(liability.openingOutstanding, liability.currency) : "");
    setRate(liability?.interestRate ? String(Number(liability.interestRate)) : "");
    setStartDate(liability?.startDate ?? today(workspace.timezone));
    setDueDate(liability?.dueDate ?? "");
    setCategoryId(liability?.categoryId ?? null);
    setProjectId(liability?.projectId ?? null);
    setAccountId(liability?.accountId ?? null);
    setNotes(liability?.notes ?? "");
    setReceived(false);
    setReceivedInto(null);
    setWithSchedule(false);
    setInstallment("");
    setFrequency("monthly");
    setFirstDue("");
    setAutoPay(false);
  }, [open, liability, defaultKind, workspace.baseCurrency, workspace.timezone]);

  const isBill = PAYABLE_KINDS.includes(kind);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const principalMinor = toMinor(principal, currency);
    if (!principalMinor) return setError("Enter the amount borrowed or billed");
    const owedMinor = owed ? toMinor(owed, currency) : principalMinor;
    if (owedMinor === null) return setError("Enter what is still owed as a number");
    if (rate && !/^\d+(\.\d+)?$/.test(rate.trim())) return setError("Enter the interest rate as a percentage, e.g. 9.5");
    const base = {
      kind,
      name: name.trim(),
      counterpartyName: counterparty.trim() || null,
      principal: principalMinor,
      currency,
      openingOutstanding: owedMinor,
      interestRate: rate.trim() || null,
      startDate: startDate || null,
      dueDate: dueDate || null,
      categoryId: isBill ? categoryId : null,
      projectId,
      accountId: kind === "credit" ? accountId : null,
      notes: notes.trim() || null,
    };
    let schedule = null;
    if (!liability && withSchedule) {
      const amount = toMinor(installment, currency);
      if (!amount) return setError("Enter the installment amount");
      if (!firstDue) return setError("Choose when the first installment is due");
      schedule = { amount, frequency, firstDueDate: firstDue, autoPay };
    }
    if (!liability && received && !receivedInto) return setError("Choose the account the money went into");
    setSaving(true);
    try {
      if (liability) {
        await clientApi(`/liabilities/${liability.id}`, {
          method: "PATCH",
          body: base,
        });
        toast.success("Saved");
        refresh();
      } else {
        const created = await clientApi<LiabilityDetail>("/liabilities", {
          method: "POST",
          body: {
            ...base,
            receivedIntoAccountId: received ? receivedInto : null,
            schedule,
          },
        });
        toast.success(isBill ? "Bill added" : "Debt added", {
          description: schedule ? "Installments are on your commitments calendar." : undefined,
        });
        refresh();
        router.push(`/wealth/liabilities/${created.id}`);
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
            <DialogTitle>{liability ? `Edit ${liability.name}` : isBill ? "Add a bill or debt" : "Add a debt"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind" htmlFor={`${id}-kind`}>
                <KindSelect id={`${id}-kind`} value={kind} onChange={setKind} labels={LIABILITY_KIND_LABELS} />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <CurrencySelect id={`${id}-currency`} value={currency} onChange={setCurrency} />
              </Field>
            </div>
            <Field label="Name" htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isBill ? "Design agency invoice, Supplier credit…" : "Car loan, Home loan, Borrowed from Karim…"}
              />
            </Field>
            <Field label={isBill ? "Owed to" : "Lender"} htmlFor={`${id}-counterparty`}>
              <Input
                id={`${id}-counterparty`}
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                placeholder="City Bank, Pixel Studio, Karim…"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={isBill ? "Bill amount" : "Borrowed"} htmlFor={`${id}-principal`}>
                <MoneyInput id={`${id}-principal`} value={principal} onChange={setPrincipal} currency={currency} required />
              </Field>
              <Field
                label={liability ? "Owed when added" : "Still owed"}
                htmlFor={`${id}-owed`}
                hint={liability ? "Payments since then are counted separately" : "Defaults to the full amount"}
              >
                <MoneyInput id={`${id}-owed`} value={owed} onChange={setOwed} currency={currency} placeholder={principal || "0"} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Since" htmlFor={`${id}-start`}>
                <Input id={`${id}-start`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Due" htmlFor={`${id}-due`}>
                <Input id={`${id}-due`} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
              <Field label="Interest %" htmlFor={`${id}-rate`}>
                <Input id={`${id}-rate`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="9.5" />
              </Field>
            </div>
            {isBill && (
              <Field label="Expense category" htmlFor={`${id}-category`} hint="Paying the bill records the cost here.">
                <CategorySelect id={`${id}-category`} kind="expense" value={categoryId} onChange={setCategoryId} enabled={open} />
              </Field>
            )}
            {kind === "credit" && (
              <Field label="Card account" htmlFor={`${id}-card`} hint="If the card is an account, its balance already counts in net worth.">
                <AccountSelect id={`${id}-card`} value={accountId} onChange={setAccountId} noneLabel="Not an account here" enabled={open} />
              </Field>
            )}
            {isBusiness && (
              <Field label="Project" htmlFor={`${id}-project`}>
                <ProjectSelect id={`${id}-project`} value={projectId} onChange={setProjectId} enabled={open} />
              </Field>
            )}
            {!liability && !isBill && (
              <div className="space-y-2 rounded-lg border border-border px-3 py-2">
                <SwitchRow
                  id={`${id}-received`}
                  title="The money came into an account"
                  hint="Records the borrowing as a loan — not income."
                  checked={received}
                  onCheckedChange={setReceived}
                />
                {received && <AccountSelect id={`${id}-into`} value={receivedInto} onChange={setReceivedInto} enabled={open} />}
              </div>
            )}
            {!liability && (
              <div className="space-y-2 rounded-lg border border-border px-3 py-2">
                <SwitchRow
                  id={`${id}-schedule`}
                  title="Pay it in installments"
                  hint="Adds a schedule with reminders to your commitments."
                  checked={withSchedule}
                  onCheckedChange={setWithSchedule}
                />
                {withSchedule && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Installment" htmlFor={`${id}-installment`}>
                      <MoneyInput id={`${id}-installment`} value={installment} onChange={setInstallment} currency={currency} />
                    </Field>
                    <Field label="Every" htmlFor={`${id}-frequency`}>
                      <Select value={frequency} onValueChange={(v) => typeof v === "string" && setFrequency(v as (typeof SCHEDULE_FREQUENCIES)[number])}>
                        <SelectTrigger id={`${id}-frequency`}>
                          <SelectValue>{FREQUENCY_LABELS[frequency]}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {SCHEDULE_FREQUENCIES.map((f) => (
                            <SelectItem key={f} value={f}>
                              {FREQUENCY_LABELS[f]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="First due" htmlFor={`${id}-first`}>
                      <Input id={`${id}-first`} type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
                    </Field>
                    <div className="flex items-end justify-between gap-2 pb-2 text-sm">
                      <label htmlFor={`${id}-autopay`}>Auto-debit</label>
                      <Switch id={`${id}-autopay`} checked={autoPay} onCheckedChange={setAutoPay} />
                    </div>
                  </div>
                )}
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
              {liability ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** A payment: the principal reduces what is owed, interest is recorded as an expense. */
export function PaymentDialog({ open, onOpenChange, liability }: { open: boolean; onOpenChange: (open: boolean) => void; liability: Liability }) {
  const id = useId();
  const refresh = useRefresh();
  const { workspace, money } = useApp();
  const bill = liability.kind === "payable";
  const [amount, setAmount] = useState("");
  const [interest, setInterest] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [date, setDate] = useState(today(workspace.timezone));
  const [recordAs, setRecordAs] = useState<"debt_payment" | "expense">(bill ? "expense" : "debt_payment");
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount("");
    setInterest("");
    setAccountId(null);
    setDate(today(workspace.timezone));
    setRecordAs(bill ? "expense" : "debt_payment");
    setNote("");
    setAttachments([]);
    setError(null);
  }, [open, bill, workspace.timezone]);

  const total = toMinor(amount, liability.currency);
  const interestMinor = interest ? toMinor(interest, liability.currency) : 0;
  const principal = total !== null && interestMinor !== null ? total - interestMinor : null;
  const outstanding = Math.max(0, liability.outstanding);

  // Receipts uploaded for something that was never recorded are removed again.
  const close = (next: boolean) => {
    if (!next) discardNewAttachments(attachments);
    onOpenChange(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!total) return setError("Enter the amount paid");
    if (interestMinor === null || interestMinor > total) return setError("Interest has to be part of the payment");
    if (!accountId) return setError("Choose the account you paid from");
    if (!attachments.length) return setError("Attach the receipt. If a file is still uploading, wait for it to finish.");
    setSaving(true);
    setError(null);
    try {
      const result = await clientApi<LiabilityPaymentResult>(`/liabilities/${liability.id}/payments`, {
        method: "POST",
        body: {
          amount: total,
          interest: interestMinor,
          accountId,
          date,
          recordAs,
          note: note.trim() || null,
          attachmentFileIds: attachments.length ? attachments.map((file) => file.id) : undefined,
        },
      });
      toast.success("Payment recorded", {
        description:
          result.liability.status === "paid_off" ? "Paid off in full." : `${money(Math.max(0, result.liability.outstanding), liability.currency)} still owed.`,
      });
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
            <DialogTitle>Pay · {liability.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {money(outstanding, liability.currency)} owed
              {liability.counterparty ? ` to ${liability.counterparty}` : ""}.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount paid" htmlFor={`${id}-amount`}>
                <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={liability.currency} required />
              </Field>
              <Field label="Of which interest" htmlFor={`${id}-interest`}>
                <MoneyInput id={`${id}-interest`} value={interest} onChange={setInterest} currency={liability.currency} placeholder="0" />
              </Field>
            </div>
            <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={() => setAmount(minorToInput(outstanding, liability.currency))}>
              Pay the full {money(outstanding, liability.currency)}
            </Button>
            {principal !== null && total ? (
              <div className="rounded-lg bg-muted px-3 py-2 text-sm">
                <p className="flex justify-between gap-2">
                  <span>Reduces what is owed</span>
                  <span className="tabular-nums">{money(principal, liability.currency)}</span>
                </p>
                {interestMinor ? (
                  <p className="flex justify-between gap-2 text-muted-foreground">
                    <span>Interest (an expense)</span>
                    <span className="tabular-nums">{money(interestMinor, liability.currency)}</span>
                  </p>
                ) : null}
                <p className={cn("flex justify-between gap-2 border-t border-border pt-1", principal > outstanding && "text-red-600 dark:text-red-400")}>
                  <span>{principal > outstanding ? "More than is owed" : "Left to pay"}</span>
                  <span className="tabular-nums">{money(Math.max(0, outstanding - principal), liability.currency)}</span>
                </p>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Paid from" htmlFor={`${id}-account`}>
                <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} enabled={open} />
              </Field>
              <Field label="Date" htmlFor={`${id}-date`}>
                <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </Field>
            </div>
            <Field
              label="Record the payment as"
              hint={
                recordAs === "expense"
                  ? `An expense${liability.categoryName ? ` in ${liability.categoryName}` : ""}: paying a bill is when its cost counts.`
                  : "A debt payment: it reduces the debt and is not spending."
              }
            >
              <div className="flex gap-1.5">
                <Button type="button" size="xs" variant={recordAs === "debt_payment" ? "default" : "outline"} onClick={() => setRecordAs("debt_payment")}>
                  Debt payment
                </Button>
                <Button type="button" size="xs" variant={recordAs === "expense" ? "default" : "outline"} onClick={() => setRecordAs("expense")}>
                  Expense (bill)
                </Button>
              </div>
            </Field>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <AttachmentField value={attachments} onChange={setAttachments} label="Receipt (required)" hint="Saved with the payment transaction." />
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

export function LiabilityDetailView({ liability }: { liability: LiabilityDetail }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const open = liability.status !== "paid_off" && liability.status !== "cancelled";
  const linked = liability.transactions.length;

  const remove = async () => {
    try {
      await clientApi(`/liabilities/${liability.id}`, {
        method: "DELETE",
        query: { voidLinked: linked > 0 },
      });
      toast.success("Deleted");
      refresh();
      router.push("/wealth/liabilities");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const setCancelled = async (cancelled: boolean) => {
    try {
      await clientApi(`/liabilities/${liability.id}`, {
        method: "PATCH",
        body: { status: cancelled ? "cancelled" : "active" },
      });
      toast.success(cancelled ? "Marked as cancelled" : "Reopened");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              {[LIABILITY_KIND_LABELS[liability.kind], liability.counterparty, liability.currency].filter(Boolean).join(" · ")}
              <StatusBadge status={liability.status === "paid_off" ? "paid" : liability.status} label={liability.status.replace(/_/g, " ")} />
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{money(Math.max(0, liability.outstanding), liability.currency)}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              owed of {money(liability.total, liability.currency)} · {money(liability.paid, liability.currency)} paid
            </p>
            <ProgressBar value={paidShare(liability)} tone={liability.status === "overdue" ? "danger" : "good"} className="mt-2" />
            <div className="mt-2">
              <DueText status={liability.status} dueDate={liability.dueDate} daysOverdue={liability.daysOverdue} />
            </div>
            {liability.baseOutstanding === null && (
              <Link href="/settings/currency" className="block text-xs text-amber-600 hover:underline dark:text-amber-400">
                No {liability.currency} exchange rate — left out of net worth. Add one.
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
              {liability.status === "cancelled" ? (
                <Button size="sm" variant="ghost" onClick={() => void setCancelled(false)}>
                  Reopen
                </Button>
              ) : (
                open && (
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>
                    Cancel debt
                  </Button>
                )
              )}
              <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 self-start">
          <StatCard
            icon={Landmark}
            label="Borrowed or billed"
            value={money(liability.total, liability.currency)}
            hint={liability.borrowed ? `${money(liability.borrowed, liability.currency)} received into accounts` : undefined}
          />
          <StatCard
            icon={Wallet}
            label="Paid down"
            value={money(liability.paid, liability.currency)}
            hint={liability.lastPaymentDate ? `Last on ${formatDay(liability.lastPaymentDate)}` : "No payments yet"}
          />
          <StatCard
            icon={Percent}
            label="Interest paid"
            value={money(liability.interestPaid, liability.currency)}
            hint={liability.interestRate ? `${Number(liability.interestRate)}% a year` : "Recorded as an expense"}
          />
          <StatCard
            icon={CalendarClock}
            label="Next installment"
            value={liability.nextDueDate ? formatDay(liability.nextDueDate) : "—"}
            hint={liability.commitments.length ? `${liability.commitments.length} schedule` : "No schedule"}
            href={liability.commitments.length ? "/commitments?kind=loan_payment" : undefined}
          />
        </div>
      </div>

      {liability.commitments.length > 0 && (
        <Section title="Installment schedule" hint="Commitments with reminders" href="/commitments?kind=loan_payment" linkLabel="Commitments">
          <ul className="divide-y divide-border">
            {liability.commitments.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{c.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {FREQUENCY_LABELS[c.frequency as keyof typeof FREQUENCY_LABELS] ?? c.frequency}
                    {c.autoPay ? " · auto-debit" : ""}
                    {c.nextDueDate ? ` · next ${formatDay(c.nextDueDate)}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-sm tabular-nums">{money(c.amount, c.currency)}</span>
                  <StatusBadge status={c.status} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Payment history" hint="Borrowing, payments, and interest paid with them">
        {linked ? (
          <LinkedTransactions items={liability.transactions} empty="" />
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
            No payments recorded yet.
          </EmptyNote>
        )}
      </Section>

      <Section title="Details">
        <Facts
          items={[
            {
              label: "Opening balance owed",
              value: money(liability.openingOutstanding, liability.currency),
            },
            {
              label: "Since",
              value: liability.startDate ? formatDay(liability.startDate) : "—",
            },
            {
              label: "Due",
              value: liability.dueDate ? formatDay(liability.dueDate) : "—",
            },
            liability.categoryName ? { label: "Category", value: liability.categoryName } : false,
            liability.projectName ? { label: "Project", value: liability.projectName } : false,
            liability.unconvertedFlows > 0 && {
              label: "Not converted",
              value: `${liability.unconvertedFlows} transactions without an exchange rate`,
            },
            liability.notes ? { label: "Notes", value: liability.notes } : false,
          ]}
        />
      </Section>

      <LiabilityFormDialog open={editing} onOpenChange={setEditing} liability={liability} />
      <PaymentDialog open={paying} onOpenChange={setPaying} liability={liability} />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this debt?"
        description="Use this when it was forgiven or written off. It stops counting in net worth; payments already made stay in the ledger."
        confirmLabel="Cancel debt"
        onConfirm={() => setCancelled(true)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${liability.name}?`}
        description={
          linked
            ? `Its ${linked} linked transaction${linked === 1 ? " is" : "s are"} voided too (borrowing, payments and interest), so balances change back. To keep the history, cancel it instead.`
            : "It is removed; no money moved through it."
        }
        confirmLabel={linked ? "Delete and void" : "Delete"}
        onConfirm={remove}
      />
    </div>
  );
}
