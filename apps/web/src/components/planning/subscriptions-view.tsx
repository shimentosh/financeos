"use client";

import { SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from "@expensewise/core";
import { AlertTriangle, CalendarClock, CalendarRange, CircleAlert, Plus, Repeat, Search, Wallet, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryChip, EmptyNote, EmptyState, Pill, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SubscriptionAnalytics, SubscriptionList, SubscriptionView } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { MarkPaidDialog, type PayTarget } from "./payment-dialogs";
import { AutoRenewBadge, DueDate, NONE, OptionSelect, renewalStatement, useQueryNav } from "./shared";
import { BILLING_LABELS, SubscriptionFormDialog } from "./subscription-form";

export type SubscriptionFilters = { q?: string; status?: string; billingCycle?: string; sort?: string };

const SORTS = [
  { value: "renewal_asc", label: "Next renewal" },
  { value: "amount_desc", label: "Highest amount" },
  { value: "monthly_desc", label: "Highest monthly cost" },
  { value: "name_asc", label: "Name" },
];

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: NONE, label: "All statuses" },
  { value: "trial,active,renewal_due,renewed", label: "Active" },
  ...(["renewal_due", "trial", "cancellation_pending", "cancelled", "expired", "paused"] as SubscriptionStatus[]).map((status) => ({
    value: status,
    label: SUBSCRIPTION_STATUS_LABELS[status],
  })),
];

/** Opens the create dialog when the URL says `?new=1`, and cleans the URL when it closes. */
function useNewParam(): [boolean, (open: boolean) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setOpen(true);
  }, [params]);
  const change = (next: boolean) => {
    setOpen(next);
    if (!next && params.get("new")) {
      const rest = new URLSearchParams(params.toString());
      rest.delete("new");
      router.replace(`${window.location.pathname}${rest.size ? `?${rest}` : ""}`, { scroll: false });
    }
  };
  return [open, change];
}

export function AddSubscriptionButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useNewParam();
  const router = useRouter();
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add subscription
      </Button>
      <SubscriptionFormDialog open={open} onOpenChange={setOpen} onSaved={(id) => router.push(`/subscriptions/${id}`)} />
    </>
  );
}

export function SubscriptionsView({
  list,
  analytics,
  filters,
  today,
}: {
  list: SubscriptionList;
  analytics: SubscriptionAnalytics;
  filters: SubscriptionFilters;
  today: string;
}) {
  const { money, canWrite, isBusiness } = useApp();
  const { update, pending } = useQueryNav();
  const [query, setQuery] = useState(filters.q ?? "");
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const router = useRouter();

  useEffect(() => setQuery(filters.q ?? ""), [filters.q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce on the query only
  useEffect(() => {
    if ((filters.q ?? "") === query) return;
    const timer = setTimeout(() => update({ q: query.trim() || null }), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const filtered = Boolean(filters.q || filters.status || filters.billingCycle);

  if (analytics.totalCount === 0) {
    return (
      <>
        <EmptyState
          icon={Repeat}
          title="You're not tracking any subscriptions yet"
          description="Add Netflix, Claude, your domain or hosting renewal. Expense Wise reminds you before each renewal, spots price changes and shows what they cost a year."
          action={
            canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> Add subscription
              </Button>
            ) : undefined
          }
        />
        <SubscriptionFormDialog open={creating} onOpenChange={setCreating} onSaved={(id) => router.push(`/subscriptions/${id}`)} />
      </>
    );
  }

  const unconvertedNote = (items: Array<{ currency: string; amount: number }>) =>
    items.length ? ` + ${items.map((u) => money(u.amount, u.currency)).join(" + ")}` : "";

  return (
    <div className={cn("space-y-4 transition-opacity", pending && "opacity-70")}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Repeat}
          label="Active"
          value={analytics.activeCount}
          hint={`${analytics.totalCount} tracked`}
          href="/subscriptions?status=trial,active,renewal_due,renewed"
        />
        <StatCard
          icon={Wallet}
          label="Monthly equivalent"
          value={money(analytics.monthlyTotal)}
          hint="All active, base currency"
          href="/subscriptions?sort=monthly_desc"
        />
        <StatCard
          icon={CalendarRange}
          label="Annual cost"
          value={money(analytics.annualTotal)}
          hint="What they cost a year"
          href="/commitments?tab=annual&kind=subscription"
        />
        <StatCard
          icon={CalendarClock}
          label="Annual commitments"
          value={money(analytics.annualCommitments.total)}
          hint={`${analytics.annualCommitments.count} yearly plans${unconvertedNote(analytics.annualCommitments.unconverted)}`}
          href="/subscriptions?billingCycle=yearly"
        />
        <StatCard
          icon={CalendarClock}
          label="Renewing in 30 days"
          value={money(analytics.upcoming30.total)}
          hint={`${analytics.upcoming30.count} renewals${unconvertedNote(analytics.upcoming30.unconverted)}`}
          tone={analytics.upcoming30.count ? "info" : "default"}
          href="/commitments?tab=upcoming&kind=subscription&days=30"
        />
        <StatCard
          icon={AlertTriangle}
          label="Payment not recorded"
          value={analytics.overdue.count}
          hint={analytics.overdue.count ? money(analytics.overdue.total) : "Nothing overdue"}
          tone={analytics.overdue.count ? "danger" : "default"}
          href="/commitments?tab=upcoming&kind=subscription"
        />
      </div>

      {analytics.unconverted.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Pill icon={CircleAlert} tone="warn" href="/settings/currency">
            {analytics.unconverted.length} in {[...new Set(analytics.unconverted.map((u) => u.currency))].join(", ")} not in the totals — add an exchange rate
          </Pill>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.status ?? NONE}
          onChange={(v) => update({ status: v })}
          options={STATUS_FILTERS}
          placeholder="All statuses"
        />
        <OptionSelect
          size="sm"
          className="w-40"
          value={filters.billingCycle ?? NONE}
          onChange={(v) => update({ billingCycle: v })}
          options={[{ value: NONE, label: "Any billing cycle" }, ...Object.entries(BILLING_LABELS).map(([value, label]) => ({ value, label }))]}
          placeholder="Any billing cycle"
        />
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.sort ?? "renewal_asc"}
          onChange={(v) => update({ sort: v === "renewal_asc" ? null : v })}
          options={SORTS}
          placeholder="Sort"
        />
        {filtered && (
          <button
            type="button"
            onClick={() => update({ q: null, status: null, billingCycle: null })}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent"
          >
            Clear filters <X className="size-3" />
          </button>
        )}
        <div className="relative ms-auto w-full sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, provider, project…"
            aria-label="Search subscriptions"
            className="pl-7"
          />
        </div>
      </div>

      {list.items.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nothing matches these filters"
          description="Try another status or billing cycle, or clear the search."
          action={
            <Button size="sm" variant="outline" render={<Link href="/subscriptions" />}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Subscription</th>
                <th className="hidden md:table-cell">Status</th>
                <th className="text-right!">Amount</th>
                <th className="hidden md:table-cell">Next renewal</th>
                <th className="hidden lg:table-cell">Cancel by</th>
                <th className="hidden w-24 sm:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.items.map((subscription) => (
                <SubscriptionRow
                  key={subscription.id}
                  subscription={subscription}
                  today={today}
                  onPay={
                    canWrite && subscription.nextOccurrenceId && subscription.daysUntilRenewal !== null && subscription.daysUntilRenewal <= 7
                      ? () =>
                          setPaying({
                            occurrenceId: subscription.nextOccurrenceId as string,
                            name: subscription.name,
                            dueDate: subscription.nextRenewalDate as string,
                            amount: subscription.amount,
                            currency: subscription.currency,
                            accountId: subscription.accountId,
                            direction: "out",
                            renewal: true,
                          })
                      : undefined
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={cn("grid gap-4", isBusiness ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
        <Breakdown
          title="By category"
          rows={analytics.byCategory.map((g) => ({
            key: g.categoryId ?? "none",
            label: g.categoryName ?? "Uncategorized",
            count: g.count,
            monthly: g.monthly,
            annual: g.annual,
          }))}
        />
        <Breakdown
          title="By billing cycle"
          rows={analytics.byBillingCycle.map((g) => ({
            key: g.billingCycle,
            label: BILLING_LABELS[g.billingCycle],
            count: g.count,
            monthly: g.monthly,
            annual: g.annual,
            href: `/subscriptions?billingCycle=${g.billingCycle}`,
          }))}
        />
        {isBusiness && (
          <Breakdown
            title="By project"
            rows={analytics.byProject.map((g) => ({
              key: g.projectId ?? "none",
              label: g.projectName ?? "No project",
              count: g.count,
              monthly: g.monthly,
              annual: g.annual,
            }))}
          />
        )}
      </div>

      <MarkPaidDialog target={paying} onClose={() => setPaying(null)} />
    </div>
  );
}

function SubscriptionRow({ subscription: s, today, onPay }: { subscription: SubscriptionView; today: string; onPay?: () => void }) {
  const { money } = useApp();
  const router = useRouter();
  const statement = renewalStatement(s, money);
  const open = () => router.push(`/subscriptions/${s.id}`);
  return (
    <tr className="cursor-pointer hover:bg-accent/40" onClick={open}>
      <td className="max-w-0 px-3 py-2.5">
        <Link href={`/subscriptions/${s.id}`} className="block truncate font-medium" onClick={(e) => e.stopPropagation()}>
          {s.name}
        </Link>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {s.planName && <span className="truncate">{s.planName}</span>}
          {s.categoryName && <CategoryChip name={s.categoryName} icon={s.categoryIcon} />}
          <span className="md:hidden">
            <StatusBadge status={s.derivedStatus} label={s.statusLabel} />
          </span>
        </div>
        <p className={cn("mt-1 truncate text-xs md:hidden", statement.tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {statement.text}
        </p>
      </td>
      <td className="hidden px-3 py-2.5 md:table-cell">
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={s.derivedStatus} label={s.statusLabel} />
          <AutoRenewBadge autoRenew={s.autoRenew} />
        </div>
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="font-medium tabular-nums">{money(s.amount, s.currency)}</div>
        <div className="text-xs text-muted-foreground">{s.billingLabel}</div>
        {s.currency !== s.baseCurrency && s.baseAmount !== null && (
          <div className="text-[11px] text-muted-foreground tabular-nums">≈ {money(s.baseAmount)}</div>
        )}
      </td>
      <td className="hidden px-3 py-2.5 md:table-cell">
        <DueDate date={s.nextRenewalDate} today={today} />
        <p
          className={cn("mt-0.5 max-w-80 truncate text-xs", statement.tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}
          title={statement.text}
        >
          {statement.text}
        </p>
      </td>
      <td className="hidden px-3 py-2.5 lg:table-cell">
        {s.cancellationDeadline ? (
          <DueDate date={s.cancellationDeadline} today={today} className="text-xs" />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="hidden px-3 py-2.5 text-right sm:table-cell">
        {onPay && (
          <Button
            size="xs"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onPay();
            }}
          >
            Mark paid
          </Button>
        )}
      </td>
    </tr>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; count: number; monthly: number; annual: number; href?: string }>;
}) {
  const { money } = useApp();
  const max = Math.max(1, ...rows.map((r) => r.monthly));
  return (
    <Section title={title} hint="Monthly equivalent of active subscriptions">
      {rows.length === 0 ? (
        <EmptyNote>No active subscriptions.</EmptyNote>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((row) => {
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">
                    {row.label} <span className="text-xs text-muted-foreground">· {row.count}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{money(row.monthly)}</span>
                </div>
                <ProgressBar value={(row.monthly / max) * 100} className="mt-1" />
                <div className="mt-0.5 text-right text-[11px] text-muted-foreground tabular-nums">{money(row.annual)} a year</div>
              </>
            );
            return (
              <li key={row.key}>
                {row.href ? (
                  <Link href={row.href} className="block rounded-md hover:bg-accent/40">
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
