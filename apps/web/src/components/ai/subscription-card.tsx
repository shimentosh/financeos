"use client";

import { COMMON_CURRENCIES, minorToInput, parseMoneyInput } from "@financeos/core";
import { Repeat } from "lucide-react";
import { useId } from "react";
import { ConfidenceMeter } from "@/components/app/blocks";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BillingCycle, SubscriptionSuggestion } from "@/lib/api/types/ai";
import { Segmented, SourceTag } from "./shared";

export type SubscriptionDecision = "track" | "skip" | "later";

export type SubscriptionForm = {
  provider: string;
  planName: string;
  billingCycle: BillingCycle | "";
  nextRenewalDate: string;
  expiryDate: string;
  cancellationDeadline: string;
  autoRenew: boolean;
  renewalAmount: string;
  currency: string;
};

const CYCLES: Array<{ value: BillingCycle; label: string }> = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "half_yearly", label: "Every 6 months" },
  { value: "yearly", label: "Yearly" },
  { value: "custom", label: "Custom" },
];

export function subscriptionForm(suggestion: SubscriptionSuggestion | null, fallbackCurrency: string): SubscriptionForm {
  const currency = suggestion?.currency ?? fallbackCurrency;
  return {
    provider: suggestion?.provider ?? "",
    planName: suggestion?.planName ?? "",
    billingCycle: suggestion?.billingCycle ?? "",
    nextRenewalDate: suggestion?.nextRenewalDate ?? "",
    expiryDate: suggestion?.expiryDate ?? "",
    cancellationDeadline: suggestion?.cancellationDeadline ?? "",
    autoRenew: suggestion?.autoRenew ?? true,
    renewalAmount: suggestion?.renewalAmount ? minorToInput(suggestion.renewalAmount, currency) : "",
    currency,
  };
}

/** The confirm body's `subscription`: an object, null (declined), or undefined (decide later). */
export function subscriptionBody(
  decision: SubscriptionDecision,
  form: SubscriptionForm,
): { ok: true; value: Record<string, unknown> | null | undefined } | { ok: false; error: string } {
  if (decision === "later") return { ok: true, value: undefined };
  if (decision === "skip") return { ok: true, value: null };
  if (!form.provider.trim()) return { ok: false, error: "Name the subscription provider" };
  if (!form.billingCycle) return { ok: false, error: "Choose how often it renews" };
  if (!form.nextRenewalDate) return { ok: false, error: "Enter the next renewal date" };
  const renewalAmount = form.renewalAmount.trim() ? parseMoneyInput(form.renewalAmount, form.currency) : null;
  if (form.renewalAmount.trim() && !renewalAmount) return { ok: false, error: `Enter the renewal amount in ${form.currency}` };
  return {
    ok: true,
    value: {
      provider: form.provider.trim(),
      planName: form.planName.trim() || null,
      billingCycle: form.billingCycle,
      nextRenewalDate: form.nextRenewalDate,
      expiryDate: form.expiryDate || null,
      cancellationDeadline: form.cancellationDeadline || null,
      autoRenew: form.autoRenew,
      ...(renewalAmount ? { renewalAmount } : {}),
    },
  };
}

export function SubscriptionCard({
  suggestion,
  decision,
  onDecision,
  form,
  onForm,
  disabled,
  error,
}: {
  suggestion: SubscriptionSuggestion | null;
  decision: SubscriptionDecision;
  onDecision: (decision: SubscriptionDecision) => void;
  form: SubscriptionForm;
  onForm: (form: SubscriptionForm) => void;
  disabled: boolean;
  error?: string | null;
}) {
  const id = useId();
  const set = <K extends keyof SubscriptionForm>(key: K, value: SubscriptionForm[K]) => onForm({ ...form, [key]: value });
  return (
    <section className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-300">
          <Repeat className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{suggestion ? `Looks like a subscription: ${suggestion.provider}` : "Track this as a subscription"}</p>
          <p className="text-xs text-muted-foreground">
            Tracking adds renewal reminders and links this payment as the first charge. It never records the payment twice.
          </p>
        </div>
        {suggestion && (
          <span className="flex shrink-0 items-center gap-1.5">
            <SourceTag source={suggestion.source === "ai" ? "ai" : "parser"} />
            <ConfidenceMeter value={suggestion.confidence} />
          </span>
        )}
      </div>

      <Segmented
        value={decision}
        onChange={onDecision}
        label="Subscription"
        items={[
          { value: "track", label: "Track it" },
          { value: "skip", label: "Not a subscription" },
          { value: "later", label: "Decide later" },
        ]}
      />
      {decision === "later" && <p className="text-xs text-muted-foreground">It will wait in the AI Inbox so you can decide when you have a moment.</p>}

      {decision === "track" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-provider`} className="text-xs">
              Provider
            </Label>
            <Input
              id={`${id}-provider`}
              value={form.provider}
              disabled={disabled}
              onChange={(e) => set("provider", e.target.value)}
              placeholder="Netflix, ChatGPT…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-plan`} className="text-xs">
              Plan
            </Label>
            <Input
              id={`${id}-plan`}
              value={form.planName}
              disabled={disabled}
              onChange={(e) => set("planName", e.target.value)}
              placeholder="Standard, Plus…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-cycle`} className="text-xs">
              Renews
            </Label>
            <Select
              value={form.billingCycle || null}
              disabled={disabled}
              onValueChange={(v) => typeof v === "string" && set("billingCycle", v as BillingCycle)}
            >
              <SelectTrigger id={`${id}-cycle`}>
                <SelectValue>{CYCLES.find((c) => c.value === form.billingCycle)?.label ?? "Choose"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CYCLES.map((cycle) => (
                  <SelectItem key={cycle.value} value={cycle.value}>
                    {cycle.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-next`} className="text-xs">
              Next renewal
              {suggestion?.renewalDateEstimated && form.nextRenewalDate === suggestion.nextRenewalDate && (
                <span className="ms-1 font-normal text-amber-600 dark:text-amber-400">· estimate</span>
              )}
            </Label>
            <Input id={`${id}-next`} type="date" value={form.nextRenewalDate} disabled={disabled} onChange={(e) => set("nextRenewalDate", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-amount`} className="text-xs">
              Renewal amount
            </Label>
            <div className="grid grid-cols-[1fr_5.5rem] gap-2">
              <Input
                id={`${id}-amount`}
                inputMode="decimal"
                value={form.renewalAmount}
                disabled={disabled}
                placeholder="Same as this payment"
                onChange={(e) => set("renewalAmount", e.target.value)}
                className="tabular-nums"
              />
              <Select value={form.currency} disabled={disabled} onValueChange={(v) => typeof v === "string" && set("currency", v)}>
                <SelectTrigger aria-label="Renewal currency" className="min-w-0">
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
          <div className="flex items-center justify-between gap-3 self-end rounded-lg border border-border bg-background px-3 py-2">
            <Label htmlFor={`${id}-auto`} className="font-normal">
              Renews automatically
            </Label>
            <Switch id={`${id}-auto`} checked={form.autoRenew} disabled={disabled} onCheckedChange={(checked) => set("autoRenew", checked)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-expiry`} className="text-xs">
              Access ends
            </Label>
            <Input id={`${id}-expiry`} type="date" value={form.expiryDate} disabled={disabled} onChange={(e) => set("expiryDate", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-cancel`} className="text-xs">
              Cancel by
            </Label>
            <Input
              id={`${id}-cancel`}
              type="date"
              value={form.cancellationDeadline}
              disabled={disabled}
              onChange={(e) => set("cancellationDeadline", e.target.value)}
            />
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </section>
  );
}
