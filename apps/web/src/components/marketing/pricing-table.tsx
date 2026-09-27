"use client";

import { type BillingInterval, type CreditPack, formatMoney, type PublicPlan } from "@expensewise/core";
import { Check } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const GB = 1024 ** 3;
const size = (bytes: number | null) => (bytes === null ? "Unlimited" : bytes >= GB ? `${Math.round(bytes / GB)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const count = (value: number | null) => (value === null ? "Unlimited" : value.toLocaleString("en-US"));

/**
 * The plans side by side, with a monthly/yearly switch and a currency choice
 * when prices exist in more than one. Without prices (billing not set up yet)
 * the plans show what they include and everything is free.
 */
export function PricingTable({ plans, packs, billed }: { plans: PublicPlan[]; packs: CreditPack[]; billed: boolean }) {
  const currencies = useMemo(() => [...new Set(plans.flatMap((plan) => plan.prices.map((price) => price.currency)))], [plans]);
  const [currency, setCurrency] = useState(currencies.includes("BDT") ? "BDT" : (currencies[0] ?? "USD"));
  const [interval, setInterval] = useState<BillingInterval>("month");
  const hasYearly = plans.some((plan) => plan.prices.some((price) => price.interval === "year" && price.currency === currency));

  const priceOf = (plan: PublicPlan, wanted: BillingInterval) => plan.prices.find((price) => price.interval === wanted && price.currency === currency);

  return (
    <div className="space-y-8">
      {billed && (currencies.length > 1 || hasYearly) && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {hasYearly && (
            <div role="tablist" aria-label="Billing period" className="flex rounded-lg bg-muted/60 p-1">
              {(["month", "year"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={interval === value}
                  onClick={() => setInterval(value)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm transition-colors",
                    interval === value ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "month" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>
          )}
          {currencies.length > 1 && (
            <div role="tablist" aria-label="Currency" className="flex rounded-lg bg-muted/60 p-1">
              {currencies.map((code) => (
                <button
                  key={code}
                  type="button"
                  role="tab"
                  aria-selected={currency === code}
                  onClick={() => setCurrency(code)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm transition-colors",
                    currency === code ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {code}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((plan) => {
          const price = priceOf(plan, interval) ?? priceOf(plan, "month");
          const monthly = priceOf(plan, "month");
          const yearlySaving = interval === "year" && price?.interval === "year" && monthly ? Math.round((1 - price.amount / (monthly.amount * 12)) * 100) : 0;
          const featured = plan.id === "pro";
          return (
            <div
              key={plan.id}
              className={cn("flex flex-col rounded-2xl border bg-card p-6", featured ? "border-foreground ring-1 ring-foreground" : "border-border")}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold text-lg">{plan.name}</h2>
                {featured && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">Most popular</span>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
              <p className="mt-5 flex items-baseline gap-1">
                {plan.id === "free" || !billed ? (
                  <span className="font-semibold text-3xl tracking-tight">Free</span>
                ) : price ? (
                  <>
                    <span className="font-semibold text-3xl tracking-tight tabular-nums">
                      {formatMoney(price.amount, price.currency, { trimZeroFraction: true })}
                    </span>
                    <span className="text-sm text-muted-foreground">/{price.interval === "year" ? "year" : "month"}</span>
                  </>
                ) : (
                  <span className="font-semibold text-3xl tracking-tight">—</span>
                )}
              </p>
              <p className="mt-1 h-4 text-xs text-emerald-700 dark:text-emerald-400">{yearlySaving > 0 ? `Save ${yearlySaving}% with yearly billing` : ""}</p>
              <Button
                className="mt-5"
                variant={featured ? "default" : "outline"}
                render={<Link href={plan.id === "free" ? "/sign-up" : `/sign-up?plan=${plan.id}`} />}
              >
                {plan.id === "free" ? "Start free" : `Choose ${plan.name}`}
              </Button>
              <ul className="mt-6 space-y-2 text-sm">
                {plan.highlights.map((item) => (
                  <li key={item} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> {item}
                  </li>
                ))}
              </ul>
              <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border pt-4 text-xs">
                <dt className="text-muted-foreground">Workspaces</dt>
                <dd className="text-right tabular-nums">{count(plan.limits.workspaces)}</dd>
                <dt className="text-muted-foreground">People per workspace</dt>
                <dd className="text-right tabular-nums">{count(plan.limits.membersPerWorkspace)}</dd>
                <dt className="text-muted-foreground">Receipt storage</dt>
                <dd className="text-right tabular-nums">{size(plan.limits.storageBytes)}</dd>
                <dt className="text-muted-foreground">AI credits a month</dt>
                <dd className="text-right tabular-nums">{count(plan.limits.aiCreditsPerMonth)}</dd>
                <dt className="text-muted-foreground">API and AI agents</dt>
                <dd className="text-right">{plan.limits.apiAccess ? "Included" : "—"}</dd>
                <dt className="text-muted-foreground">Bank and app connections</dt>
                <dd className="text-right">{plan.limits.integrations ? "Included" : "—"}</dd>
              </dl>
            </div>
          );
        })}
      </div>

      {billed && packs.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="font-semibold">Need more AI? Buy credits</h2>
          <p className="mt-1 text-sm text-muted-foreground">Credit packs top up any plan and never expire. Your monthly allowance is used first.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {packs.map((pack) => {
              const price = pack.prices.find((p) => p.currency === currency) ?? pack.prices[0];
              return (
                <div key={pack.id} className="rounded-xl border border-border p-3">
                  <p className="font-semibold tabular-nums">{pack.credits.toLocaleString("en-US")} credits</p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {price ? formatMoney(price.amount, price.currency, { trimZeroFraction: true }) : "—"}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
