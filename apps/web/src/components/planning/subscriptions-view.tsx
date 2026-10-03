"use client";

import { formatDay, SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from "@financeos/core";
import { AlertTriangle, CalendarClock, CircleAlert, Plus, Repeat, Search, Wallet, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryChip, EmptyNote, EmptyState, Pill, ProgressBar, Section, StatCard } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SubscriptionAnalytics, SubscriptionList, SubscriptionView } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { MarkPaidDialog, type PayTarget } from "./payment-dialogs";
import { NONE, OptionSelect, renewalStatement, useQueryNav } from "./shared";
import { SubscriptionFormDialog } from "./subscription-form";
import { StatusMenu, statusTone, TONES, type Tone } from "./subscription-status";

export type SubscriptionFilters = { q?: string; status?: string; billingCycle?: string; sort?: string };

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: NONE, label: "All subscriptions" },
  { value: "trial,active,renewal_due,renewed", label: "Active only" },
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
          description="Add Netflix, Claude, your domain or hosting renewal. FinanceOS reminds you before each renewal, spots price changes and shows what they cost a year."
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={Wallet}
          label="You pay a month"
          value={money(analytics.monthlyTotal)}
          hint={`${money(analytics.annualTotal)} a year · ${analytics.activeCount} active`}
          href="/subscriptions?sort=monthly_desc"
        />
        <StatCard
          icon={CalendarClock}
          label="Due in the next 30 days"
          value={money(analytics.upcoming30.total)}
          hint={
            analytics.upcoming30.count
              ? `${analytics.upcoming30.count} renewal${analytics.upcoming30.count === 1 ? "" : "s"}${unconvertedNote(analytics.upcoming30.unconverted)}`
              : "Nothing renews soon"
          }
          tone={analytics.upcoming30.count ? "info" : "default"}
          href="/commitments?tab=upcoming&kind=subscription&days=30"
        />
        <StatCard
          icon={AlertTriangle}
          label="Not paid yet"
          value={analytics.overdue.count}
          hint={analytics.overdue.count ? `${money(analytics.overdue.total)} past its renewal date` : "All renewals are recorded"}
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
          placeholder="All subscriptions"
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
          <Input size="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search subscriptions" className="pl-7" />
        </div>
      </div>

      {list.items.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nothing matches"
          description="Try another filter, or clear the search."
          action={
            <Button size="sm" variant="outline" render={<Link href="/subscriptions" />}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.6fr)_7rem] items-center gap-4 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Subscription</span>
            <span>Status</span>
            <span>Next payment</span>
            <span className="text-right">Cost</span>
          </div>
          <ul className="divide-y divide-border">
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
          </ul>
        </div>
      )}

      <Breakdown
        groups={[
          {
            key: "category",
            label: "By category",
            rows: analytics.byCategory.map((g) => ({
              key: g.categoryId ?? "none",
              label: g.categoryName ?? "Uncategorized",
              count: g.count,
              monthly: g.monthly,
              annual: g.annual,
            })),
          },
          ...(isBusiness
            ? [
                {
                  key: "project",
                  label: "By project",
                  rows: analytics.byProject.map((g) => ({
                    key: g.projectId ?? "none",
                    label: g.projectName ?? "No project",
                    count: g.count,
                    monthly: g.monthly,
                    annual: g.annual,
                  })),
                },
              ]
            : []),
        ]}
      />

      <MarkPaidDialog target={paying} onClose={() => setPaying(null)} />
    </div>
  );
}

/** "in 31 days" as a chip that warms up as the day gets close. */
function Countdown({ days }: { days: number }) {
  const tone: Tone = days < 0 ? "red" : days <= 2 ? "red" : days <= 7 ? "amber" : "gray";
  const text = days < 0 ? `${-days}d overdue` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `in ${days} days`;
  return <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums whitespace-nowrap", TONES[tone].pill)}>{text}</span>;
}

function SubscriptionRow({ subscription: s, today, onPay }: { subscription: SubscriptionView; today: string; onPay?: () => void }) {
  const { money } = useApp();
  const statement = renewalStatement(s, money);
  const ended = s.derivedStatus === "cancellation_pending" || s.derivedStatus === "cancelled" || s.derivedStatus === "expired" || s.derivedStatus === "paused";
  const tone = statusTone(s.derivedStatus);
  const next = ended ? (
    <span className="text-xs text-muted-foreground">{statement.text}</span>
  ) : s.nextRenewalDate ? (
    <div className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm tabular-nums">{formatDay(s.nextRenewalDate)}</span>
        {s.daysUntilRenewal !== null && <Countdown days={s.daysUntilRenewal} />}
      </div>
      {s.cancellationDeadline && s.cancellationDeadline >= today && (
        <span className="block text-xs text-muted-foreground">Cancel by {formatDay(s.cancellationDeadline)} to avoid paying</span>
      )}
      {!s.autoRenew && <span className="block text-xs text-amber-600 dark:text-amber-400">Pay it manually — doesn't auto-renew</span>}
    </div>
  ) : (
    <span className="text-xs text-muted-foreground">—</span>
  );
  return (
    <li className="group relative">
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors group-hover:bg-accent/40 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.6fr)_7rem]",
          ended && "opacity-70",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold uppercase", tone.pill)}>
            {s.name.trim().charAt(0) || "?"}
          </span>
          <div className="min-w-0">
            <Link href={`/subscriptions/${s.id}`} className="block truncate font-medium after:absolute after:inset-0" title={s.name}>
              {s.name}
            </Link>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {s.categoryName ? <CategoryChip name={s.categoryName} icon={s.categoryIcon} /> : <span>{s.provider}</span>}
            </div>
          </div>
        </div>

        <div className="text-right md:order-last">
          <div className="font-semibold tabular-nums">{money(s.amount, s.currency)}</div>
          <div className="text-xs text-muted-foreground">
            {s.billingLabel}
            {s.currency !== s.baseCurrency && s.baseAmount !== null && <span className="block tabular-nums">≈ {money(s.baseAmount)}</span>}
          </div>
        </div>

        <div className="flex items-center md:order-none">
          <StatusMenu subscription={s} today={today} />
        </div>

        <div className="col-span-2 flex items-center justify-between gap-3 md:col-span-1">
          {next}
          {onPay && (
            <Button
              size="xs"
              variant="outline"
              className="relative z-10 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onPay();
              }}
            >
              Mark paid
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

type BreakdownRow = { key: string; label: string; count: number; monthly: number; annual: number };

/** Where the monthly cost goes, one grouping at a time. */
function Breakdown({ groups }: { groups: Array<{ key: string; label: string; rows: BreakdownRow[] }> }) {
  const { money } = useApp();
  const [active, setActive] = useState(groups[0]?.key);
  const group = groups.find((g) => g.key === active) ?? groups[0];
  if (!group) return null;
  const max = Math.max(1, ...group.rows.map((r) => r.monthly));
  return (
    <Section title="Where the money goes" hint="What active subscriptions cost a month">
      {groups.length > 1 && (
        <div className="mb-3 inline-flex rounded-lg bg-muted p-0.5 text-xs">
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setActive(g.key)}
              className={cn(
                "rounded-md px-2.5 py-1",
                g.key === group.key ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
      {group.rows.length === 0 ? (
        <EmptyNote>No active subscriptions.</EmptyNote>
      ) : (
        <ul className="grid gap-x-8 gap-y-2.5 md:grid-cols-2">
          {group.rows.map((row) => (
            <li key={row.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate">
                  {row.label} <span className="text-xs text-muted-foreground">· {row.count}</span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {money(row.monthly)}
                  <span className="text-xs font-normal text-muted-foreground">/mo</span>
                </span>
              </div>
              <ProgressBar value={(row.monthly / max) * 100} className="mt-1" />
              <div className="mt-0.5 text-right text-[11px] text-muted-foreground tabular-nums">{money(row.annual)} a year</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
