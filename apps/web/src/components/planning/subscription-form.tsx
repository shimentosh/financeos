"use client";

import { addDays, addMonths, addYears, COMMON_CURRENCIES, INTERVAL_UNITS, type IntervalUnit, minorToInput, parseMoneyInput, today } from "@expensewise/core";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { BillingCycle, SubscriptionDetail, SubscriptionView } from "@/lib/api/types/planning";
import { toast } from "@/lib/toast";
import { invalidateApiCache, useApi } from "@/lib/use-api";
import { accountOptions, categoryOptions, Field, FormError, fromOption, NONE, OptionSelect, projectOptions, ReminderOffsetsField, useCatalog } from "./shared";

export const BILLING_LABELS: Record<BillingCycle, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Every 6 months",
  yearly: "Yearly",
  custom: "Custom interval",
};

/** One cycle after `day`, for the next-renewal default. */
export function nextCycle(day: string, cycle: BillingCycle, count = 1, unit: IntervalUnit = "month"): string {
  if (cycle === "monthly") return addMonths(day, 1);
  if (cycle === "quarterly") return addMonths(day, 3);
  if (cycle === "half_yearly") return addMonths(day, 6);
  if (cycle === "yearly") return addYears(day, 1);
  if (unit === "day") return addDays(day, count);
  if (unit === "week") return addDays(day, count * 7);
  if (unit === "year") return addYears(day, count);
  return addMonths(day, count);
}

const QUICK = ["Netflix", "Spotify", "ChatGPT", "Claude", "Google One", "iCloud", "Canva", "Figma", "Notion", "GitHub", "Domain", "Hosting"];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this subscription; create when absent. */
  subscription?: SubscriptionView | SubscriptionDetail | null;
  onSaved?: (id: string) => void;
};

/** Every fact of a subscription: plan, money, every date, renewal behaviour, reminders. */
export function SubscriptionFormDialog({ open, onOpenChange, subscription, onSaved }: Props) {
  const id = useId();
  const router = useRouter();
  const { workspace, isBusiness } = useApp();
  const { accounts, categories, projects } = useCatalog({ projects: isBusiness });
  const editing = Boolean(subscription);

  const [provider, setProvider] = useState("");
  const [planName, setPlanName] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("month");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [trialEndsOn, setTrialEndsOn] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [nextRenewalDate, setNextRenewalDate] = useState("");
  const [cancellationDeadline, setCancellationDeadline] = useState("");
  const [autoRenew, setAutoRenew] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [reminderOffsets, setReminderOffsets] = useState<number[] | null>(null);
  const [notes, setNotes] = useState("");
  const [recordPurchase, setRecordPurchase] = useState(false);
  const [purchaseAccountId, setPurchaseAccountId] = useState<string | null>(null);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renewalTouched, setRenewalTouched] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentTouched, setAttachmentTouched] = useState(false);
  const savedFile = useApi<Attachment>(open && subscription?.attachmentFileId ? `/files/${subscription.attachmentFileId}/info` : null);

  useEffect(() => {
    if (!open) return;
    const day = today(workspace.timezone);
    const s = subscription;
    setError(null);
    setProvider(s?.provider ?? "");
    setPlanName(s?.planName ?? "");
    setName(s && s.name !== `${s.provider}${s.planName ? ` ${s.planName}` : ""}` ? s.name : "");
    setAmount(s ? minorToInput(s.amount, s.currency) : "");
    setCurrency(s?.currency ?? workspace.baseCurrency);
    setBillingCycle(s?.billingCycle ?? "monthly");
    setIntervalCount(String(s?.intervalCount ?? 1));
    setIntervalUnit(s?.intervalUnit ?? "month");
    setPurchaseDate(s?.purchaseDate ?? (s ? "" : day));
    setStartDate(s?.startDate ?? day);
    setTrialEndsOn(s?.trialEndsOn ?? "");
    setExpiryDate(s?.expiryDate ?? "");
    setNextRenewalDate(s?.nextRenewalDate ?? (s ? "" : addMonths(day, 1)));
    setCancellationDeadline(s?.cancellationDeadline ?? "");
    setAutoRenew(s?.autoRenew ?? true);
    setAccountId(s?.accountId ?? null);
    setCategoryId(s?.categoryId ?? null);
    setProjectId(s?.projectId ?? null);
    setReminderOffsets(s?.reminderOffsets?.length ? s.reminderOffsets : null);
    setNotes(s?.notes ?? "");
    setRecordPurchase(false);
    setPurchaseAccountId(null);
    setPurchaseAmount("");
    setRenewalTouched(Boolean(s));
    setAttachments([]);
    setAttachmentTouched(false);
  }, [open, subscription, workspace.baseCurrency, workspace.timezone]);

  useEffect(() => {
    if (open && !attachmentTouched && savedFile.data) setAttachments([savedFile.data]);
  }, [open, attachmentTouched, savedFile.data]);

  const changeAttachments = (next: Attachment[]) => {
    setAttachments(next);
    setAttachmentTouched(true);
  };

  const close = (next: boolean) => {
    if (!next) discardNewAttachments(attachments);
    onOpenChange(next);
  };

  // Until the user picks one, the next renewal follows the start date and cycle.
  useEffect(() => {
    if (renewalTouched || !startDate) return;
    const from = trialEndsOn || startDate;
    setNextRenewalDate(trialEndsOn ? trialEndsOn : nextCycle(from, billingCycle, Number(intervalCount) || 1, intervalUnit));
  }, [startDate, trialEndsOn, billingCycle, intervalCount, intervalUnit, renewalTouched]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const amountMinor = parseMoneyInput(amount, currency);
    if (!amountMinor) return setError("Enter the renewal amount, e.g. 20 or 1,850");
    if (!provider.trim()) return setError("Who is the subscription with?");
    if (!nextRenewalDate && !editing) return setError("When does it renew next?");
    const count = Number(intervalCount);
    if (billingCycle === "custom" && (!Number.isInteger(count) || count < 1)) return setError("Enter how many days, weeks, months or years per cycle");
    let purchase: { accountId: string | null; date: string; amount?: number } | null = null;
    if (!editing && recordPurchase) {
      const date = purchaseDate || startDate;
      const paid = purchaseAmount ? parseMoneyInput(purchaseAmount, currency) : null;
      if (purchaseAmount && !paid) return setError("Enter the purchase amount as a number");
      if (!(purchaseAccountId ?? accountId)) return setError("Choose the account the purchase was paid from");
      purchase = { accountId: purchaseAccountId ?? accountId, date, ...(paid ? { amount: paid } : {}) };
    }
    const body = {
      provider: provider.trim(),
      planName: planName.trim() || null,
      ...(name.trim() ? { name: name.trim() } : {}),
      amount: amountMinor,
      currency,
      billingCycle,
      intervalCount: billingCycle === "custom" ? count : 1,
      intervalUnit: billingCycle === "custom" ? intervalUnit : null,
      purchaseDate: purchaseDate || null,
      startDate: startDate || purchaseDate || today(workspace.timezone),
      trialEndsOn: trialEndsOn || null,
      expiryDate: expiryDate || null,
      ...(nextRenewalDate ? { nextRenewalDate } : {}),
      cancellationDeadline: cancellationDeadline || null,
      autoRenew,
      accountId,
      categoryId,
      projectId: isBusiness ? projectId : null,
      reminderOffsets,
      notes: notes.trim() || null,
      ...(!editing || attachmentTouched ? { attachmentFileId: attachments[0]?.id ?? null } : {}),
      ...(purchase ? { recordPurchase: purchase } : {}),
    };
    setSaving(true);
    try {
      const saved = subscription
        ? await clientApi<SubscriptionDetail>(`/subscriptions/${subscription.id}`, { method: "PATCH", body })
        : await clientApi<SubscriptionDetail>("/subscriptions", { method: "POST", body });
      toast.success(subscription ? "Subscription updated" : `${saved.name} added`, {
        description: saved.nextRenewalDate ? `Next renewal ${saved.nextRenewalDate}` : undefined,
      });
      invalidateApiCache("/subscriptions");
      invalidateApiCache("/commitments");
      // Saved with the subscription now: closing must not remove it.
      setAttachments([]);
      onOpenChange(false);
      onSaved?.(saved.id);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const date = (label: string, value: string, set: (v: string) => void, hint?: string, required = false) => (
    <Field label={label} htmlFor={`${id}-${label}`} hint={hint}>
      <Input id={`${id}-${label}`} type="date" value={value} required={required} onChange={(e) => set(e.target.value)} />
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="w-full max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{subscription ? `Edit ${subscription.name}` : "Add subscription"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {!editing && (
              <div className="flex flex-wrap gap-1.5">
                {QUICK.map((q) => (
                  <Button key={q} type="button" size="xs" variant={provider === q ? "default" : "outline"} onClick={() => setProvider(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider" htmlFor={`${id}-provider`}>
                <Input id={`${id}-provider`} required value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Netflix, Anthropic…" />
              </Field>
              <Field label="Plan" htmlFor={`${id}-plan`}>
                <Input id={`${id}-plan`} value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="Premium, Pro…" />
              </Field>
            </div>
            <Field label="Display name" htmlFor={`${id}-name`} hint="Leave empty to use provider and plan.">
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${provider}${planName ? ` ${planName}` : ""}` || "Optional"}
              />
            </Field>

            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <Field label="Renewal amount" htmlFor={`${id}-amount`}>
                <Input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="tabular-nums"
                />
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
              <Field label="Billing cycle" htmlFor={`${id}-cycle`}>
                <OptionSelect
                  id={`${id}-cycle`}
                  value={billingCycle}
                  onChange={(v) => setBillingCycle(v as BillingCycle)}
                  options={(Object.keys(BILLING_LABELS) as BillingCycle[]).map((cycle) => ({ value: cycle, label: BILLING_LABELS[cycle] }))}
                  placeholder="Cycle"
                />
              </Field>
              {billingCycle === "custom" ? (
                <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                  <Field label="Every" htmlFor={`${id}-count`}>
                    <Input id={`${id}-count`} inputMode="numeric" value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/\D/g, ""))} />
                  </Field>
                  <Field label="Unit" htmlFor={`${id}-unit`}>
                    <OptionSelect
                      id={`${id}-unit`}
                      value={intervalUnit}
                      onChange={(v) => setIntervalUnit(v as IntervalUnit)}
                      options={INTERVAL_UNITS.map((unit) => ({ value: unit, label: `${unit}s` }))}
                      placeholder="Unit"
                    />
                  </Field>
                </div>
              ) : (
                <div />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {date("Purchase date", purchaseDate, setPurchaseDate)}
              {date("Start date", startDate, setStartDate, undefined, true)}
              {date("Trial ends", trialEndsOn, setTrialEndsOn, "Only for free trials.")}
              <Field label="Next renewal" htmlFor={`${id}-renewal`} hint="When the next charge is due.">
                <Input
                  id={`${id}-renewal`}
                  type="date"
                  required={!editing}
                  value={nextRenewalDate}
                  onChange={(e) => {
                    setNextRenewalDate(e.target.value);
                    setRenewalTouched(true);
                  }}
                />
              </Field>
              {date("Expiry date", expiryDate, setExpiryDate, "When access ends if not renewed.")}
              {date("Cancellation deadline", cancellationDeadline, setCancellationDeadline, "Last day to cancel without paying for the next period.")}
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <span>
                Renews automatically
                <span className="block text-xs text-muted-foreground">
                  {autoRenew ? "Reminders say the renewal payment is expected." : "Reminders say a manual renewal is required before it lapses."}
                </span>
              </span>
              <Switch checked={autoRenew} onCheckedChange={setAutoRenew} />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Paid from" htmlFor={`${id}-account`}>
                <OptionSelect
                  id={`${id}-account`}
                  value={accountId ?? NONE}
                  onChange={(v) => setAccountId(fromOption(v))}
                  options={accountOptions(accounts)}
                  placeholder="Account"
                />
              </Field>
              <Field label="Category" htmlFor={`${id}-category`}>
                <OptionSelect
                  id={`${id}-category`}
                  value={categoryId ?? NONE}
                  onChange={(v) => setCategoryId(fromOption(v))}
                  options={categoryOptions(categories, "expense")}
                  placeholder="Category"
                />
              </Field>
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

            <ReminderOffsetsField value={reminderOffsets} onChange={setReminderOffsets} defaults={workspace.settings.reminderOffsets} />

            {!editing && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    Also record the purchase as an expense
                    <span className="block text-xs text-muted-foreground">
                      Skip this if the payment is already in your transactions — link it from the renewal history instead.
                    </span>
                  </span>
                  <Switch checked={recordPurchase} onCheckedChange={setRecordPurchase} />
                </label>
                {recordPurchase && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Paid from" htmlFor={`${id}-paccount`}>
                      <OptionSelect
                        id={`${id}-paccount`}
                        value={purchaseAccountId ?? accountId ?? NONE}
                        onChange={(v) => setPurchaseAccountId(fromOption(v))}
                        options={accountOptions(accounts, "Choose an account")}
                        placeholder="Account"
                      />
                    </Field>
                    <Field label="Amount paid" htmlFor={`${id}-pamount`} hint={`On ${purchaseDate || startDate || "the purchase date"}.`}>
                      <Input
                        id={`${id}-pamount`}
                        inputMode="decimal"
                        value={purchaseAmount}
                        onChange={(e) => setPurchaseAmount(e.target.value)}
                        placeholder={amount || "Same as renewal"}
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}

            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea
                id={`${id}-notes`}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Account email, what it is used for…"
              />
            </Field>
            <AttachmentField
              value={attachments}
              onChange={changeAttachments}
              max={1}
              label="Invoice or receipt"
              disabled={Boolean(subscription?.attachmentFileId && !savedFile.data && !savedFile.error && !attachmentTouched)}
              hint={recordPurchase ? "Also attached to the purchase expense recorded below." : "The purchase invoice or the latest receipt."}
            />
            <FormError message={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {subscription ? "Save" : "Add subscription"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
