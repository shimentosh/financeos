"use client";

import { COMMON_CURRENCIES } from "@expensewise/core";
import { Building2, Coins, Globe, Wallet } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type OnboardingResult = {
  onboarded: boolean;
  businessDeleted: boolean;
  businessKeptReason: string | null;
  workspaces: Array<{ currencyApplied: boolean; name: string }>;
};

const currencyName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
};

function Step({ icon: Icon, tone, title, hint, children }: { icon: typeof Coins; tone: string; title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", tone)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** First-run setup: base currency, timezone, and whether to keep the business workspace. */
export function OnboardingForm({
  name,
  defaultCurrency,
  defaultTimezone,
  businessName,
}: {
  name: string;
  defaultCurrency: string;
  defaultTimezone: string;
  businessName: string | null;
}) {
  const id = useId();
  const [currency, setCurrency] = useState(defaultCurrency);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [timezones, setTimezones] = useState<string[]>([defaultTimezone]);
  const [keepBusiness, setKeepBusiness] = useState(true);
  const [company, setCompany] = useState(businessName ?? "");
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);

  // The browser knows the person's timezone; the server render does not.
  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let all: string[] = [];
    try {
      all = Intl.supportedValuesOf("timeZone");
    } catch {
      all = [];
    }
    if (detected) setTimezone(detected);
    setTimezones([...new Set([detected, defaultTimezone, "UTC", ...all].filter(Boolean))]);
  }, [defaultTimezone]);

  const currencies = useMemo(() => [...new Set([defaultCurrency, ...COMMON_CURRENCIES])], [defaultCurrency]);
  const firstName = name.trim().split(/\s+/)[0] || "there";

  const finish = async (body: { baseCurrency: string; timezone: string; keepBusiness: boolean; businessName: string | null }, kind: "save" | "skip") => {
    setBusy(kind);
    try {
      const result = await clientApi<OnboardingResult>("/account/onboarding", { method: "POST", body });
      // A full load, so the app opens with the settings just saved.
      if (result.businessKeptReason) {
        toast.info(`We kept your business workspace. ${result.businessKeptReason}`);
        setTimeout(() => window.location.assign("/"), 1500);
      } else window.location.assign("/");
    } catch (error) {
      setBusy(null);
      toast.error(errorMessage(error));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void finish({ baseCurrency: currency, timezone, keepBusiness, businessName: keepBusiness && company.trim() ? company.trim() : null }, "save");
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Wallet className="size-5" />
        </span>
        <span className="text-lg font-semibold tracking-tight">Expense Wise</span>
      </div>
      <form onSubmit={submit} className="w-full max-w-md space-y-5 rounded-2xl border border-border bg-card p-6 shadow-xs/5">
        <div>
          <h1 className="text-lg font-semibold">Welcome, {firstName}</h1>
          <p className="text-sm text-muted-foreground">Two quick choices and your books are ready. You can change them later in Settings.</p>
        </div>

        <Step
          icon={Coins}
          tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          title="Main currency"
          hint="Totals and reports use it. Accounts and transactions can still be in any currency."
        >
          <Select value={currency} onValueChange={(v) => typeof v === "string" && setCurrency(v)}>
            <SelectTrigger aria-label="Main currency">
              <SelectValue>
                {currency} · {currencyName(currency)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {currencies.map((code) => (
                <SelectItem key={code} value={code}>
                  {code} · {currencyName(code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Step>

        <Step
          icon={Globe}
          tone="bg-sky-500/10 text-sky-600 dark:text-sky-400"
          title="Timezone"
          hint="Decides what “today” is for due dates, reminders and reports."
        >
          <Select value={timezone} onValueChange={(v) => typeof v === "string" && setTimezone(v)}>
            <SelectTrigger aria-label="Timezone">
              <SelectValue>{timezone.replace(/_/g, " ")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {timezones.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Step>

        <Step
          icon={Building2}
          tone="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          title="Business books"
          hint="A separate workspace with its own accounts, projects and profit and loss, kept apart from your personal money."
        >
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
            <span>I also run a business or freelance</span>
            <Switch checked={keepBusiness} onCheckedChange={setKeepBusiness} />
          </label>
          {keepBusiness ? (
            <div className="space-y-1">
              <Label htmlFor={`${id}-company`}>Business name</Label>
              <Input id={`${id}-company`} value={company} maxLength={80} onChange={(e) => setCompany(e.target.value)} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">We remove the empty business workspace. You can add one any time from the workspace menu.</p>
          )}
        </Step>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            loading={busy === "skip"}
            disabled={busy !== null}
            onClick={() => void finish({ baseCurrency: defaultCurrency, timezone: defaultTimezone, keepBusiness: true, businessName: null }, "skip")}
          >
            Skip for now
          </Button>
          <Button type="submit" loading={busy === "save"} disabled={busy !== null}>
            Start using Expense Wise
          </Button>
        </div>
      </form>
    </div>
  );
}
