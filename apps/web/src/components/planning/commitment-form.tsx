"use client";

import {
  COMMITMENT_KIND_LABELS,
  COMMON_CURRENCIES,
  type CommitmentKind,
  FREQUENCIES,
  FREQUENCY_LABELS,
  type Frequency,
  INTERVAL_UNITS,
  type IntervalUnit,
  minorToInput,
  parseMoneyInput,
  today,
} from "@expensewise/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { CommitmentRow } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache, useApi } from "@/lib/use-api";
import { accountOptions, categoryOptions, Field, FormError, fromOption, NONE, OptionSelect, projectOptions, ReminderOffsetsField, useCatalog } from "./shared";

/** Kinds offered when adding a commitment (subscriptions have their own form). */
const KINDS: CommitmentKind[] = [
  "rent",
  "utility",
  "loan_payment",
  "insurance",
  "tax",
  "salary",
  "payroll",
  "contractor",
  "domain",
  "hosting",
  "software",
  "education",
  "income",
  "custom",
];

const NAME_HINTS: Partial<Record<CommitmentKind, string>> = {
  rent: "Flat rent",
  utility: "Electricity bill",
  loan_payment: "Car loan installment",
  insurance: "Health insurance premium",
  tax: "Income tax installment",
  salary: "Salary",
  payroll: "Monthly payroll",
  contractor: "Designer retainer",
  domain: "example.com renewal",
  hosting: "VPS hosting",
  software: "Accounting software",
  education: "School fees",
  income: "Client retainer",
  custom: "Anything on a schedule",
};

function defaultDirection(kind: CommitmentKind, business: boolean): "in" | "out" {
  if (kind === "income") return "in";
  if (kind === "salary") return business ? "out" : "in";
  return "out";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commitment?: CommitmentRow | null;
  onSaved?: (id: string) => void;
};

/** Rent, salary, loan installments, insurance, tax, bills and expected income. */
export function CommitmentFormDialog({ open, onOpenChange, commitment, onSaved }: Props) {
  const id = useId();
  const router = useRouter();
  const { workspace, isBusiness } = useApp();
  const { accounts, categories, projects } = useCatalog({ projects: isBusiness });

  const [kind, setKind] = useState<CommitmentKind>("rent");
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [name, setName] = useState("");
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("month");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [liabilityId, setLiabilityId] = useState<string | null>(null);
  const [autoPay, setAutoPay] = useState(false);
  const [reminderOffsets, setReminderOffsets] = useState<number[] | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const liabilities = useApi<{ items: Array<{ id: string; name: string; status: string }> }>(open && kind === "loan_payment" ? "/liabilities" : null);

  useEffect(() => {
    if (!open) return;
    const c = commitment;
    setError(null);
    setKind(c?.kind ?? "rent");
    setDirection(c?.direction ?? defaultDirection("rent", isBusiness));
    setName(c?.name ?? "");
    setPayee(c?.payee ?? "");
    setAmount(c ? minorToInput(c.amount, c.currency) : "");
    setCurrency(c?.currency ?? workspace.baseCurrency);
    setFrequency(c?.frequency ?? "monthly");
    setIntervalCount(String(c?.intervalCount ?? 1));
    setIntervalUnit(c?.intervalUnit ?? "month");
    setStartDate(c?.startDate ?? today(workspace.timezone));
    setEndDate(c?.endDate ?? "");
    setNextDueDate("");
    setAccountId(c?.accountId ?? null);
    setCategoryId(c?.categoryId ?? null);
    setProjectId(c?.projectId ?? null);
    setLiabilityId(c?.liabilityId ?? null);
    setAutoPay(c?.autoPay ?? false);
    setReminderOffsets(c?.reminderOffsets?.length ? c.reminderOffsets : null);
    setNotes(c?.notes ?? "");
  }, [open, commitment, isBusiness, workspace.baseCurrency, workspace.timezone]);

  const chooseKind = (next: CommitmentKind) => {
    setKind(next);
    const nextDirection = defaultDirection(next, isBusiness);
    if (nextDirection !== direction) {
      setDirection(nextDirection);
      setCategoryId(null);
    }
    if (next === "loan_payment") setCategoryId(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const amountMinor = parseMoneyInput(amount, currency);
    if (!amountMinor) return setError("Enter the amount due each time, e.g. 25,000");
    const count = Number(intervalCount);
    if (frequency === "custom" && (!Number.isInteger(count) || count < 1)) return setError("Enter how many days, weeks, months or years apart");
    const body = {
      kind,
      direction,
      name: name.trim() || NAME_HINTS[kind] || COMMITMENT_KIND_LABELS[kind],
      payee: payee.trim() || null,
      amount: amountMinor,
      currency,
      frequency,
      intervalCount: frequency === "custom" ? count : 1,
      intervalUnit: frequency === "custom" ? intervalUnit : null,
      startDate,
      endDate: endDate || null,
      ...(nextDueDate ? { nextDueDate } : {}),
      accountId,
      categoryId: kind === "loan_payment" ? null : categoryId,
      projectId: isBusiness ? projectId : null,
      liabilityId: kind === "loan_payment" ? liabilityId : null,
      autoPay,
      reminderOffsets,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      const saved = commitment
        ? await clientApi<{ id: string; name: string }>(`/commitments/${commitment.id}`, { method: "PATCH", body })
        : await clientApi<{ id: string; name: string }>("/commitments", { method: "POST", body });
      toast.success(commitment ? "Commitment updated" : `${saved.name} added`);
      invalidateApiCache("/commitments");
      onOpenChange(false);
      onSaved?.(saved.id);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const incoming = direction === "in";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{commitment ? `Edit ${commitment.name}` : "Add commitment"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">What is it?</p>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <Button key={k} type="button" size="xs" variant={kind === k ? "default" : "outline"} onClick={() => chooseKind(k)}>
                    {COMMITMENT_KIND_LABELS[k]}
                  </Button>
                ))}
              </div>
              {!commitment && (
                <p className="text-xs text-muted-foreground">
                  A subscription?{" "}
                  <Link href="/subscriptions?new=1" className="underline-offset-4 hover:underline">
                    Add it as a subscription
                  </Link>{" "}
                  to track renewals, expiry and cancellation deadlines.
                </p>
              )}
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1" role="radiogroup" aria-label="Direction">
              {(["out", "in"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={direction === value}
                  onClick={() => {
                    setDirection(value);
                    setCategoryId(null);
                  }}
                  className={cn(
                    "flex-1 rounded-md px-2.5 py-1 text-xs transition-colors",
                    direction === value ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
                  )}
                >
                  {value === "out" ? "Money going out" : "Expected income"}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" htmlFor={`${id}-name`}>
                <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder={NAME_HINTS[kind]} />
              </Field>
              <Field label={incoming ? "From" : "Paid to"} htmlFor={`${id}-payee`}>
                <Input
                  id={`${id}-payee`}
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  placeholder={incoming ? "Employer, client" : "Landlord, DESCO, bank"}
                />
              </Field>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <Field label="Amount each time" htmlFor={`${id}-amount`}>
                <Input id={`${id}-amount`} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <OptionSelect
                  id={`${id}-currency`}
                  value={currency}
                  onChange={setCurrency}
                  options={[...new Set([currency, ...COMMON_CURRENCIES])].map((code) => ({ value: code, label: code }))}
                  placeholder="Currency"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="How often" htmlFor={`${id}-frequency`}>
                <OptionSelect
                  id={`${id}-frequency`}
                  value={frequency}
                  onChange={(v) => setFrequency(v as Frequency)}
                  options={FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] }))}
                  placeholder="Frequency"
                />
              </Field>
              {frequency === "custom" ? (
                <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                  <Field label="Every" htmlFor={`${id}-count`}>
                    <Input id={`${id}-count`} inputMode="numeric" value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/\D/g, ""))} />
                  </Field>
                  <Field label="Unit" htmlFor={`${id}-unit`}>
                    <OptionSelect
                      id={`${id}-unit`}
                      value={intervalUnit}
                      onChange={(v) => setIntervalUnit(v as IntervalUnit)}
                      options={INTERVAL_UNITS.map((u) => ({ value: u, label: `${u}s` }))}
                      placeholder="Unit"
                    />
                  </Field>
                </div>
              ) : (
                <div />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field
                label={frequency === "once" ? "Due on" : "First due"}
                htmlFor={`${id}-start`}
                hint={frequency === "once" ? undefined : "Sets the day it repeats on."}
              >
                <Input id={`${id}-start`} type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              {frequency !== "once" && (
                <Field label="Ends" htmlFor={`${id}-end`} hint="Optional.">
                  <Input id={`${id}-end`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </Field>
              )}
              {frequency !== "once" && (
                <Field
                  label="Next due"
                  htmlFor={`${id}-next`}
                  hint={commitment?.nextDueDate ? `Now ${commitment.nextDueDate}.` : "If not the next date on the schedule."}
                >
                  <Input id={`${id}-next`} type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
                </Field>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label={incoming ? "Received into" : "Paid from"} htmlFor={`${id}-account`}>
                <OptionSelect
                  id={`${id}-account`}
                  value={accountId ?? NONE}
                  onChange={(v) => setAccountId(fromOption(v))}
                  options={accountOptions(accounts)}
                  placeholder="Account"
                />
              </Field>
              {kind === "loan_payment" ? (
                <Field label="Loan" htmlFor={`${id}-loan`} hint="Payments reduce what is owed on it.">
                  <OptionSelect
                    id={`${id}-loan`}
                    value={liabilityId ?? NONE}
                    onChange={(v) => setLiabilityId(fromOption(v))}
                    options={[
                      { value: NONE, label: "Not linked" },
                      ...(liabilities.data?.items ?? []).filter((l) => l.status !== "cancelled").map((l) => ({ value: l.id, label: l.name })),
                    ]}
                    placeholder="Loan"
                  />
                </Field>
              ) : (
                <Field label="Category" htmlFor={`${id}-category`}>
                  <OptionSelect
                    id={`${id}-category`}
                    value={categoryId ?? NONE}
                    onChange={(v) => setCategoryId(fromOption(v))}
                    options={categoryOptions(categories, incoming ? "income" : "expense")}
                    placeholder="Category"
                  />
                </Field>
              )}
              {isBusiness && (
                <Field label="Project" htmlFor={`${id}-project`}>
                  <OptionSelect
                    id={`${id}-project`}
                    value={projectId ?? NONE}
                    onChange={(v) => setProjectId(fromOption(v))}
                    options={projectOptions(projects)}
                    placeholder="Project"
                  />
                </Field>
              )}
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <span>
                {incoming ? "Arrives automatically" : "Paid automatically"}
                <span className="block text-xs text-muted-foreground">Auto-debit or standing order. You still confirm it when it lands.</span>
              </span>
              <Switch checked={autoPay} onCheckedChange={setAutoPay} />
            </label>

            <ReminderOffsetsField value={reminderOffsets} onChange={setReminderOffsets} defaults={workspace.settings.reminderOffsets} />

            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <FormError message={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {commitment ? "Save" : "Add commitment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
