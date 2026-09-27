"use client";

import { addDays, addMonths, COMMITMENT_KIND_LABELS, COMMITMENT_KINDS, formatDay, formatMoney } from "@expensewise/core";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  MoreHorizontal,
  Plus,
  Repeat,
  Search,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, EmptyState, Pill, ProgressBar, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { AnnualCommitments, CalendarData, CommitmentList, CommitmentView, ScheduleItem, ScheduleTotals, Upcoming } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { CommitmentDetailDrawer } from "./commitment-detail";
import { CommitmentFormDialog } from "./commitment-form";
import { DueActions, MarkPaidDialog, type PayTarget, SkipDialog, type SkipTarget } from "./payment-dialogs";
import { categoryOptions, DueDate, KindIcon, NONE, OptionSelect, projectOptions, SegmentedTabs, useCatalog, useQueryNav } from "./shared";

export type CommitmentsTab = "upcoming" | "calendar" | "all" | "annual";

const TABS: ReadonlyArray<{ value: CommitmentsTab; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "calendar", label: "Calendar" },
  { value: "all", label: "All commitments" },
  { value: "annual", label: "Annual" },
];

/** Query keys that belong to one tab and are dropped when switching. */
const TAB_KEYS = ["days", "month", "year", "status", "q", "subscriptions", "categoryId", "projectId"];

const KIND_OPTIONS = [{ value: NONE, label: "All kinds" }, ...COMMITMENT_KINDS.map((kind) => ({ value: kind, label: COMMITMENT_KIND_LABELS[kind] }))];
const DIRECTION_OPTIONS = [
  { value: NONE, label: "In and out" },
  { value: "out", label: "Money out" },
  { value: "in", label: "Money in" },
];

export type CommitmentsViewProps = {
  tab: CommitmentsTab;
  today: string;
  filters: Record<string, string>;
  upcoming?: Upcoming;
  calendar?: { data: CalendarData; month: string };
  all?: CommitmentList;
  annual?: AnnualCommitments;
};

function dayLabel(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function payTargetFor(item: ScheduleItem): PayTarget | null {
  if (!item.occurrenceId) return null;
  return {
    occurrenceId: item.occurrenceId,
    name: item.name,
    dueDate: item.date,
    amount: item.amount,
    currency: item.currency,
    accountId: item.accountId,
    direction: item.direction,
    renewal: Boolean(item.subscriptionId),
  };
}

export function AddCommitmentButton() {
  const { canWrite } = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (params.get("new") === "1") setOpen(true);
  }, [params]);
  if (!canWrite) return null;
  const change = (next: boolean) => {
    setOpen(next);
    if (!next && params.get("new")) {
      const rest = new URLSearchParams(params.toString());
      rest.delete("new");
      router.replace(`/commitments${rest.size ? `?${rest}` : ""}`, { scroll: false });
    }
  };
  return (
    <>
      <Button size="xs" onClick={() => change(true)}>
        <Plus className="size-3.5" /> Add commitment
      </Button>
      <CommitmentFormDialog open={open} onOpenChange={change} onSaved={(id) => router.push(`/commitments?tab=all&focus=${id}`)} />
    </>
  );
}

export function CommitmentsView(props: CommitmentsViewProps) {
  const { update, pending, params } = useQueryNav();
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const [skipping, setSkipping] = useState<SkipTarget | null>(null);
  const focus = params.get("focus");

  const handlers = {
    open: (commitmentId: string) => update({ focus: commitmentId }),
    pay: (item: ScheduleItem) => setPaying(payTargetFor(item)),
    skip: (item: ScheduleItem) => item.occurrenceId && setSkipping({ occurrenceId: item.occurrenceId, name: item.name, dueDate: item.date }),
  };

  return (
    <div className={cn("space-y-4 transition-opacity", pending && "opacity-70")}>
      <SegmentedTabs
        label="Commitments view"
        value={props.tab}
        options={TABS}
        onChange={(tab) => update({ tab: tab === "upcoming" ? null : tab, ...Object.fromEntries(TAB_KEYS.map((key) => [key, null])) })}
        className="w-fit"
      />
      {props.tab === "upcoming" && props.upcoming && <UpcomingTab data={props.upcoming} filters={props.filters} today={props.today} {...handlers} />}
      {props.tab === "calendar" && props.calendar && (
        <CalendarTab data={props.calendar.data} month={props.calendar.month} filters={props.filters} today={props.today} {...handlers} />
      )}
      {props.tab === "all" && props.all && <AllTab list={props.all} filters={props.filters} today={props.today} onOpen={handlers.open} />}
      {props.tab === "annual" && props.annual && <AnnualTab data={props.annual} filters={props.filters} onOpen={handlers.open} />}

      <CommitmentDetailDrawer id={focus} onClose={() => update({ focus: null })} />
      <MarkPaidDialog target={paying} onClose={() => setPaying(null)} />
      <SkipDialog target={skipping} onClose={() => setSkipping(null)} />
    </div>
  );
}

type Handlers = { open: (commitmentId: string) => void; pay: (item: ScheduleItem) => void; skip: (item: ScheduleItem) => void };

function TotalsStrip({ totals, label }: { totals: ScheduleTotals; label: string }) {
  const { money } = useApp();
  const outside = totals.unconverted.filter((u) => !u.paid);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={ArrowUpRight} label={`Due out ${label}`} value={money(totals.out)} hint={`${totals.count} items`} />
        <StatCard icon={ArrowDownLeft} label={`Expected in ${label}`} value={money(totals.in)} tone={totals.in > 0 ? "good" : "default"} />
        <StatCard
          icon={Wallet}
          label="Already paid"
          value={money(totals.paidOut)}
          hint={totals.paidIn ? `${money(totals.paidIn)} received` : "In this range"}
        />
        <StatCard
          icon={AlertTriangle}
          label="Payment not recorded"
          value={totals.overdueCount}
          tone={totals.overdueCount ? "danger" : "default"}
          hint={totals.overdueCount ? "Past due" : "Nothing overdue"}
        />
      </div>
      {outside.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Pill icon={CircleAlert} tone="warn" href="/settings/currency">
            Not in the totals (no exchange rate): {outside.map((u) => formatMoney(u.amount, u.currency)).join(", ")}
          </Pill>
        </div>
      )}
    </>
  );
}

function ScheduleRow({ item, open, pay, skip }: { item: ScheduleItem; today: string } & Handlers) {
  const { money, canWrite } = useApp();
  const due = item.status === "scheduled" || item.status === "overdue";
  return (
    <li className={cn("flex items-center gap-3 px-3 py-2.5", item.status === "overdue" && "bg-red-500/5")}>
      <KindIcon kind={item.kind} direction={item.direction} />
      <button type="button" onClick={() => open(item.commitmentId)} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium hover:underline">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {item.kindLabel}
          {item.accountName ? ` · ${item.accountName}` : ""}
          {item.autoPay ? " · auto" : ""}
          {item.status === "projected" ? " · projected" : ""}
          {item.status === "overdue" ? ` · due ${formatDay(item.date, "short")}, ${-item.daysUntil}d ago` : ""}
        </span>
      </button>
      <div className="shrink-0 text-right">
        <div className={cn("text-sm font-medium tabular-nums", item.direction === "in" && "text-money-in", item.status === "paid" && "text-muted-foreground")}>
          {item.direction === "in" ? "+" : ""}
          {money(item.status === "paid" ? (item.paidAmount ?? item.amount) : item.amount, item.currency)}
        </div>
        {item.currency !== item.baseCurrency && (
          <div className="text-[11px] text-muted-foreground tabular-nums">{item.baseAmount === null ? "no rate" : `≈ ${money(item.baseAmount)}`}</div>
        )}
      </div>
      {canWrite && due && item.occurrenceId ? (
        <DueActions compact onPay={() => pay(item)} onSkip={() => skip(item)} className="hidden sm:flex" />
      ) : item.status === "paid" ? (
        <StatusBadge status="paid" />
      ) : (
        <span className="hidden w-[7.5rem] sm:block" />
      )}
      {canWrite && due && item.occurrenceId && (
        <Button size="xs" variant="outline" className="sm:hidden" onClick={() => pay(item)}>
          Paid
        </Button>
      )}
    </li>
  );
}

function UpcomingTab({ data, filters, today, ...handlers }: { data: Upcoming; filters: Record<string, string>; today: string } & Handlers) {
  const { update } = useQueryNav();
  const { canWrite } = useApp();
  const [creating, setCreating] = useState(false);
  const overdue = data.items.filter((item) => item.status === "overdue");
  const groups = data.groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.status !== "overdue") }))
    .filter((group) => group.items.length);
  const { money } = useApp();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          label="Window"
          value={String(data.days) as "7" | "30" | "90"}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
          onChange={(days) => update({ days: days === "30" ? null : days })}
        />
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.kind ?? NONE}
          onChange={(v) => update({ kind: v })}
          options={KIND_OPTIONS}
          placeholder="All kinds"
        />
        <OptionSelect
          size="sm"
          className="w-36"
          value={filters.direction ?? NONE}
          onChange={(v) => update({ direction: v })}
          options={DIRECTION_OPTIONS}
          placeholder="In and out"
        />
      </div>

      <TotalsStrip totals={data.totals} label={`in ${data.days} days`} />

      {overdue.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-red-500/30 bg-card">
          <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/5 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-300">
            <AlertTriangle className="size-4" /> Payment not recorded
            <span className="text-xs font-normal text-muted-foreground">Record it, link the transaction, or skip it.</span>
          </div>
          <ul className="divide-y divide-border">
            {overdue.map((item) => (
              <ScheduleRow key={item.key} item={item} today={today} {...handlers} />
            ))}
          </ul>
        </section>
      )}

      {groups.length === 0 && overdue.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={filters.kind || filters.direction ? "Nothing due with these filters" : `Nothing due in the next ${data.days} days`}
          description="Rent, loan installments, insurance, salary and subscription renewals show up here before they are due, grouped by day."
          action={
            canWrite ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus className="size-3.5" /> Add commitment
                </Button>
                <Button size="sm" variant="outline" render={<Link href="/subscriptions?new=1" />}>
                  <Repeat className="size-3.5" /> Add subscription
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <section key={group.date} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
                <span className={cn("font-medium", group.date === today && "text-foreground")}>
                  {dayLabel(group.date, today)} <span className="font-normal text-muted-foreground">· {formatDay(group.date)}</span>
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {group.totalOut ? `${money(group.totalOut)} out` : ""}
                  {group.totalOut && group.totalIn ? " · " : ""}
                  {group.totalIn ? `${money(group.totalIn)} in` : ""}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {group.items.map((item) => (
                  <ScheduleRow key={item.key} item={item} today={today} {...handlers} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <CommitmentFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarTab({
  data,
  month,
  filters,
  today,
  ...handlers
}: { data: CalendarData; month: string; filters: Record<string, string> } & Handlers & { today: string }) {
  const { update } = useQueryNav();
  const { money, locale, isBusiness } = useApp();
  const { categories, projects } = useCatalog({ projects: isBusiness });
  const [selected, setSelected] = useState<string | null>(null);
  const byDay = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data.days]);
  const cells: string[] = [];
  for (let d = data.from; d <= data.to; d = addDays(d, 1)) cells.push(d);
  const monthStart = `${month}-01`;
  const shift = (months: number) => update({ month: addMonths(monthStart, months).slice(0, 7) });
  const selectedDay = selected ? byDay.get(selected) : null;
  const inMonth = data.items.filter((item) => item.date.startsWith(month));
  const monthTotals: ScheduleTotals = {
    count: inMonth.length,
    out: inMonth
      .filter((i) => i.direction === "out" && i.status !== "paid" && i.status !== "skipped" && i.status !== "cancelled")
      .reduce((s, i) => s + (i.baseAmount ?? 0), 0),
    in: inMonth
      .filter((i) => i.direction === "in" && i.status !== "paid" && i.status !== "skipped" && i.status !== "cancelled")
      .reduce((s, i) => s + (i.baseAmount ?? 0), 0),
    paidOut: inMonth.filter((i) => i.direction === "out" && i.status === "paid").reduce((s, i) => s + (i.baseAmount ?? 0), 0),
    paidIn: inMonth.filter((i) => i.direction === "in" && i.status === "paid").reduce((s, i) => s + (i.baseAmount ?? 0), 0),
    overdueCount: inMonth.filter((i) => i.status === "overdue").length,
    unconverted: inMonth
      .filter((i) => i.baseAmount === null)
      .map((i) => ({ currency: i.currency, amount: i.amount, direction: i.direction, paid: i.status === "paid" })),
  };

  const chip = (item: ScheduleItem) => (
    <button
      key={item.key}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        handlers.open(item.commitmentId);
      }}
      title={`${item.name} · ${money(item.amount, item.currency)}`}
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-1 rounded px-1 py-0.5 text-left text-[11px] leading-tight",
        item.status === "overdue" && "bg-red-500/15 text-red-700 dark:text-red-300",
        item.status === "paid" && "bg-emerald-500/10 text-muted-foreground line-through decoration-muted-foreground/40",
        item.status === "skipped" && "text-muted-foreground line-through",
        item.status === "scheduled" && (item.direction === "in" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-foreground"),
        item.status === "projected" && "border border-dashed border-border text-muted-foreground",
      )}
    >
      <span className="truncate">{item.name}</span>
      <span className="hidden shrink-0 tabular-nums xl:inline">{formatMoney(item.amount, item.currency, { locale, compact: true })}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="outline" aria-label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-32 text-center text-sm font-medium">{formatMonth(month)}</span>
          <Button size="icon-sm" variant="outline" aria-label="Next month" onClick={() => shift(1)}>
            <ChevronRight className="size-4" />
          </Button>
          {month !== today.slice(0, 7) && (
            <Button size="xs" variant="ghost" onClick={() => update({ month: null })}>
              This month
            </Button>
          )}
        </div>
        <OptionSelect
          size="sm"
          className="w-40"
          value={filters.kind ?? NONE}
          onChange={(v) => update({ kind: v })}
          options={KIND_OPTIONS}
          placeholder="All kinds"
        />
        <OptionSelect
          size="sm"
          className="w-36"
          value={filters.direction ?? NONE}
          onChange={(v) => update({ direction: v })}
          options={DIRECTION_OPTIONS}
          placeholder="In and out"
        />
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.categoryId ?? NONE}
          onChange={(v) => update({ categoryId: v })}
          options={[
            { value: NONE, label: "All categories" },
            ...categoryOptions(categories, "expense").slice(1),
            ...categoryOptions(categories, "income").slice(1),
          ]}
          placeholder="All categories"
        />
        {isBusiness && (
          <OptionSelect
            size="sm"
            className="w-40"
            value={filters.projectId ?? NONE}
            onChange={(v) => update({ projectId: v })}
            options={[{ value: NONE, label: "All projects" }, ...projectOptions(projects).slice(1)]}
            placeholder="All projects"
          />
        )}
      </div>

      <TotalsStrip totals={monthTotals} label={`in ${formatMonth(month, "en-GB", true)}`} />

      <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
        <div className="grid grid-cols-7 border-b border-border bg-muted/30 text-center text-xs text-muted-foreground">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1.5">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((date) => {
            const day = byDay.get(date);
            const items = day?.items ?? [];
            const outside = !date.startsWith(month);
            return (
              // biome-ignore lint/a11y/useSemanticElements: a calendar cell holds block content (the day's items)
              <div
                key={date}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(date === selected ? null : date)}
                onKeyDown={(e) => e.key === "Enter" && setSelected(date)}
                className={cn(
                  "flex min-h-28 min-w-0 cursor-pointer flex-col gap-1 border-b border-e border-border p-1.5 transition-colors hover:bg-accent/30 [&:nth-child(7n)]:border-e-0",
                  outside && "bg-muted/20 text-muted-foreground",
                  selected === date && "bg-accent/40",
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                      date === today && "bg-primary font-semibold text-primary-foreground",
                    )}
                  >
                    {Number(date.slice(8, 10))}
                  </span>
                  {day && (day.totalOut > 0 || day.totalIn > 0) && (
                    <span className="truncate text-[10px] text-muted-foreground tabular-nums">
                      {formatMoney(day.totalOut || day.totalIn, data.baseCurrency, { locale, compact: true })}
                    </span>
                  )}
                </div>
                {items.slice(0, 3).map(chip)}
                {items.length > 3 && <span className="px-1 text-[11px] text-muted-foreground">+{items.length - 3} more</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted" /> Scheduled
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-muted-foreground" /> Projected from the schedule
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-emerald-500/30" /> Paid or expected income
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-red-500/40" /> Payment not recorded
        </span>
      </div>

      {/* The agenda: the selected day on desktop, the whole month on a phone. */}
      <div className={cn(selectedDay ? "" : "md:hidden")}>
        {(selectedDay ? [selectedDay] : data.days.filter((d) => d.date.startsWith(month))).length === 0 ? (
          <EmptyNote>Nothing is due this month.</EmptyNote>
        ) : (
          <div className="space-y-3">
            {(selectedDay ? [selectedDay] : data.days.filter((d) => d.date.startsWith(month))).map((day) => (
              <section key={day.date} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 text-xs font-medium">
                  {dayLabel(day.date, today)} · {formatDay(day.date)}
                  {selectedDay && (
                    <button type="button" onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                      Close
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-border">
                  {day.items.map((item) => (
                    <ScheduleRow key={item.key} item={item} today={today} {...handlers} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: NONE, label: "Active and paused" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

function AllTab({ list, filters, today, onOpen }: { list: CommitmentList; filters: Record<string, string>; today: string; onOpen: (id: string) => void }) {
  const { money, canWrite } = useApp();
  const { update } = useQueryNav();
  const router = useRouter();
  const [query, setQuery] = useState(filters.q ?? "");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CommitmentView | null>(null);

  useEffect(() => setQuery(filters.q ?? ""), [filters.q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce on the query only
  useEffect(() => {
    if ((filters.q ?? "") === query) return;
    const timer = setTimeout(() => update({ q: query.trim() || null }), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const act = async (commitment: CommitmentView, action: "pause" | "resume" | "end") => {
    try {
      await clientApi(`/commitments/${commitment.id}/${action}`, { method: "POST" });
      toast.success(
        action === "pause" ? `${commitment.name} paused` : action === "resume" ? `${commitment.name} resumed` : `${commitment.name} ended; history kept`,
      );
      invalidateApiCache("/commitments");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const filtered = Boolean(filters.q || filters.kind || filters.status || filters.subscriptions);
  const outside = list.totals.unconverted;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={ArrowUpRight} label="Monthly outgoing" value={money(list.totals.monthlyOut)} hint="Monthly equivalent, active" />
        <StatCard icon={CalendarDays} label="Yearly outgoing" value={money(list.totals.annualOut)} hint="Annualized" href="/commitments?tab=annual" />
        <StatCard icon={ArrowDownLeft} label="Monthly expected income" value={money(list.totals.monthlyIn)} tone={list.totals.monthlyIn ? "good" : "default"} />
        <StatCard
          icon={CalendarClock}
          label="Commitments"
          value={list.total}
          hint={`${list.items.filter((c) => c.overdue).length} with a payment not recorded`}
        />
      </div>
      {outside.length > 0 && (
        <Pill icon={CircleAlert} tone="warn" href="/settings/currency">
          Not in the totals (no exchange rate): {outside.map((u) => `${formatMoney(u.monthly, u.currency)}/month`).join(", ")}
        </Pill>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.status ?? NONE}
          onChange={(v) => update({ status: v })}
          options={STATUS_OPTIONS}
          placeholder="Active and paused"
        />
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.kind ?? NONE}
          onChange={(v) => update({ kind: v })}
          options={KIND_OPTIONS}
          placeholder="All kinds"
        />
        <OptionSelect
          size="sm"
          className="w-48"
          value={filters.subscriptions ?? NONE}
          onChange={(v) => update({ subscriptions: v })}
          options={[
            { value: NONE, label: "Without subscriptions" },
            { value: "include", label: "Including subscriptions" },
            { value: "only", label: "Only subscriptions" },
          ]}
          placeholder="Without subscriptions"
        />
        <div className="relative ms-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, payee…"
            aria-label="Search commitments"
            className="pl-7"
          />
        </div>
      </div>

      {list.items.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={filtered ? "Nothing matches these filters" : "No commitments yet"}
          description={
            filtered
              ? "Try another status or kind, or include subscriptions."
              : "Add rent, loan installments, insurance premiums, tax, school fees or expected salary. You get reminders before each one and can record it in one tap."
          }
          action={
            filtered ? (
              <Button size="sm" variant="outline" render={<Link href="/commitments?tab=all" />}>
                Clear filters
              </Button>
            ) : canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> Add commitment
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Commitment</th>
                <th className="text-right!">Amount</th>
                <th className="hidden md:table-cell">Next due</th>
                <th className="hidden lg:table-cell">Account</th>
                <th className="hidden sm:table-cell">Status</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.items.map((c) => (
                <tr key={c.id} className={cn("cursor-pointer hover:bg-accent/40", c.overdue && "bg-red-500/5")} onClick={() => onOpen(c.id)}>
                  <td className="max-w-0 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <KindIcon kind={c.kind} direction={c.direction} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{c.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.kindLabel}
                          {c.payee ? ` · ${c.payee}` : ""}
                          {c.projectName ? ` · ${c.projectName}` : ""}
                        </p>
                        <p className="text-xs md:hidden">
                          <DueDate date={c.status === "active" ? (c.nextOccurrence?.dueDate ?? c.nextDueDate) : null} today={today} />
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className={cn("font-medium tabular-nums", c.direction === "in" && "text-money-in")}>{money(c.amount, c.currency)}</div>
                    <div className="text-xs text-muted-foreground">{c.frequencyLabel}</div>
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    {c.status === "active" ? (
                      <DueDate date={c.nextOccurrence?.dueDate ?? c.nextDueDate} today={today} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="hidden px-3 py-2.5 text-muted-foreground lg:table-cell">{c.accountName ?? "—"}</td>
                  <td className="hidden px-3 py-2.5 sm:table-cell">
                    <StatusBadge status={c.overdue ? "overdue" : c.status} label={c.overdue ? "Not recorded" : undefined} />
                  </td>
                  <td className="px-2 py-2.5 text-right" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {canWrite && (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button aria-label={`Actions for ${c.name}`} size="icon-xs" variant="ghost" />}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          <DropdownMenuItem onClick={() => onOpen(c.id)}>Open</DropdownMenuItem>
                          {c.subscriptionId ? (
                            <DropdownMenuItem onClick={() => router.push(`/subscriptions/${c.subscriptionId}`)}>Open subscription</DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => setEditing(c)}>Edit</DropdownMenuItem>
                          )}
                          {c.status === "active" && <DropdownMenuItem onClick={() => void act(c, "pause")}>Pause</DropdownMenuItem>}
                          {c.status !== "active" && <DropdownMenuItem onClick={() => void act(c, "resume")}>Resume</DropdownMenuItem>}
                          {c.status !== "ended" && <DropdownMenuItem onClick={() => void act(c, "end")}>End</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CommitmentFormDialog open={creating} onOpenChange={setCreating} onSaved={onOpen} />
      <CommitmentFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} commitment={editing} />
    </div>
  );
}

function AnnualTab({ data, filters, onOpen }: { data: AnnualCommitments; filters: Record<string, string>; onOpen: (id: string) => void }) {
  const { money } = useApp();
  const { update } = useQueryNav();
  const maxKind = Math.max(1, ...data.byKind.map((k) => k.annualized));
  const maxCategory = Math.max(1, ...data.byCategory.map((c) => c.annualized));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="outline" aria-label="Previous year" onClick={() => update({ year: String(data.year - 1) })}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-16 text-center text-sm font-medium tabular-nums">{data.year}</span>
          <Button size="icon-sm" variant="outline" aria-label="Next year" onClick={() => update({ year: String(data.year + 1) })}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <OptionSelect
          size="sm"
          className="w-44"
          value={filters.kind ?? NONE}
          onChange={(v) => update({ kind: v })}
          options={KIND_OPTIONS}
          placeholder="All kinds"
        />
        <OptionSelect
          size="sm"
          className="w-36"
          value={filters.direction ?? NONE}
          onChange={(v) => update({ direction: v })}
          options={DIRECTION_OPTIONS}
          placeholder="In and out"
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={CalendarDays}
          label="Total annual commitment"
          value={money(data.totals.out.annualized)}
          hint={`${data.totals.out.count} commitments, annualized`}
        />
        <StatCard icon={CalendarClock} label={`Falls due in ${data.year}`} value={money(data.totals.out.inYear)} hint="Actual due dates this year" />
        <StatCard icon={Wallet} label="Monthly equivalent" value={money(data.totals.out.monthlyEquivalent)} hint="What to set aside each month" />
        <StatCard
          icon={ArrowDownLeft}
          label="Expected income"
          value={money(data.totals.in.annualized)}
          hint={`${money(data.totals.in.monthlyEquivalent)} a month`}
          tone={data.totals.in.count ? "good" : "default"}
        />
      </div>
      {data.unconverted.length > 0 && (
        <Pill icon={CircleAlert} tone="warn" href="/settings/currency">
          {data.unconverted.length} not in the totals (no exchange rate):{" "}
          {data.unconverted.map((u) => `${u.name} ${formatMoney(u.annualized, u.currency)}`).join(", ")}
        </Pill>
      )}

      {data.items.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={`Nothing scheduled for ${data.year}`}
          description="Active commitments and subscriptions add up here: what each kind costs a year and per month."
          action={
            <Button size="sm" variant="outline" render={<Link href="/commitments?tab=all" />}>
              Add rent, bills or salary
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="By kind" hint="Annualized, base currency">
              <ul className="space-y-2.5">
                {data.byKind.map((k) => (
                  <li key={`${k.direction}:${k.kind}`}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">
                        {k.kindLabel}
                        {k.direction === "in" && <span className="text-xs text-money-in"> · income</span>}
                        <span className="text-xs text-muted-foreground"> · {k.count}</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">{money(k.annualized)}</span>
                    </div>
                    <ProgressBar value={(k.annualized / maxKind) * 100} tone={k.direction === "in" ? "good" : "default"} className="mt-1" />
                    <div className="mt-0.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
                      <span>{money(k.monthlyEquivalent)}/month</span>
                      <span>
                        {money(k.inYear)} due in {data.year}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="By category" hint="Annualized, base currency">
              <ul className="space-y-2.5">
                {data.byCategory.map((c) => (
                  <li key={`${c.direction}:${c.categoryId ?? "none"}`}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">
                        {c.categoryName ?? "Uncategorized"}
                        <span className="text-xs text-muted-foreground"> · {c.count}</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">{money(c.annualized)}</span>
                    </div>
                    <ProgressBar value={(c.annualized / maxCategory) * 100} tone={c.direction === "in" ? "good" : "default"} className="mt-1" />
                    <div className="mt-0.5 text-right text-[11px] text-muted-foreground tabular-nums">{money(c.monthlyEquivalent)}/month</div>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
          <Section title="Every commitment" hint="Largest first">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                    <th>Name</th>
                    <th className="hidden sm:table-cell">Schedule</th>
                    <th className="text-right!">A year</th>
                    <th className="hidden text-right! md:table-cell">Per month</th>
                    <th className="hidden text-right! md:table-cell">Due in {data.year}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.items.map((item) => (
                    <tr key={item.commitmentId} className="cursor-pointer hover:bg-accent/40" onClick={() => onOpen(item.commitmentId)}>
                      <td className="max-w-0 px-3 py-2">
                        <p className="truncate font-medium">{item.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {item.kindLabel}
                          {item.categoryName ? ` · ${item.categoryName}` : ""}
                        </p>
                      </td>
                      <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                        {money(item.amount, item.currency)} · {item.frequencyLabel}
                      </td>
                      <td className={cn("px-3 py-2 text-right font-medium tabular-nums", item.direction === "in" && "text-money-in")}>
                        {item.annualizedBase === null ? money(item.annualized, item.currency) : money(item.annualizedBase)}
                      </td>
                      <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">
                        {item.monthlyEquivalentBase === null ? money(item.monthlyEquivalent, item.currency) : money(item.monthlyEquivalentBase)}
                      </td>
                      <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">
                        {item.inYearBase === null ? money(item.inYear, item.currency) : money(item.inYearBase)}
                        <span className="text-xs text-muted-foreground"> ×{item.occurrencesInYear}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
