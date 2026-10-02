"use client";

import { type CommitmentKind, DEFAULT_REMINDER_OFFSETS, formatDay, relativeDays } from "@expensewise/core";
import {
  Banknote,
  BookOpen,
  Briefcase,
  Building2,
  CalendarClock,
  Globe,
  HandCoins,
  HardHat,
  House,
  Landmark,
  type LucideIcon,
  Receipt,
  Repeat,
  Server,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Account, Category, Project } from "@/lib/api/types";
import type { PriceChange, SubscriptionView } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { useApi } from "@/lib/use-api";

export const NONE = "__none__";

/** URL-driven state for filters and tabs: updates the query and keeps the scroll. */
export function useQueryNav() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const update = (changes: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "" || value === NONE) next.delete(key);
      else next.set(key, value);
    }
    startTransition(() => router.push(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  };
  return { update, pending, params };
}

/** The segmented control used for tabs across the app. */
export function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 p-1", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            value === option.value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type Option = { value: string; label: ReactNode; hint?: string };

/** A labelled single-choice select over string values; `NONE` stands for "not set". */
export function OptionSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  size,
  className,
  disabled,
}: {
  id?: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: Option[];
  placeholder: string;
  size?: "sm" | "default";
  className?: string;
  disabled?: boolean;
}) {
  const current = options.find((option) => option.value === (value ?? NONE));
  return (
    <Select value={value ?? NONE} disabled={disabled} onValueChange={(v) => typeof v === "string" && onChange(v)}>
      <SelectTrigger id={id} size={size} className={className}>
        <SelectValue>{current?.label ?? <span className="text-muted-foreground">{placeholder}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Accounts, categories and projects for the planning forms (cached per tab). */
export function useCatalog(options: { projects: boolean }) {
  const accounts = useApi<Account[]>("/accounts");
  const categories = useApi<Category[]>("/categories");
  const projects = useApi<Project[]>(options.projects ? "/projects" : null);
  return { accounts: accounts.data ?? [], categories: categories.data ?? [], projects: projects.data ?? [] };
}

export function accountOptions(accounts: Account[], none = "No account"): Option[] {
  return [{ value: NONE, label: none }, ...accounts.map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }))];
}

export function categoryOptions(categories: Category[], kind: "expense" | "income", none = "No category"): Option[] {
  const parents = categories.filter((c) => c.kind === kind && !c.parentId && !c.archived);
  const ordered: Category[] = [];
  for (const parent of parents) {
    ordered.push(parent);
    ordered.push(...categories.filter((c) => c.parentId === parent.id && !c.archived));
  }
  return [{ value: NONE, label: none }, ...ordered.map((c) => ({ value: c.id, label: <span className={cn(c.parentId && "ps-3")}>{c.name}</span> }))];
}

export function projectOptions(projects: Project[], none = "No project"): Option[] {
  return [{ value: NONE, label: none }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
}

export const fromOption = (value: string) => (value === NONE ? null : value);

/** "10 Oct 2027 · in 5 days". */
export function DueDate({ date, today, className }: { date: string | null | undefined; today: string; className?: string }) {
  if (!date) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const overdue = date < today;
  return (
    <span className={cn("tabular-nums", className)}>
      {formatDay(date)}
      <span className={cn("ms-1 text-xs", overdue ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>· {relativeDays(date, today)}</span>
    </span>
  );
}

/**
 * The one sentence that says what happens next: an expected automatic
 * renewal, a renewal the user must make by hand, or access ending.
 */
export function renewalStatement(
  subscription: Pick<SubscriptionView, "autoRenew" | "nextRenewalDate" | "expiryDate" | "derivedStatus" | "amount" | "currency">,
  money: (minor: number, currency?: string) => string,
): { text: string; tone: "info" | "warn" | "muted" } {
  const amount = money(subscription.amount, subscription.currency);
  if (subscription.derivedStatus === "cancellation_pending" || subscription.derivedStatus === "cancelled") {
    return subscription.expiryDate
      ? { text: `Cancelled — access ends on ${formatDay(subscription.expiryDate)}. No further renewals.`, tone: "muted" }
      : { text: "Cancelled — no further renewals.", tone: "muted" };
  }
  if (subscription.derivedStatus === "expired")
    return { text: `Expired${subscription.expiryDate ? ` on ${formatDay(subscription.expiryDate)}` : ""}.`, tone: "warn" };
  if (subscription.derivedStatus === "paused") return { text: "Paused — no reminders until you resume it.", tone: "muted" };
  if (!subscription.nextRenewalDate) return { text: "No renewal scheduled.", tone: "muted" };
  if (subscription.autoRenew) return { text: `Expected renewal payment: ${amount} on ${formatDay(subscription.nextRenewalDate)}`, tone: "info" };
  const deadline = subscription.expiryDate && subscription.expiryDate < subscription.nextRenewalDate ? subscription.expiryDate : subscription.nextRenewalDate;
  return { text: `Manual renewal required before ${formatDay(deadline)} (${amount})`, tone: "warn" };
}

export function AutoRenewBadge({ autoRenew }: { autoRenew: boolean }) {
  return (
    <Badge variant={autoRenew ? "success" : "warning"} size="sm">
      Auto-renew {autoRenew ? "on" : "off"}
    </Badge>
  );
}

/** "+22.2%" with the previous and new amounts on hover. */
export function PriceChangeBadge({ change, money, currency }: { change: PriceChange; money: (minor: number, currency?: string) => string; currency: string }) {
  const up = change.direction === "increase";
  const text = change.percent === null ? (up ? "Price up" : "Price down") : `${up ? "+" : "−"}${Math.abs(change.percent)}%`;
  return (
    <span
      title={`${money(change.previous, currency)} → ${money(change.current, currency)}`}
      className={cn(
        "inline-flex items-center rounded-sm px-1 text-[11px] font-medium tabular-nums",
        up ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {text}
    </span>
  );
}

const KIND_ICONS: Partial<Record<CommitmentKind, LucideIcon>> = {
  subscription: Repeat,
  salary: Briefcase,
  payroll: Users,
  rent: House,
  loan_payment: Landmark,
  insurance: ShieldCheck,
  tax: Receipt,
  utility: Zap,
  domain: Globe,
  hosting: Server,
  software: Building2,
  contractor: HardHat,
  education: BookOpen,
  income: HandCoins,
  custom: CalendarClock,
};

export function KindIcon({ kind, direction, className }: { kind: CommitmentKind; direction?: "in" | "out"; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? (direction === "in" ? Banknote : CalendarClock);
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        direction === "in" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

/**
 * Reminder offsets: the workspace default, or this item's own days before the
 * due date (presets plus any custom day count).
 */
export function ReminderOffsetsField({
  value,
  onChange,
  defaults,
}: {
  value: number[] | null;
  onChange: (value: number[] | null) => void;
  defaults?: number[];
}) {
  const workspaceDefault = defaults?.length ? defaults : DEFAULT_REMINDER_OFFSETS;
  const [custom, setCustom] = useState("");
  const own = value !== null;
  const chosen = value ?? workspaceDefault;
  const presets = [...new Set([60, 30, 14, 7, 3, 2, 1, 0, ...chosen])].sort((a, b) => b - a);
  const toggle = (offset: number) => {
    const next = chosen.includes(offset) ? chosen.filter((o) => o !== offset) : [...chosen, offset];
    onChange(next.sort((a, b) => b - a));
  };
  const addCustom = () => {
    const days = Number(custom);
    if (!Number.isInteger(days) || days < 0 || days > 365) return;
    if (!chosen.includes(days)) onChange([...chosen, days].sort((a, b) => b - a));
    setCustom("");
  };
  const label = (offset: number) => (offset === 0 ? "On the day" : offset === 1 ? "1 day before" : `${offset} days before`);
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Custom reminders
          <span className="block text-xs text-muted-foreground">
            {own ? "Only for this item." : `Using the workspace default: ${workspaceDefault.map((o) => (o === 0 ? "on the day" : `${o}d`)).join(", ")}.`}
          </span>
        </span>
        <Switch checked={own} onCheckedChange={(checked) => onChange(checked ? [...workspaceDefault] : null)} />
      </label>
      {own && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((offset) => (
              <button
                key={offset}
                type="button"
                onClick={() => toggle(offset)}
                aria-pressed={chosen.includes(offset)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs transition-colors",
                  chosen.includes(offset) ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {label(offset)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
              placeholder="Other: days before"
              aria-label="Custom reminder, days before"
              className="w-40"
            />
            <button type="button" onClick={addCustom} className="text-xs text-muted-foreground hover:text-foreground">
              Add
            </button>
            {chosen.length === 0 && <span className="text-xs text-amber-600 dark:text-amber-400">No reminders will be sent.</span>}
          </div>
        </>
      )}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
      {message}
    </p>
  );
}

/** A label + control pair. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Link to the transactions page listing these records. */
export function transactionsHref(ids: Array<string | null | undefined>) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))].slice(0, 100);
  return wanted.length ? `/transactions?period=all_time&ids=${wanted.join(",")}` : null;
}

export function toneForBudget(status: string): "good" | "warn" | "danger" | "default" {
  return status === "over" ? "danger" : status === "warning" ? "warn" : status === "on_track" ? "good" : "default";
}
