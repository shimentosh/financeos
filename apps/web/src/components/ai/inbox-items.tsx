"use client";

import { COMMON_CURRENCIES, formatDay, type InboxKind, minorToInput, parseMoneyInput } from "@financeos/core";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  BellOff,
  Camera,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  type LucideIcon,
  PlugZap,
  Repeat,
  RotateCcw,
  TrendingUp,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { TONE, type Tone } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Account, Category, TransactionPage } from "@/lib/api/types";
import type { BillingCycle, DuplicateResolution, InboxItemView, TrackResult } from "@/lib/api/types/ai";
import { cn } from "@/lib/cn";
import { timeAgo, titleFromKind } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";
import { transactionsHref } from "./shared";

/** How inbox kinds are grouped on the page, in order of urgency. */
export const KIND_GROUPS: Array<{ id: string; title: string; hint: string; kinds: InboxKind[] }> = [
  { id: "duplicates", title: "Possible duplicates", hint: "The same money recorded twice? Keep one, or both if they are two payments.", kinds: ["duplicate"] },
  { id: "integrations", title: "Integration problems", hint: "A connection needs attention before it can sync again.", kinds: ["integration_error"] },
  {
    id: "anomalies",
    title: "Unusual activity",
    hint: "Spending well above its own pattern, with the transactions behind it.",
    kinds: ["anomaly", "large_transaction"],
  },
  {
    id: "recurring",
    title: "Recurring charges and subscriptions",
    hint: "Track them to get reminded before they renew.",
    kinds: ["recurring_candidate", "subscription_candidate"],
  },
  {
    id: "warnings",
    title: "Warnings",
    hint: "Budgets, renewals, price changes and money owed to you.",
    kinds: ["budget_warning", "forecast_warning", "price_change", "renewal", "receivable_overdue"],
  },
  { id: "observations", title: "Observations", hint: "Worth knowing; nothing to do.", kinds: ["observation"] },
];

const SEVERITY: Record<InboxItemView["severity"], { tone: Tone; icon: LucideIcon }> = {
  critical: { tone: "danger", icon: AlertOctagon },
  warning: { tone: "warn", icon: AlertTriangle },
  info: { tone: "info", icon: Info },
  success: { tone: "good", icon: CheckCircle2 },
};

const KIND_ICON: Partial<Record<InboxKind, LucideIcon>> = {
  duplicate: Copy,
  recurring_candidate: Repeat,
  subscription_candidate: Repeat,
  anomaly: TrendingUp,
  large_transaction: TrendingUp,
  integration_error: PlugZap,
};

const CADENCE_LABELS: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Every 6 months",
  yearly: "Yearly",
  custom: "Custom",
};

type Data = InboxItemView["data"] & {
  expected?: number;
  actual?: number;
  percentChange?: number;
  currency?: string;
  amount?: number;
  cadence?: string;
  nextExpected?: string | null;
  occurrences?: number;
  merchant?: string;
  captureId?: string;
  reasons?: string[];
  score?: number;
  metric?: string;
  subscription?: {
    provider?: string;
    planName?: string | null;
    billingCycle?: string | null;
    nextRenewalDate?: string | null;
    renewalAmount?: number | null;
    currency?: string | null;
    autoRenew?: boolean | null;
  };
};

function useAct(item: InboxItemView) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: "resolve" | "dismiss" | "snooze" | "reopen", snoozeDays?: number) => {
    setBusy(action);
    try {
      await clientApi(`/inbox/${item.id}/action`, { method: "POST", body: { action, ...(snoozeDays ? { snoozeDays } : {}) } });
      toast.success(
        action === "snooze"
          ? `Snoozed for ${snoozeDays} day${snoozeDays === 1 ? "" : "s"}`
          : action === "reopen"
            ? "Reopened"
            : action === "resolve"
              ? "Marked as done"
              : "Dismissed",
      );
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  return { act, busy };
}

/** One inbox item: what was found, the evidence, and what can be done about it. */
export function InboxItemCard({ item, categories }: { item: InboxItemView; categories: Category[] }) {
  const { money, canWrite } = useApp();
  const { act, busy } = useAct(item);
  const [tracking, setTracking] = useState<"subscription" | "commitment" | null>(null);
  const data = item.data as Data;
  const severity = SEVERITY[item.severity];
  const Icon = KIND_ICON[item.kind] ?? severity.icon;
  const has = (action: InboxItemView["actions"][number]) => item.actions.includes(action);
  const href =
    typeof data.href === "string" && data.href.startsWith("/transactions")
      ? data.href
      : data.transactionIds?.length
        ? transactionsHref(data.transactionIds)
        : null;
  const captureHref = typeof data.captureId === "string" ? `/capture/${data.captureId}?from=inbox` : null;
  const otherHref = typeof data.href === "string" && !data.href.startsWith("/transactions") && !data.href.startsWith("/capture") ? data.href : null;
  const closed = item.status === "resolved" || item.status === "dismissed";

  return (
    <li className={cn("rounded-xl border border-border bg-card", closed && "opacity-75")}>
      <div className="flex gap-3 p-4">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE[severity.tone])}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.title}</p>
              {item.body && <p className="text-sm text-muted-foreground">{item.body}</p>}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {titleFromKind(item.kind)} · {timeAgo(item.createdAt)}
              {item.status === "snoozed" &&
                item.snoozedUntil &&
                ` · snoozed until ${new Date(item.snoozedUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
            </span>
          </div>

          {(item.kind === "anomaly" || item.kind === "large_transaction") && typeof data.actual === "number" && typeof data.expected === "number" && (
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">Usually</dt>
                <dd className="tabular-nums">{money(data.expected, data.currency)}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">This time</dt>
                <dd className="font-medium tabular-nums">{money(data.actual, data.currency)}</dd>
              </div>
              {typeof data.percentChange === "number" && (
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Change</dt>
                  <dd
                    className={cn(
                      "font-medium tabular-nums",
                      data.percentChange > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {data.percentChange > 0 ? "+" : ""}
                    {data.percentChange}%
                  </dd>
                </div>
              )}
              {data.transactionIds?.length ? <span className="text-muted-foreground">{data.transactionIds.length} transactions behind it</span> : null}
            </dl>
          )}

          {(item.kind === "recurring_candidate" || item.kind === "subscription_candidate") && (
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {data.cadence && <span>{CADENCE_LABELS[data.cadence] ?? data.cadence}</span>}
              {typeof data.amount === "number" && data.currency && <span className="tabular-nums">about {money(data.amount, data.currency)}</span>}
              {typeof data.occurrences === "number" && <span>{data.occurrences} payments seen</span>}
              {data.nextExpected && <span>next around {formatDay(data.nextExpected)} (estimate)</span>}
            </p>
          )}

          {item.kind === "duplicate" && (data.transactionIds?.length ?? 0) >= 2 && !closed && <DuplicateCompare item={item} canWrite={canWrite} />}

          {item.kind === "duplicate" && closed && typeof data.resolution === "string" && (
            <p className="text-xs text-muted-foreground">
              {data.resolution === "both" ? "Kept both." : `Kept the ${data.resolution} one; the other was voided.`}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {canWrite && has("track_subscription") && (
              <Button size="xs" onClick={() => setTracking("subscription")}>
                <Repeat className="size-3" /> Track as subscription
              </Button>
            )}
            {canWrite && has("track_commitment") && (
              <Button size="xs" variant="outline" onClick={() => setTracking("commitment")}>
                Track as commitment
              </Button>
            )}
            {captureHref && (
              <Button size="xs" variant="outline" render={<Link href={captureHref} />}>
                <Camera className="size-3" /> Review capture
              </Button>
            )}
            {href && (
              <Button size="xs" variant="outline" render={<Link href={href} />}>
                View transactions <ArrowRight className="size-3" />
              </Button>
            )}
            {otherHref && (
              <Button size="xs" variant="outline" render={<Link href={otherHref} />}>
                Open <ExternalLink className="size-3" />
              </Button>
            )}
            <span className="flex-1" />
            {canWrite && has("resolve") && (
              <Button size="xs" variant="ghost" loading={busy === "resolve"} onClick={() => void act("resolve")}>
                <Check className="size-3" /> Done
              </Button>
            )}
            {canWrite && has("snooze") && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="xs" variant="ghost" loading={busy === "snooze"} />}>
                  <BellOff className="size-3" /> Snooze
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {[1, 7, 30].map((days) => (
                    <DropdownMenuItem key={days} onClick={() => void act("snooze", days)}>
                      {days === 1 ? "Until tomorrow" : `For ${days} days`}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canWrite && has("dismiss") && (
              <Button size="xs" variant="ghost" loading={busy === "dismiss"} onClick={() => void act("dismiss")}>
                <X className="size-3" /> Dismiss
              </Button>
            )}
            {canWrite && has("reopen") && (
              <Button size="xs" variant="ghost" loading={busy === "reopen"} onClick={() => void act("reopen")}>
                <RotateCcw className="size-3" /> Reopen
              </Button>
            )}
          </div>
        </div>
      </div>
      {tracking && <TrackDialog item={item} kind={tracking} categories={categories} onClose={() => setTracking(null)} />}
    </li>
  );
}

/** The two transactions side by side, and the three ways to settle it. */
function DuplicateCompare({ item, canWrite }: { item: InboxItemView; canWrite: boolean }) {
  const router = useRouter();
  const { money } = useApp();
  const ids = (item.data.transactionIds ?? []).slice(0, 2);
  const { data, loading } = useApi<TransactionPage>("/transactions", { ids: ids.join(","), status: "draft,pending,posted,void", pageSize: 2 });
  const [busy, setBusy] = useState<string | null>(null);
  const rows = ids.map((id) => data?.items.find((t) => t.id === id) ?? null);

  const keep = async (keepWhich: "both" | "first" | "second") => {
    setBusy(keepWhich);
    try {
      const result = await clientApi<DuplicateResolution>(`/inbox/${item.id}/duplicate`, { method: "POST", body: { keep: keepWhich } });
      toast.success(result.voidedTransactionId ? "Duplicate removed" : "Kept both");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((tx, index) =>
          tx ? (
            <div key={tx.id} className="space-y-1 rounded-lg border border-border bg-background p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-muted-foreground">{index === 0 ? "First" : "Second"}</span>
                <span className={cn("text-sm font-semibold tabular-nums", tx.direction === "in" && "text-money-in")}>{money(tx.amount, tx.currency)}</span>
              </div>
              <p className="truncate text-sm">{tx.counterpartyName ?? tx.merchant ?? tx.description ?? "—"}</p>
              <p className="text-muted-foreground">
                {formatDay(tx.date)} · {tx.accountName ?? "no account"} · {titleFromKind(tx.source)}
              </p>
              {tx.reference && <p className="font-mono text-muted-foreground">{tx.reference}</p>}
              <Link
                href={transactionsHref([tx.id])}
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Open <ExternalLink className="size-3" />
              </Link>
            </div>
          ) : (
            <Skeleton key={ids[index] ?? index} className={cn("h-28 rounded-lg", !loading && "animate-none")} />
          ),
        )}
      </div>
      {typeof item.data.score === "number" && Array.isArray(item.data.reasons) && (
        <p className="text-xs text-muted-foreground">
          {(item.data.reasons as string[]).join(", ")} · {Math.round((item.data.score as number) * 100)}% alike
        </p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" loading={busy === "first"} disabled={busy !== null} onClick={() => void keep("first")}>
            Keep first
          </Button>
          <Button size="xs" variant="outline" loading={busy === "second"} disabled={busy !== null} onClick={() => void keep("second")}>
            Keep second
          </Button>
          <Button size="xs" variant="ghost" loading={busy === "both"} disabled={busy !== null} onClick={() => void keep("both")}>
            Keep both, they're different
          </Button>
        </div>
      )}
    </div>
  );
}

const CYCLES: Array<{ value: BillingCycle; label: string }> = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "half_yearly", label: "Every 6 months" },
  { value: "yearly", label: "Yearly" },
];

/** Turns a recurring or subscription candidate into tracking, prefilled from what was detected. */
function TrackDialog({
  item,
  kind,
  categories,
  onClose,
}: {
  item: InboxItemView;
  kind: "subscription" | "commitment";
  categories: Category[];
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const { workspace } = useApp();
  const data = item.data as Data;
  const suggestion = data.subscription;
  const accounts = useApi<Account[]>("/accounts");
  const currency0 = suggestion?.currency ?? data.currency ?? workspace.baseCurrency;
  const amount0 = suggestion?.renewalAmount ?? data.amount ?? null;
  const cycle0 = (suggestion?.billingCycle ?? data.cadence ?? "") as string;
  const [name, setName] = useState(suggestion?.provider ?? data.merchant ?? "");
  const [amount, setAmount] = useState(amount0 ? minorToInput(amount0, currency0) : "");
  const [currency, setCurrency] = useState(currency0);
  const [cycle, setCycle] = useState<BillingCycle | "">(CYCLES.some((c) => c.value === cycle0) ? (cycle0 as BillingCycle) : "");
  const [nextDate, setNextDate] = useState(suggestion?.nextRenewalDate ?? data.nextExpected ?? "");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [autoRenew, setAutoRenew] = useState(suggestion?.autoRenew ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const expenseCategories = categories.filter((c) => c.kind === "expense" && !c.archived);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const minor = amount.trim() ? parseMoneyInput(amount, currency) : null;
    if (amount.trim() && !minor) return setError(`Enter the amount in ${currency}`);
    if (!nextDate) return setError("Enter when it's next due");
    setSaving(true);
    setError(null);
    try {
      const result = await clientApi<TrackResult>(`/inbox/${item.id}/track`, {
        method: "POST",
        body: {
          kind,
          name: name.trim() || undefined,
          ...(minor ? { amount: minor, currency } : {}),
          ...(cycle ? { billingCycle: cycle } : {}),
          nextRenewalDate: nextDate,
          accountId: accountId || undefined,
          categoryId: categoryId || undefined,
          ...(kind === "subscription" ? { autoRenew } : {}),
        },
      });
      const target = result.subscriptionId ? `/subscriptions/${result.subscriptionId}` : `/commitments?focus=${result.commitmentId}`;
      toast.success(kind === "subscription" ? "Subscription tracked" : "Commitment tracked", {
        description: result.purchaseTransactionId ? "The latest charge is linked as its first payment." : undefined,
        action: { label: "Open", onClick: () => router.push(target) },
      });
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{kind === "subscription" ? "Track as a subscription" : "Track as a commitment"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {kind === "subscription"
                ? "You'll be reminded before each renewal, and the charges already paid are linked, not recorded again."
                : "A scheduled payment on your calendar and in the cash forecast."}
            </p>
            <div className="space-y-1">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-amount`}>Amount each time</Label>
                <Input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="tabular-nums"
                  placeholder="As detected"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-currency`}>Currency</Label>
                <Select value={currency} onValueChange={(v) => typeof v === "string" && setCurrency(v)}>
                  <SelectTrigger id={`${id}-currency`} className="min-w-0">
                    <SelectValue>{currency}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([currency, ...COMMON_CURRENCIES])].map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-cycle`}>How often</Label>
                <Select value={cycle || null} onValueChange={(v) => typeof v === "string" && setCycle(v as BillingCycle)}>
                  <SelectTrigger id={`${id}-cycle`}>
                    <SelectValue>
                      {CYCLES.find((c) => c.value === cycle)?.label ?? (data.cadence ? `${CADENCE_LABELS[data.cadence] ?? data.cadence} (detected)` : "Choose")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CYCLES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-next`}>Next due</Label>
                <Input id={`${id}-next`} type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-account`}>Paid from</Label>
                <Select value={accountId || null} onValueChange={(v) => typeof v === "string" && setAccountId(v)}>
                  <SelectTrigger id={`${id}-account`}>
                    <SelectValue>{accounts.data?.find((a) => a.id === accountId)?.name ?? "Same as the last charge"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(accounts.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} · {a.currency}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-category`}>Category</Label>
                <Select value={categoryId || null} onValueChange={(v) => typeof v === "string" && setCategoryId(v)}>
                  <SelectTrigger id={`${id}-category`}>
                    <SelectValue>{expenseCategories.find((c) => c.id === categoryId)?.name ?? "Same as the last charge"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {expenseCategories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {kind === "subscription" && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <Label htmlFor={`${id}-auto`} className="font-normal">
                  Renews automatically
                </Label>
                <Switch id={`${id}-auto`} checked={autoRenew} onCheckedChange={setAutoRenew} />
              </div>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              Track it
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
