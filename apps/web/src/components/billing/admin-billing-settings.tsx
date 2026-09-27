"use client";

import { minorToInput, parseMoneyInput } from "@expensewise/core";
import { Check, CircleAlert, Copy, FlaskConical, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Callout } from "@/components/ai/shared";
import { Section } from "@/components/app/blocks";
import { OptionSelect } from "@/components/planning/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { BillingConfigInput, BillingConfigView, BillingInterval, BillingTestResult, PlanId } from "@/lib/api/types/billing";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

const GB = 1024 ** 3;
const PLAN_ORDER: PlanId[] = ["free", "pro", "business"];

/** `key` only identifies a row while editing (React keys); it is never sent. */
type PriceRow = { key: string; interval: BillingInterval; currency: string; amount: string };
type PlanForm = { workspaces: string; members: string; storageGb: string; aiCredits: string; apiAccess: boolean; integrations: boolean; prices: PriceRow[] };
type PackForm = { key: string; id: string; credits: string; prices: Array<{ key: string; currency: string; amount: string }> };

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;
type Form = {
  enabled: boolean;
  creditsPerUsd: string;
  trial: { enabled: boolean; days: string; plan: "pro" | "business" };
  plans: Record<PlanId, PlanForm>;
  packs: PackForm[];
  stripe: { enabled: boolean; secretKey: string; webhookSecret: string };
  sslcommerz: { enabled: boolean; storeId: string; storePassword: string; sandbox: boolean };
  manual: { enabled: boolean; instructions: string };
};

const countText = (value: number | null) => (value === null ? "" : String(value));

function formFor(view: BillingConfigView): Form {
  const plan = (id: PlanId): PlanForm => {
    const { limits, prices } = view.plans[id];
    return {
      workspaces: countText(limits.workspaces),
      members: countText(limits.membersPerWorkspace),
      storageGb: limits.storageBytes === null ? "" : String(Math.round((limits.storageBytes / GB) * 100) / 100),
      aiCredits: String(limits.aiCreditsPerMonth),
      apiAccess: limits.apiAccess,
      integrations: limits.integrations,
      prices: prices.map((p) => ({ key: rowKey(), interval: p.interval, currency: p.currency, amount: minorToInput(p.amount, p.currency) })),
    };
  };
  return {
    enabled: view.enabled,
    creditsPerUsd: String(view.creditsPerUsd),
    trial: { enabled: view.trial.enabled, days: String(view.trial.days), plan: view.trial.plan === "business" ? "business" : "pro" },
    plans: { free: plan("free"), pro: plan("pro"), business: plan("business") },
    packs: view.creditPacks.map((pack) => ({
      key: rowKey(),
      id: pack.id,
      credits: String(pack.credits),
      prices: pack.prices.map((p) => ({ key: rowKey(), currency: p.currency, amount: minorToInput(p.amount, p.currency) })),
    })),
    stripe: { enabled: view.providers.stripe.enabled, secretKey: "", webhookSecret: "" },
    sslcommerz: {
      enabled: view.providers.sslcommerz.enabled,
      storeId: view.providers.sslcommerz.storeId ?? "",
      storePassword: "",
      sandbox: view.providers.sslcommerz.sandbox,
    },
    manual: { enabled: view.providers.manual.enabled, instructions: view.providers.manual.instructions ?? "" },
  };
}

class FormError extends Error {}

function count(text: string, label: string, nullable: true): number | null;
function count(text: string, label: string, nullable: false): number;
function count(text: string, label: string, nullable: boolean): number | null {
  const trimmed = text.trim();
  if (!trimmed) {
    if (nullable) return null;
    throw new FormError(`${label}: enter a number`);
  }
  const value = Number(trimmed.replace(/,/g, ""));
  if (!Number.isInteger(value) || value < 0) throw new FormError(`${label}: enter a whole number`);
  return value;
}

function minor(text: string, currency: string, label: string): number {
  const value = parseMoneyInput(text, currency);
  if (value === null) throw new FormError(`${label}: "${text}" isn't an amount in ${currency}`);
  return value;
}

function currencyCode(text: string, label: string) {
  const code = text.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new FormError(`${label}: use a 3-letter currency code`);
  return code;
}

function toInput(form: Form): BillingConfigInput {
  const plan = (id: PlanId) => {
    const p = form.plans[id];
    const name = id[0]?.toUpperCase() + id.slice(1);
    const storage = p.storageGb.trim();
    const gb = storage ? Number(storage) : null;
    if (gb !== null && !(gb >= 0)) throw new FormError(`${name}: storage must be a number of GB`);
    return {
      limits: {
        workspaces: count(p.workspaces, `${name} workspaces`, true),
        membersPerWorkspace: count(p.members, `${name} people per workspace`, true),
        storageBytes: gb === null ? null : Math.round(gb * GB),
        aiCreditsPerMonth: count(p.aiCredits, `${name} AI credits`, false),
        apiAccess: p.apiAccess,
        integrations: p.integrations,
      },
      prices: p.prices.map((row) => {
        const currency = currencyCode(row.currency, `${name} price`);
        return { interval: row.interval, currency, amount: minor(row.amount, currency, `${name} price`) };
      }),
    };
  };
  return {
    enabled: form.enabled,
    creditsPerUsd: count(form.creditsPerUsd, "Credits per US$1", false),
    trial: { enabled: form.trial.enabled, days: count(form.trial.days, "Trial days", false), plan: form.trial.plan },
    plans: { free: plan("free"), pro: plan("pro"), business: plan("business") },
    creditPacks: form.packs.map((pack, index) => {
      const id = pack.id.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new FormError(`Credit pack ${index + 1}: the ID takes lowercase letters, digits and dashes`);
      return {
        id,
        credits: count(pack.credits, `Credit pack ${id}`, false),
        prices: pack.prices.map((row) => {
          const currency = currencyCode(row.currency, `Credit pack ${id}`);
          return { currency, amount: minor(row.amount, currency, `Credit pack ${id}`) };
        }),
      };
    }),
    providers: {
      stripe: {
        enabled: form.stripe.enabled,
        ...(form.stripe.secretKey.trim() ? { secretKey: form.stripe.secretKey.trim() } : {}),
        ...(form.stripe.webhookSecret.trim() ? { webhookSecret: form.stripe.webhookSecret.trim() } : {}),
      },
      sslcommerz: {
        enabled: form.sslcommerz.enabled,
        storeId: form.sslcommerz.storeId.trim() || null,
        ...(form.sslcommerz.storePassword.trim() ? { storePassword: form.sslcommerz.storePassword.trim() } : {}),
        sandbox: form.sslcommerz.sandbox,
      },
      manual: { enabled: form.manual.enabled, instructions: form.manual.instructions.trim() || null },
    },
  };
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: ReactNode; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * Admin → Billing settings: whether this installation charges, what each plan
 * allows and costs, credit packs, and the payment providers. Secrets are
 * write-only: the form shows whether one is saved, never the value.
 */
export function AdminBillingSettings({ view }: { view: BillingConfigView }) {
  const router = useRouter();
  const [form, setForm] = useState<Form>(() => formFor(view));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"stripe" | "sslcommerz" | null>(null);
  const [results, setResults] = useState<Partial<Record<"stripe" | "sslcommerz", BillingTestResult>>>({});
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const setPlan = (id: PlanId, patch: Partial<PlanForm>) => setForm((f) => ({ ...f, plans: { ...f.plans, [id]: { ...f.plans[id], ...patch } } }));

  const save = async () => {
    let input: BillingConfigInput;
    try {
      input = toInput(form);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Check the form");
      return;
    }
    setSaving(true);
    try {
      await clientApi<BillingConfigView>("/admin/billing", { method: "PUT", body: input });
      toast.success("Billing settings saved");
      setForm((f) => ({ ...f, stripe: { ...f.stripe, secretKey: "", webhookSecret: "" }, sslcommerz: { ...f.sslcommerz, storePassword: "" } }));
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (provider: "stripe" | "sslcommerz", field: "secretKey" | "webhookSecret" | "storePassword") => {
    try {
      const input = toInput(form);
      const providers = { ...input.providers };
      if (provider === "stripe") providers.stripe = { ...providers.stripe, [field]: "" };
      else providers.sslcommerz = { ...providers.sslcommerz, storePassword: "" };
      await clientApi<BillingConfigView>("/admin/billing", { method: "PUT", body: { ...input, providers } });
      toast.success("Removed");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof FormError ? error.message : errorMessage(error));
    }
  };

  const test = async (provider: "stripe" | "sslcommerz") => {
    setTesting(provider);
    try {
      const result = await clientApi<BillingTestResult>("/admin/billing/test", { method: "POST", body: { provider } });
      setResults((r) => ({ ...r, [provider]: result }));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(null);
    }
  };

  const secretHint = (secret: { set: boolean; masked: string | null }, onRemove: () => void) =>
    secret.set ? (
      <span className="inline-flex items-center gap-1.5">
        Saved ({secret.masked}). Leave empty to keep it.
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onRemove}>
          Remove
        </button>
      </span>
    ) : (
      "Not set"
    );

  return (
    <div className="space-y-4">
      {view.problems.map((problem) => (
        <Callout key={problem} tone="danger" icon={CircleAlert} title={problem} />
      ))}

      <Section
        title="Charging"
        hint={
          view.updatedAt
            ? `Last saved ${timeAgo(view.updatedAt)}${view.updatedBy ? ` by ${view.updatedBy}` : ""}`
            : "Off by default: a self-hosted installation isn't billed and everyone is unlimited."
        }
        actions={<Badge variant={view.enabled ? "success" : "secondary"}>{view.enabled ? "Billing on" : "Billing off"}</Badge>}
      >
        <Toggle
          label="Charge for this installation"
          hint="On: every user is on a plan (a plan covers every workspace they own) and AI is paid for in credits. Off: everything is unlimited, as for a self-hosted install."
          checked={form.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="AI credits per US$1 of model cost" hint="100 = 1 credit per US$0.01. Every AI call costs at least 1 credit.">
            <Input inputMode="numeric" value={form.creditsPerUsd} onChange={(e) => set({ creditsPerUsd: e.target.value })} />
          </Field>
          <Field label="Free trial for new sign-ups" hint="Only people who sign up while it's on, counted from their sign-up date.">
            <div className="flex items-center gap-2 pt-1">
              <Switch checked={form.trial.enabled} onCheckedChange={(enabled) => set({ trial: { ...form.trial, enabled } })} />
              <Input className="w-16" inputMode="numeric" value={form.trial.days} onChange={(e) => set({ trial: { ...form.trial, days: e.target.value } })} />
              <span className="text-xs text-muted-foreground">days of</span>
            </div>
          </Field>
          <Field label="Trial plan">
            <OptionSelect
              value={form.trial.plan}
              onChange={(plan) => set({ trial: { ...form.trial, plan: plan === "business" ? "business" : "pro" } })}
              placeholder="Plan"
              options={[
                { value: "pro", label: "Pro" },
                { value: "business", label: "Business" },
              ]}
            />
          </Field>
        </div>
      </Section>

      <Section title="Plans" hint="Empty = unlimited. Prices are per currency; people choose the currency at checkout. Amounts in major units (5.00 = US$5).">
        <div className="grid gap-3 lg:grid-cols-3">
          {PLAN_ORDER.map((id) => {
            const plan = form.plans[id];
            return (
              <div key={id} className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm font-semibold">{view.plans[id].name}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Workspaces">
                    <Input inputMode="numeric" placeholder="Unlimited" value={plan.workspaces} onChange={(e) => setPlan(id, { workspaces: e.target.value })} />
                  </Field>
                  <Field label="People each">
                    <Input inputMode="numeric" placeholder="Unlimited" value={plan.members} onChange={(e) => setPlan(id, { members: e.target.value })} />
                  </Field>
                  <Field label="Storage (GB)">
                    <Input inputMode="decimal" placeholder="Unlimited" value={plan.storageGb} onChange={(e) => setPlan(id, { storageGb: e.target.value })} />
                  </Field>
                  <Field label="AI credits / month">
                    <Input inputMode="numeric" value={plan.aiCredits} onChange={(e) => setPlan(id, { aiCredits: e.target.value })} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                  <label className="flex items-center gap-2">
                    <Switch checked={plan.apiAccess} onCheckedChange={(apiAccess) => setPlan(id, { apiAccess })} /> API & MCP
                  </label>
                  <label className="flex items-center gap-2">
                    <Switch checked={plan.integrations} onCheckedChange={(integrations) => setPlan(id, { integrations })} /> Connections
                  </label>
                </div>
                {id !== "free" && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">Prices</p>
                    {plan.prices.map((row, index) => (
                      <div key={row.key} className="flex items-center gap-1.5">
                        <OptionSelect
                          size="sm"
                          className="w-24"
                          value={row.interval}
                          onChange={(interval) =>
                            setPlan(id, { prices: plan.prices.map((p, i) => (i === index ? { ...p, interval: interval as BillingInterval } : p)) })
                          }
                          placeholder="Period"
                          options={[
                            { value: "month", label: "Month" },
                            { value: "year", label: "Year" },
                          ]}
                        />
                        <Input
                          className="w-16"
                          aria-label="Currency"
                          value={row.currency}
                          onChange={(e) =>
                            setPlan(id, { prices: plan.prices.map((p, i) => (i === index ? { ...p, currency: e.target.value.toUpperCase() } : p)) })
                          }
                        />
                        <Input
                          className="min-w-0 flex-1"
                          aria-label="Amount"
                          inputMode="decimal"
                          value={row.amount}
                          onChange={(e) => setPlan(id, { prices: plan.prices.map((p, i) => (i === index ? { ...p, amount: e.target.value } : p)) })}
                        />
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Remove price"
                          onClick={() => setPlan(id, { prices: plan.prices.filter((_, i) => i !== index) })}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setPlan(id, { prices: [...plan.prices, { key: rowKey(), interval: "month", currency: "USD", amount: "" }] })}
                    >
                      <Plus aria-hidden /> Price
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Credit packs" hint="Bought once, never expire; used after a plan's monthly credits run out.">
        <div className="space-y-2">
          {form.packs.map((pack, index) => (
            <div key={pack.key} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2.5">
              <Field label="ID" className="w-36">
                <Input value={pack.id} onChange={(e) => set({ packs: form.packs.map((p, i) => (i === index ? { ...p, id: e.target.value } : p)) })} />
              </Field>
              <Field label="Credits" className="w-28">
                <Input
                  inputMode="numeric"
                  value={pack.credits}
                  onChange={(e) => set({ packs: form.packs.map((p, i) => (i === index ? { ...p, credits: e.target.value } : p)) })}
                />
              </Field>
              {pack.prices.map((price, priceIndex) => (
                <Field key={price.key} label={`Price ${priceIndex + 1}`} className="w-44">
                  <div className="flex gap-1">
                    <Input
                      className="w-16"
                      aria-label="Currency"
                      value={price.currency}
                      onChange={(e) =>
                        set({
                          packs: form.packs.map((p, i) =>
                            i === index
                              ? { ...p, prices: p.prices.map((x, j) => (j === priceIndex ? { ...x, currency: e.target.value.toUpperCase() } : x)) }
                              : p,
                          ),
                        })
                      }
                    />
                    <Input
                      aria-label="Amount"
                      inputMode="decimal"
                      value={price.amount}
                      onChange={(e) =>
                        set({
                          packs: form.packs.map((p, i) =>
                            i === index ? { ...p, prices: p.prices.map((x, j) => (j === priceIndex ? { ...x, amount: e.target.value } : x)) } : p,
                          ),
                        })
                      }
                    />
                  </div>
                </Field>
              ))}
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  set({ packs: form.packs.map((p, i) => (i === index ? { ...p, prices: [...p.prices, { key: rowKey(), currency: "BDT", amount: "" }] } : p)) })
                }
              >
                <Plus aria-hidden /> Price
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Remove pack" onClick={() => set({ packs: form.packs.filter((_, i) => i !== index) })}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={form.packs.length >= 10}
            onClick={() =>
              set({
                packs: [
                  ...form.packs,
                  { key: rowKey(), id: `credits-${form.packs.length + 1}`, credits: "1000", prices: [{ key: rowKey(), currency: "USD", amount: "" }] },
                ],
              })
            }
          >
            <Plus aria-hidden /> Credit pack
          </Button>
        </div>
      </Section>

      <Section
        title="Stripe"
        hint="Cards worldwide. Plans become Stripe subscriptions that renew by themselves; credit packs are one-time payments."
        actions={
          <Button
            size="sm"
            variant="outline"
            loading={testing === "stripe"}
            disabled={!view.providers.stripe.secretKey.set}
            onClick={() => void test("stripe")}
          >
            <FlaskConical aria-hidden /> Test saved key
          </Button>
        }
      >
        <Toggle label="Take card payments with Stripe" checked={form.stripe.enabled} onChange={(enabled) => set({ stripe: { ...form.stripe, enabled } })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Secret key (sk_live_… or sk_test_…)" hint={secretHint(view.providers.stripe.secretKey, () => void removeSecret("stripe", "secretKey"))}>
            <Input
              type="password"
              autoComplete="off"
              value={form.stripe.secretKey}
              onChange={(e) => set({ stripe: { ...form.stripe, secretKey: e.target.value } })}
            />
          </Field>
          <Field
            label="Webhook signing secret (whsec_…)"
            hint={secretHint(view.providers.stripe.webhookSecret, () => void removeSecret("stripe", "webhookSecret"))}
          >
            <Input
              type="password"
              autoComplete="off"
              value={form.stripe.webhookSecret}
              onChange={(e) => set({ stripe: { ...form.stripe, webhookSecret: e.target.value } })}
            />
          </Field>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            In Stripe → Developers → Webhooks, add an endpoint with this URL and select these events, then paste its signing secret above:
          </p>
          <CopyBox value={view.providers.stripe.webhookUrl} />
          <div className="flex flex-wrap gap-1">
            {view.providers.stripe.events.map((event) => (
              <Badge key={event} variant="outline" className="font-mono">
                {event}
              </Badge>
            ))}
          </div>
        </div>
        {results.stripe && <Callout tone={results.stripe.ok ? "info" : "danger"} title={results.stripe.message} />}
      </Section>

      <Section
        title="SSLCommerz"
        hint="Bangladesh: bKash, Nagad, Rocket and cards. One-time payments, so plans are prepaid months or years; people get a reminder before theirs ends."
        actions={
          <Button
            size="sm"
            variant="outline"
            loading={testing === "sslcommerz"}
            disabled={!view.providers.sslcommerz.storePassword.set}
            onClick={() => void test("sslcommerz")}
          >
            <FlaskConical aria-hidden /> Test saved store
          </Button>
        }
      >
        <Toggle
          label="Take payments with SSLCommerz"
          checked={form.sslcommerz.enabled}
          onChange={(enabled) => set({ sslcommerz: { ...form.sslcommerz, enabled } })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Store ID">
            <Input value={form.sslcommerz.storeId} onChange={(e) => set({ sslcommerz: { ...form.sslcommerz, storeId: e.target.value } })} />
          </Field>
          <Field label="Store password" hint={secretHint(view.providers.sslcommerz.storePassword, () => void removeSecret("sslcommerz", "storePassword"))}>
            <Input
              type="password"
              autoComplete="off"
              value={form.sslcommerz.storePassword}
              onChange={(e) => set({ sslcommerz: { ...form.sslcommerz, storePassword: e.target.value } })}
            />
          </Field>
        </div>
        <Toggle
          label="Sandbox"
          hint="Test payments against sandbox.sslcommerz.com. Turn off for live payments (securepay.sslcommerz.com)."
          checked={form.sslcommerz.sandbox}
          onChange={(sandbox) => set({ sslcommerz: { ...form.sslcommerz, sandbox } })}
        />
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Set this as the IPN URL in the SSLCommerz merchant panel (the success, fail and cancel pages are sent with each payment):
          </p>
          <CopyBox value={view.providers.sslcommerz.ipnUrl} />
        </div>
        {results.sslcommerz && <Callout tone={results.sslcommerz.ok ? "info" : "danger"} title={results.sslcommerz.message} />}
      </Section>

      <Section
        title="Manual payments"
        hint="Bank transfers, bKash or Nagad sent directly: people see these instructions; you record the payment in the table below."
      >
        <Toggle label="Show manual payment instructions" checked={form.manual.enabled} onChange={(enabled) => set({ manual: { ...form.manual, enabled } })} />
        <Textarea
          rows={3}
          placeholder="Send ৳600 (Pro, one month) to bKash 01XXXXXXXXX with your account email as the reference."
          value={form.manual.instructions}
          onChange={(e) => set({ manual: { ...form.manual, instructions: e.target.value } })}
        />
      </Section>

      <div className="sticky bottom-2 z-10 flex justify-end">
        <Button onClick={() => void save()} loading={saving} className="shadow-md">
          <Save aria-hidden /> Save billing settings
        </Button>
      </div>
    </div>
  );
}
