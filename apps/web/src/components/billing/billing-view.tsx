"use client";

import { Building2, Check, CreditCard, ExternalLink, HardDrive, Receipt, Sparkles, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Callout, Segmented } from "@/components/ai/shared";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, ProgressBar, type Tone } from "@/components/app/blocks";
import { OptionSelect } from "@/components/planning/shared";
import { SettingsCard } from "@/components/settings/settings-page";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { BillingInterval, BillingOverview, BillingPaymentView, CheckoutInput, PublicPlan } from "@/lib/api/types/billing";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { toast } from "@/lib/toast";

type CheckoutProvider = "stripe" | "sslcommerz";

const PROVIDER_LABELS: Record<string, string> = { stripe: "Card (Stripe)", sslcommerz: "bKash, Nagad or card (SSLCommerz)", manual: "Manual payment" };
const STATUS_LABELS: Record<string, { label: string; variant: "success" | "info" | "warning" | "error" | "secondary" }> = {
  active: { label: "Active", variant: "success" },
  trialing: { label: "Trial", variant: "info" },
  past_due: { label: "Payment failed", variant: "error" },
  canceled: { label: "Canceled", variant: "warning" },
  expired: { label: "Ended", variant: "secondary" },
};

export const dateText = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

function Meter({
  icon: Icon,
  label,
  used,
  limit,
  format,
  href,
  hint,
}: {
  icon: typeof Building2;
  label: string;
  used: number;
  limit: number | null;
  format: (n: number) => string;
  href?: string;
  hint?: ReactNode;
}) {
  const pct = limit ? (used / limit) * 100 : 0;
  const tone: Tone = limit === null ? "default" : pct >= 100 ? "danger" : pct >= 80 ? "warn" : "good";
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </span>
        <span className="font-medium tabular-nums">
          {format(used)}
          <span className="font-normal text-muted-foreground"> / {limit === null ? "unlimited" : format(limit)}</span>
        </span>
      </div>
      {limit !== null && <ProgressBar value={pct} tone={tone} className="mt-2" />}
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </>
  );
  const className = "block rounded-lg border border-border px-3 py-2.5";
  return href ? (
    <Link href={href} className={cn(className, "transition-colors hover:bg-accent/40")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

function paymentItem(payment: BillingPaymentView, plans: PublicPlan[]) {
  if (payment.purpose === "credits") return `${(payment.credits ?? 0).toLocaleString()} AI credits`;
  const name = plans.find((p) => p.id === payment.plan)?.name ?? payment.plan ?? "Plan";
  return `${name}${payment.interval ? ` · ${payment.interval === "year" ? "yearly" : "monthly"}` : ""}`;
}

/**
 * Plan & billing: the plan in effect (trial, renewal, payment problems),
 * what it allows and how much is used, the plans and credit packs to buy,
 * and every payment with its receipt.
 */
export function BillingView({ overview, checkout }: { overview: BillingOverview; checkout?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { money } = useApp();
  const ready: CheckoutProvider[] = (["stripe", "sslcommerz"] as const).filter((p) => overview.providers[p]);
  const [provider, setProvider] = useState<CheckoutProvider | null>(ready[0] ?? null);
  const [interval, setBillingInterval] = useState<BillingInterval>(overview.interval ?? "month");
  const preferred = (p: CheckoutProvider | null) => {
    const wanted = p === "sslcommerz" ? "BDT" : "USD";
    return overview.currencies.includes(wanted) ? wanted : (overview.currencies[0] ?? wanted);
  };
  const [currency, setCurrency] = useState(() => preferred(ready[0] ?? null));
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Coming back from a checkout page.
  useEffect(() => {
    if (!checkout) return;
    if (checkout === "success") toast.success("Payment received. Thank you!", { description: "It can take a few seconds to show here." });
    else if (checkout === "failed")
      toast.error("The payment didn't go through", { description: "Nothing was charged. Try again or choose another way to pay." });
    else if (checkout === "canceled") toast.info("Checkout canceled");
    router.replace(pathname);
    if (checkout === "success") {
      const timer = setTimeout(() => router.refresh(), 3000);
      return () => clearTimeout(timer);
    }
  }, [checkout, pathname, router]);

  const start = async (key: string, input: CheckoutInput) => {
    setBusy(key);
    try {
      const { url } = await clientApi<{ url: string }>("/billing/checkout", { method: "POST", body: input });
      window.location.href = url;
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(null);
    }
  };

  const action = async (key: "portal" | "cancel" | "resume") => {
    setBusy(key);
    try {
      if (key === "portal") {
        const { url } = await clientApi<{ url: string }>("/billing/portal", { method: "POST" });
        window.location.href = url;
        return;
      }
      await clientApi(`/billing/${key}`, { method: "POST" });
      toast.success(key === "cancel" ? "Your plan won't renew" : "Your plan will renew as usual");
      setConfirmCancel(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
    setBusy(null);
  };

  const pricedCurrencies = useMemo(
    () => overview.currencies.filter((c) => overview.plans.some((p) => p.prices.some((price) => price.currency === c && price.interval === interval))),
    [overview.currencies, overview.plans, interval],
  );

  if (!overview.enabled) {
    return (
      <>
        <SettingsCard title="Everything is unlocked" description="This installation isn't billed.">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Check className="size-4" aria-hidden />
            </span>
            <p className="text-sm text-muted-foreground">
              There are no plans or limits here: every workspace, person, file and AI feature is available. The AI budget of each workspace is set in{" "}
              <Link href="/settings/ai" className="underline underline-offset-2 hover:text-foreground">
                Settings → AI
              </Link>
              .
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Meter
              icon={Building2}
              label="Workspaces you own"
              used={overview.usage.workspacesOwned}
              limit={null}
              format={(n) => n.toLocaleString()}
              href="/settings/workspace"
            />
            <Meter icon={HardDrive} label="Files" used={overview.usage.storageBytes} limit={null} format={formatBytes} />
          </div>
        </SettingsCard>
        {overview.payments.length > 0 && <Payments payments={overview.payments} plans={overview.plans} money={money} />}
      </>
    );
  }

  const onPaidPlan = overview.plan !== "free" && overview.plan !== "unlimited";
  const status = STATUS_LABELS[overview.status] ?? STATUS_LABELS.active;
  const credits = overview.usage.credits;
  const canCheckout = ready.length > 0 && provider !== null;
  const prepaid = overview.provider === "sslcommerz" || overview.provider === "manual";
  // A live card subscription is changed or cancelled in Stripe's billing portal, not by a second checkout.
  const cardSubscription = overview.hasStripeSubscription && onPaidPlan && overview.status !== "canceled" && overview.status !== "trialing";

  return (
    <>
      <SettingsCard
        title="Your plan"
        description="A plan covers every workspace you own. People you invite use your plan inside your workspaces."
        footer={
          onPaidPlan && overview.status !== "trialing" ? (
            <>
              {overview.hasStripeSubscription && (
                <Button size="sm" variant="outline" loading={busy === "portal"} onClick={() => void action("portal")}>
                  <ExternalLink aria-hidden /> Manage billing
                </Button>
              )}
              {overview.cancelAtPeriodEnd ? (
                <Button size="sm" loading={busy === "resume"} onClick={() => void action("resume")}>
                  Keep my plan
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
                  {prepaid ? "Don't renew" : "Cancel plan"}
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
              {overview.planName}
              <Badge variant={status?.variant ?? "secondary"}>{status?.label ?? overview.status}</Badge>
            </p>
            <p className="text-xs text-muted-foreground">
              {overview.trial.active
                ? `Free trial until ${dateText(overview.trial.endsAt)}`
                : onPaidPlan
                  ? [
                      overview.interval ? (overview.interval === "year" ? "Yearly" : "Monthly") : null,
                      overview.provider ? PROVIDER_LABELS[overview.provider] : null,
                      overview.currentPeriodEnd
                        ? overview.cancelAtPeriodEnd || overview.status === "canceled" || prepaid
                          ? `paid through ${dateText(overview.currentPeriodEnd)}`
                          : `renews ${dateText(overview.currentPeriodEnd)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "The free plan. Upgrade any time; your data stays as it is."}
            </p>
          </div>
        </div>

        {overview.trial.active && (
          <Callout tone="info" title={`${overview.trial.daysLeft ?? 0} day${overview.trial.daysLeft === 1 ? "" : "s"} left on your ${overview.planName} trial`}>
            After the trial you move to Free unless you choose a plan below. Nothing is deleted.
          </Callout>
        )}
        {overview.status === "past_due" && (
          <Callout
            tone="danger"
            title="Your last payment didn't go through"
            action={
              overview.hasStripeSubscription ? (
                <Button size="xs" variant="outline" loading={busy === "portal"} onClick={() => void action("portal")}>
                  Update card
                </Button>
              ) : undefined
            }
          >
            Your plan keeps working until {dateText(overview.graceEndsAt)}. Update your payment method so it doesn't lapse.
          </Callout>
        )}
        {overview.cancelAtPeriodEnd && onPaidPlan && (
          <Callout tone="warn" title={`Your plan ends on ${dateText(overview.currentPeriodEnd)}`}>
            It won't renew. After that you move to Free; nothing is deleted.
          </Callout>
        )}
        {onPaidPlan && prepaid && !overview.cancelAtPeriodEnd && overview.currentPeriodEnd && (
          <p className="text-xs text-muted-foreground">
            Prepaid plans don't renew by themselves: pay again before {dateText(overview.currentPeriodEnd)} and the new period is added to the end.
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <Meter
            icon={Building2}
            label="Workspaces you own"
            used={overview.usage.workspacesOwned}
            limit={overview.limits.workspaces}
            format={(n) => n.toLocaleString()}
            href="/settings/workspace"
            hint={
              overview.limits.membersPerWorkspace !== null
                ? `Up to ${overview.limits.membersPerWorkspace} people in each, invitations included`
                : "Unlimited people in each"
            }
          />
          <Meter
            icon={HardDrive}
            label="Files across your workspaces"
            used={overview.usage.storageBytes}
            limit={overview.limits.storageBytes}
            format={formatBytes}
          />
          {credits && (
            <Meter
              icon={Sparkles}
              label="AI credits this period"
              used={credits.usedThisPeriod}
              limit={credits.allowance}
              format={(n) => n.toLocaleString()}
              href="/settings/ai"
              hint={`Renews ${dateText(credits.periodEnd)}`}
            />
          )}
          {credits && (
            <Meter
              icon={Wallet}
              label="Bought credits"
              used={Math.max(0, credits.balance)}
              limit={null}
              format={(n) => n.toLocaleString()}
              hint="Used after the monthly credits run out. They never expire."
            />
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="Plans" description="1 AI credit is about US$0.01 of AI use: reading a receipt usually takes 1–3 credits.">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Billing period"
            value={interval}
            onChange={setBillingInterval}
            items={[
              { value: "month", label: "Monthly" },
              { value: "year", label: "Yearly" },
            ]}
          />
          {pricedCurrencies.length > 1 && (
            <OptionSelect
              size="sm"
              className="w-28"
              value={currency}
              onChange={setCurrency}
              placeholder="Currency"
              options={pricedCurrencies.map((c) => ({ value: c, label: c }))}
            />
          )}
          {ready.length > 1 && (
            <OptionSelect
              size="sm"
              className="w-64"
              value={provider}
              onChange={(value) => {
                const next = value as CheckoutProvider;
                setProvider(next);
                setCurrency(preferred(next));
              }}
              placeholder="Pay with"
              options={ready.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
            />
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {overview.plans.map((plan) => {
            const price = plan.prices.find((p) => p.interval === interval && p.currency === currency);
            const current = overview.plan === plan.id && (plan.id === "free" || overview.status !== "trialing");
            return (
              <div key={plan.id} className={cn("flex flex-col gap-3 rounded-xl border p-4", current ? "border-primary/60 bg-primary/3" : "border-border")}>
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {plan.name}
                    {current && <Badge variant="outline">Current</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">{plan.tagline}</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">
                  {plan.id === "free"
                    ? money(0, currency, { trimZeroFraction: true })
                    : price
                      ? money(price.amount, currency, { trimZeroFraction: true })
                      : "—"}
                  <span className="text-xs font-normal text-muted-foreground">
                    {plan.id === "free" ? " forever" : interval === "year" ? " / year" : " / month"}
                  </span>
                </p>
                <ul className="flex-1 space-y-1.5 text-xs">
                  {plan.highlights.map((line) => (
                    <li key={line} className="flex items-start gap-1.5">
                      <Check className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                      {line}
                    </li>
                  ))}
                </ul>
                {plan.id !== "free" &&
                  (current && !prepaid ? (
                    <Button size="sm" variant="outline" disabled>
                      Your plan
                    </Button>
                  ) : cardSubscription ? (
                    <Button size="sm" variant="outline" loading={busy === "portal"} onClick={() => void action("portal")}>
                      Change in Manage billing
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={current ? "outline" : "default"}
                      disabled={!canCheckout || !price}
                      loading={busy === `plan-${plan.id}`}
                      onClick={() =>
                        provider && void start(`plan-${plan.id}`, { purpose: "plan", plan: plan.id as "pro" | "business", interval, provider, currency })
                      }
                    >
                      {!price
                        ? `Not offered in ${currency}`
                        : current
                          ? "Pay for another period"
                          : overview.plan === "business" && plan.id === "pro"
                            ? "Switch to Pro"
                            : `Upgrade to ${plan.name}`}
                    </Button>
                  ))}
              </div>
            );
          })}
        </div>
        {!canCheckout && (
          <p className="text-xs text-muted-foreground">
            {overview.manualInstructions
              ? "Online payment isn't available yet; pay as described below and an admin will activate your plan."
              : "Online payment isn't available on this installation yet."}
          </p>
        )}
      </SettingsCard>

      {overview.creditPacks.length > 0 && (
        <SettingsCard title="AI credits" description="Buy credits once; they never expire and are used after the monthly credits run out.">
          <div className="grid gap-2 sm:grid-cols-2">
            {overview.creditPacks.map((pack) => {
              const price = pack.prices.find((p) => p.currency === currency) ?? pack.prices[0];
              return (
                <div key={pack.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium tabular-nums">{pack.credits.toLocaleString()} credits</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {price ? money(price.amount, price.currency, { trimZeroFraction: true }) : "—"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canCheckout || !price}
                    loading={busy === `pack-${pack.id}`}
                    onClick={() =>
                      provider && price && void start(`pack-${pack.id}`, { purpose: "credits", packId: pack.id, provider, currency: price.currency })
                    }
                  >
                    Buy
                  </Button>
                </div>
              );
            })}
          </div>
        </SettingsCard>
      )}

      {overview.manualInstructions && (
        <SettingsCard title="Pay by transfer" description="Bank transfer, bKash or Nagad: an admin records the payment and activates your plan or credits.">
          <p className="whitespace-pre-line rounded-lg bg-muted/50 px-3 py-2.5 text-sm">{overview.manualInstructions}</p>
          <p className="text-xs text-muted-foreground">Use the email you sign in with as the reference so the payment can be matched to your account.</p>
        </SettingsCard>
      )}

      <Payments payments={overview.payments} plans={overview.plans} money={money} />

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{prepaid ? "Stop renewal reminders?" : "Cancel your plan?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {overview.planName} stays active until {dateText(overview.currentPeriodEnd)}. After that you move to Free: your records stay, but Free's limits
              apply to workspaces, people, storage and AI credits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep plan</AlertDialogClose>
            <Button variant="destructive" loading={busy === "cancel"} onClick={() => void action("cancel")}>
              {prepaid ? "Don't renew" : "Cancel at period end"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function Payments({ payments, plans, money }: { payments: BillingPaymentView[]; plans: PublicPlan[]; money: ReturnType<typeof useApp>["money"] }) {
  return (
    <SettingsCard title="Payments" description="Everything you've paid for, with receipts.">
      {payments.length ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Date</th>
                <th>Item</th>
                <th>Paid with</th>
                <th className="text-right!">Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border [&>tr>td]:px-3 [&>tr>td]:py-2">
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="whitespace-nowrap">{dateText(payment.paidAt ?? payment.createdAt)}</td>
                  <td>{paymentItem(payment, plans)}</td>
                  <td className="text-muted-foreground">
                    {payment.provider === "manual" ? "Transfer" : payment.provider === "stripe" ? "Card" : "SSLCommerz"}
                  </td>
                  <td className="text-right tabular-nums">{money(payment.amount, payment.currency)}</td>
                  <td>
                    <Badge variant={payment.status === "paid" ? "success" : payment.status === "pending" ? "info" : "secondary"} className="capitalize">
                      {payment.status}
                    </Badge>
                  </td>
                  <td className="text-right">
                    {payment.receiptUrl ? (
                      <a
                        href={payment.receiptUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                      >
                        <Receipt className="size-3" aria-hidden /> Receipt
                      </a>
                    ) : payment.status === "paid" ? (
                      <span className="font-mono text-[11px] text-muted-foreground">{payment.providerRef.slice(0, 18)}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyNote>
          <span className="inline-flex items-center gap-1.5">
            <CreditCard className="size-3.5" aria-hidden /> Payments appear here with their receipts once you upgrade or buy credits.
          </span>
        </EmptyNote>
      )}
    </SettingsCard>
  );
}
