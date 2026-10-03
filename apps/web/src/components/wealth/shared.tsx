"use client";

import { COMMON_CURRENCIES, formatDay, parseMoneyInput, TYPE_LABELS } from "@financeos/core";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { StatusBadge } from "@/components/app/blocks";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Account, Category, Project } from "@/lib/api/types";
import type { LinkedTx } from "@/lib/api/types/wealth";
import { cn } from "@/lib/cn";
import { invalidateApiCache, useApi } from "@/lib/use-api";

export const NONE = "__none__";

export const ASSET_KIND_LABELS: Record<string, string> = {
  equipment: "Equipment",
  electronics: "Electronics",
  vehicle: "Vehicle",
  property: "Property",
  land: "Land",
  jewelry: "Jewellery",
  business_asset: "Business asset",
  other: "Other",
};

export const INVESTMENT_KIND_LABELS: Record<string, string> = {
  stock: "Stocks",
  mutual_fund: "Mutual fund",
  fixed_deposit: "Fixed deposit",
  savings_certificate: "Savings certificate",
  bond: "Bond",
  dps: "DPS",
  gold: "Gold",
  crypto: "Crypto",
  real_estate: "Real estate",
  business_equity: "Business equity",
  retirement: "Retirement",
  other: "Other",
};

export const LIABILITY_KIND_LABELS: Record<string, string> = {
  loan: "Loan",
  mortgage: "Mortgage",
  credit: "Credit",
  personal_debt: "Personal debt",
  business_debt: "Business debt",
  payable: "Payable (bill)",
  other: "Other",
};

export const RECEIVABLE_KIND_LABELS: Record<string, string> = {
  invoice: "Invoice",
  loan: "Money lent",
  other: "Other",
};

/** Reloads server data and the client cache after a change. */
export function useRefresh() {
  const router = useRouter();
  return (prefix?: string) => {
    invalidateApiCache(prefix);
    router.refresh();
  };
}

/** Minor units from a typed major amount; null when it is not a plain positive number. */
export function toMinor(text: string, currency: string): number | null {
  if (!text.trim()) return null;
  return parseMoneyInput(text, currency);
}

/**
 * Calls `onNew` once when the URL carries `?new=1` (the global "+ Add" menu),
 * then removes the flag so a refresh does not reopen the dialog. Render it
 * inside <Suspense>: it reads the search params.
 */
export function NewParamOpener({ onNew, param = "new" }: { onNew: () => void; param?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || params.get(param) !== "1") return;
    fired.current = true;
    onNew();
    const next = new URLSearchParams(params.toString());
    next.delete(param);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
      scroll: false,
    });
  }, [params, param, onNew, router, pathname]);
  return null;
}

/** Scrolls to and briefly highlights the element with `data-focus-id` matching `?focus=`. */
export function useFocusHighlight(focusId: string | undefined) {
  const [active, setActive] = useState<string | undefined>(focusId);
  useEffect(() => {
    if (!focusId) return;
    setActive(focusId);
    const element = document.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => setActive(undefined), 4000);
    return () => clearTimeout(timer);
  }, [focusId]);
  return active;
}

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
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A labelled on/off setting: the label names the switch, the hint explains it. */
export function SwitchRow({
  id,
  title,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        {title}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
      {error}
    </p>
  );
}

/** A major-units amount input with the currency shown alongside. */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  placeholder,
  required,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  currency: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "0"}
        required={required}
        className="pr-12 tabular-nums"
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">{currency}</span>
    </div>
  );
}

export function CurrencySelect({ id, value, onChange, disabled }: { id?: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => typeof v === "string" && onChange(v)} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {[...new Set([value, ...COMMON_CURRENCIES])].map((code) => (
          <SelectItem key={code} value={code}>
            {code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A select over a label map, e.g. asset kinds. */
export function KindSelect<K extends string>({
  id,
  value,
  onChange,
  labels,
}: {
  id?: string;
  value: K;
  onChange: (value: K) => void;
  labels: Record<string, string>;
}) {
  return (
    <Select value={value} onValueChange={(v) => typeof v === "string" && onChange(v as K)}>
      <SelectTrigger id={id}>
        <SelectValue>{labels[value] ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(labels).map(([key, label]) => (
          <SelectItem key={key} value={key}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AccountSelect({
  id,
  value,
  onChange,
  noneLabel,
  enabled = true,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  noneLabel?: string;
  enabled?: boolean;
}) {
  const accounts = useApi<Account[]>(enabled ? "/accounts" : null);
  const list = (accounts.data ?? []).filter((a) => a.status === "active");
  const current = list.find((a) => a.id === value);
  return (
    <Select value={value ?? NONE} onValueChange={(v) => typeof v === "string" && onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id}>
        <SelectValue>{current ? `${current.name} · ${current.currency}` : value ? "Account" : (noneLabel ?? "Choose an account")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {list.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name} · {a.currency}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ProjectSelect({
  id,
  value,
  onChange,
  enabled = true,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  enabled?: boolean;
}) {
  const projects = useApi<Project[]>(enabled ? "/projects" : null);
  const list = projects.data ?? [];
  const current = list.find((p) => p.id === value);
  return (
    <Select value={value ?? NONE} onValueChange={(v) => typeof v === "string" && onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id}>
        <SelectValue>{current?.name ?? (value ? "Project" : "No project")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No project</SelectItem>
        {list.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CategorySelect({
  id,
  kind,
  value,
  onChange,
  enabled = true,
}: {
  id?: string;
  kind: "expense" | "income";
  value: string | null;
  onChange: (value: string | null) => void;
  enabled?: boolean;
}) {
  const categories = useApi<Category[]>(enabled ? "/categories" : null);
  const list = (categories.data ?? []).filter((c) => c.kind === kind && !c.archived);
  const current = list.find((c) => c.id === value);
  return (
    <Select value={value ?? NONE} onValueChange={(v) => typeof v === "string" && onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id}>
        <SelectValue>{current?.name ?? (value ? "Category" : "No category")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No category</SelectItem>
        {list.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className={cn(c.parentId && "ps-3 text-muted-foreground")}>{c.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type ParamTabsProps = {
  param: string;
  value: string;
  options: Array<{ value: string; label: string; count?: number }>;
  label: string;
  /** Other params that stop making sense when the tab changes. */
  clear?: string[];
};

function TabStrip({
  value,
  options,
  label,
  onSelect,
}: Pick<ParamTabsProps, "value" | "options" | "label"> & {
  onSelect?: (value: string) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onSelect?.(option.value)}
          className={cn(
            "shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors",
            value === option.value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
          {option.count !== undefined && <span className="ms-1 text-muted-foreground tabular-nums">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Pill tabs driven by a search param, as on the transactions page. */
export function ParamTabs(props: ParamTabsProps) {
  return (
    <Suspense fallback={<TabStrip value={props.value} options={props.options} label={props.label} />}>
      <LiveParamTabs {...props} />
    </Suspense>
  );
}

function LiveParamTabs({ param, value, options, label, clear = [] }: ParamTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const select = (next: string) => {
    const query = new URLSearchParams(params.toString());
    if (next === options[0]?.value) query.delete(param);
    else query.set(param, next);
    query.delete("focus");
    for (const key of clear) query.delete(key);
    router.push(`${pathname}${query.size ? `?${query}` : ""}`, {
      scroll: false,
    });
  };
  return <TabStrip value={value} options={options} label={label} onSelect={select} />;
}

/** "Delete this?" — a stop sign in the middle of the screen. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  destructive?: boolean;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children && <div className="px-6 pb-2">{children}</div>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>Cancel</AlertDialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const txLabel = (tx: LinkedTx) => {
  if (tx.metadata?.interest === true) return "Interest";
  if (tx.type === "investment") return tx.direction === "out" ? "Contribution" : "Withdrawal";
  if (tx.type === "loan") return tx.direction === "in" ? "Borrowed" : "Lent";
  if (tx.type === "debt_payment") return tx.direction === "out" ? "Payment" : "Repayment received";
  if (tx.type === "adjustment" && tx.metadata?.assetSale === true) return "Sale proceeds";
  return TYPE_LABELS[tx.type];
};

/** The money that moved through a holding, debt or receivable. */
export function LinkedTransactions({ items, empty }: { items: LinkedTx[]; empty: ReactNode }) {
  const { money } = useApp();
  if (!items.length) return <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th className="w-28">Date</th>
              <th>What</th>
              <th className="hidden md:table-cell">Account</th>
              <th className="text-right!">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((tx) => (
              <tr key={tx.id} className="[&>td]:px-3 [&>td]:py-2">
                <td className="text-xs text-muted-foreground tabular-nums">{formatDay(tx.date)}</td>
                <td className="min-w-0">
                  <Link
                    href={`/transactions?period=all_time&ids=${tx.id}&status=${tx.status}`}
                    className="flex items-center gap-2 hover:underline underline-offset-4"
                  >
                    <span className="truncate">{tx.description ?? txLabel(tx)}</span>
                    {tx.status !== "posted" && <StatusBadge status={tx.status} />}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {txLabel(tx)}
                    {tx.costBasis !== null && tx.costBasis !== undefined ? ` · cost basis ${money(tx.costBasis, tx.currency)}` : ""}
                  </span>
                </td>
                <td className="hidden text-xs text-muted-foreground md:table-cell">{tx.accountName ?? "—"}</td>
                <td className={cn("text-right tabular-nums", tx.direction === "in" && "text-money-in")}>
                  {money(tx.direction === "in" ? tx.amount : -tx.amount, tx.currency, { signed: tx.direction === "in" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link
        href={`/transactions?period=all_time&ids=${items.map((t) => t.id).join(",")}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Open these in Transactions <ArrowUpRight className="size-3" />
      </Link>
    </div>
  );
}
