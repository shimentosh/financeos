"use client";

import { monthKey, TYPE_LABELS } from "@expensewise/core";
import { ArrowLeftRight, ChevronLeft, ChevronRight, Paperclip, Plus, Search, Sparkles, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryChip, ConfidenceMeter, EmptyState, StatusBadge } from "@/components/app/blocks";
import { openAddTransaction } from "@/components/app/global-actions";
import { TransactionDetailDrawer } from "@/components/transactions/transaction-detail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Account, Category, Project, TransactionListItem, TransactionPage } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import { formatMonth } from "@/lib/format-client";
import { PERIODS, type TransactionFilters, TYPE_TABS } from "./filters";

const ALL = "__all__";

export type TransactionsViewProps = {
  page: TransactionPage;
  filters: TransactionFilters;
  range: { from?: string; to?: string };
  accounts: Account[];
  categories: Category[];
  projects: Project[];
  /** Hide the type tabs on preset pages (Income, Expenses, Transfers). */
  lockedTab?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "in" | "out" }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className={cn("truncate text-lg font-semibold tabular-nums", tone === "in" && "text-money-in")}>{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export function TransactionsView({ page, filters, range, accounts, categories, projects, lockedTab, emptyTitle, emptyDescription }: TransactionsViewProps) {
  const { money, isBusiness, locale, canWrite } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(filters.q ?? "");
  // ?open=<id> (from a copilot card or a link) opens that transaction's details.
  const [selected, setSelected] = useState<string | null>(() => searchParams.get("open"));

  useEffect(() => setQuery(filters.q ?? ""), [filters.q]);

  const update = (changes: Record<string, string | null | undefined>, resetPage = true) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "" || value === ALL) params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.delete("page");
    startTransition(() => router.push(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false }));
  };

  // Debounced search.
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounce on query only
  useEffect(() => {
    if ((filters.q ?? "") === query) return;
    const timer = setTimeout(() => update({ q: query.trim() || null }), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const net = page.totals.income - page.totals.expense;
  const activeChips: Array<{ key: string; label: string }> = [
    filters.accountId ? { key: "accountId", label: `Account: ${accounts.find((a) => a.id === filters.accountId)?.name ?? "…"}` } : null,
    filters.categoryId
      ? { key: "categoryId", label: filters.categoryId === "none" ? "Uncategorized" : `Category: ${categoryName(filters.categoryId) ?? "…"}` }
      : null,
    filters.projectId
      ? { key: "projectId", label: filters.projectId === "none" ? "No project" : `Project: ${projects.find((p) => p.id === filters.projectId)?.name ?? "…"}` }
      : null,
    filters.status ? { key: "status", label: `Status: ${filters.status}` } : null,
    filters.source ? { key: "source", label: `Source: ${filters.source}` } : null,
    filters.counterpartyId ? { key: "counterpartyId", label: "Merchant filter" } : null,
    filters.commitmentId ? { key: "commitmentId", label: "Commitment payments" } : null,
    filters.ids ? { key: "ids", label: `${filters.ids.split(",").length} selected records` } : null,
  ].filter((chip): chip is { key: string; label: string } => chip !== null);

  const periodLabel =
    filters.period === "custom"
      ? `${range.from ? formatDay(range.from) : "…"} – ${range.to ? formatDay(range.to) : "…"}`
      : (PERIODS.find((p) => p.value === filters.period)?.label ?? "This month");

  return (
    <div className={cn("space-y-4 transition-opacity", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.period} onValueChange={(value) => typeof value === "string" && update({ period: value, from: null, to: null })}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue>{periodLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
            {filters.period === "custom" && <SelectItem value="custom">{periodLabel}</SelectItem>}
          </SelectContent>
        </Select>
        <Select value={filters.accountId ?? ALL} onValueChange={(value) => typeof value === "string" && update({ accountId: value })}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue>{filters.accountId ? (accounts.find((a) => a.id === filters.accountId)?.name ?? "Account") : "All accounts"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All accounts</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.categoryId ?? ALL} onValueChange={(value) => typeof value === "string" && update({ categoryId: value })}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue>
              {filters.categoryId ? (filters.categoryId === "none" ? "Uncategorized" : (categoryName(filters.categoryId) ?? "Category")) : "All categories"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            <SelectItem value="none">Uncategorized</SelectItem>
            {categories
              .filter((c) => !c.archived)
              .map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className={cn(c.parentId && "ps-3 text-muted-foreground")}>{c.name}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {isBusiness && (
          <Select value={filters.projectId ?? ALL} onValueChange={(value) => typeof value === "string" && update({ projectId: value })}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue>
                {filters.projectId
                  ? filters.projectId === "none"
                    ? "No project"
                    : (projects.find((p) => p.id === filters.projectId)?.name ?? "Project")
                  : "All projects"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              <SelectItem value="none">No project</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {canWrite && (
          <Button
            size="sm"
            className="ms-auto gap-1"
            onClick={() => openAddTransaction(filters.tab === "income" ? "income" : filters.tab === "transfer" ? "transfer" : "expense")}
          >
            <Plus className="size-3.5" />
            Add transaction
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 divide-border rounded-lg border border-border sm:grid-cols-4 sm:divide-x">
        <Stat label="Income" value={money(page.totals.income)} tone={page.totals.income > 0 ? "in" : undefined} />
        <Stat label="Spending" value={money(page.totals.expense)} />
        <Stat label="Net" value={money(net, undefined, { signed: true })} tone={net > 0 ? "in" : undefined} />
        <Stat label="Transactions" value={page.total.toLocaleString(locale)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!lockedTab && (
          <div role="tablist" aria-label="Type" className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 p-1">
            {TYPE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={filters.tab === tab.value}
                onClick={() => update({ tab: tab.value === "all" ? null : tab.value, type: null })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  filters.tab === tab.value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        {activeChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => update({ [chip.key]: null })}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-accent"
          >
            {chip.label}
            <X className="size-3" />
          </button>
        ))}
        <div className="relative ms-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search merchant, note, TrxID…"
            aria-label="Search transactions"
            className="pl-7"
          />
        </div>
      </div>

      {page.items.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title={emptyTitle ?? (filters.q || activeChips.length ? "Nothing matches these filters" : "No transactions in this period")}
          description={
            emptyDescription ??
            (filters.q || activeChips.length
              ? "Try another period or clear a filter."
              : "Add one by hand, scan a bKash or bank screenshot, or connect an app to import them.")
          }
          action={
            canWrite ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => openAddTransaction("expense")}>
                  <Plus className="size-3.5" /> Add transaction
                </Button>
                <Button size="sm" variant="outline" onClick={() => router.push("/capture?mode=screenshot")}>
                  <Sparkles className="size-3.5" /> Scan a screenshot
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm md:min-w-[860px]">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th className="hidden w-28 md:table-cell">Date</th>
                <th>Description</th>
                <th className="hidden w-40 md:table-cell">Account</th>
                {isBusiness && <th className="hidden w-36 lg:table-cell">Project</th>}
                <th className="w-36 text-right!">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {page.items.map((tx) => (
                <Row key={tx.id} tx={tx} isBusiness={isBusiness} onOpen={() => setSelected(tx.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">
            {(page.page - 1) * page.pageSize + 1}–{Math.min(page.total, page.page * page.pageSize)} of {page.total.toLocaleString(locale)}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="xs" disabled={page.page <= 1} onClick={() => update({ page: String(page.page - 1) }, false)}>
              <ChevronLeft className="size-3.5" /> Previous
            </Button>
            <Button variant="outline" size="xs" disabled={page.page >= pages} onClick={() => update({ page: String(page.page + 1) }, false)}>
              Next <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <TransactionDetailDrawer
        id={selected}
        onClose={() => {
          setSelected(null);
          if (searchParams.has("open")) update({ open: null }, false);
        }}
      />
    </div>
  );
}

function Row({ tx, isBusiness, onOpen }: { tx: TransactionListItem; isBusiness: boolean; onOpen: () => void }) {
  const { money } = useApp();
  const incoming = tx.type !== "transfer" && tx.direction === "in";
  const title =
    tx.type === "transfer"
      ? `${tx.accountName ?? "?"} → ${tx.toAccountName ?? "?"}`
      : (tx.counterpartyName ?? tx.merchant ?? tx.description ?? TYPE_LABELS[tx.type]);
  const secondary = tx.type === "transfer" ? tx.description : tx.counterpartyName || tx.merchant ? tx.description : null;
  const foreign = tx.baseCurrency && tx.currency !== tx.baseCurrency;
  // Income is entered per profit month, so it shows the month and year, not a day.
  const when = tx.type === "income" ? formatMonth(monthKey(tx.date), "en-GB", true) : formatDay(tx.date);

  return (
    <tr onClick={onOpen} className="cursor-pointer transition-colors hover:bg-accent/40 [&>td]:px-3 [&>td]:py-2">
      <td className="hidden text-xs tabular-nums text-muted-foreground md:table-cell">{when}</td>
      <td className="max-w-0">
        <p className="text-xs tabular-nums text-muted-foreground md:hidden">
          {when} · {tx.accountName}
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          {tx.categoryName ? (
            <CategoryChip name={tx.categoryName} icon={tx.categoryIcon} />
          ) : ["expense", "income"].includes(tx.type) && tx.status === "posted" ? (
            <span className="shrink-0 rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">Uncategorized</span>
          ) : (
            tx.type !== "expense" &&
            tx.type !== "income" && <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{TYPE_LABELS[tx.type]}</span>
          )}
          {tx.status !== "posted" && <StatusBadge status={tx.status} label={tx.status === "draft" ? "Needs review" : undefined} />}
          {tx.attachmentFileId && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />}
          {tx.aiConfidence && tx.status !== "posted" && <ConfidenceMeter value={tx.aiConfidence.overall} className="hidden sm:inline-flex" />}
        </div>
        {secondary && <p className="truncate text-xs text-muted-foreground">{secondary}</p>}
      </td>
      <td className="hidden max-w-0 truncate text-xs text-muted-foreground md:table-cell">{tx.type === "transfer" ? "Transfer" : tx.accountName}</td>
      {isBusiness && <td className="hidden max-w-0 truncate text-xs text-muted-foreground lg:table-cell">{tx.projectName ?? "—"}</td>}
      <td className="text-right">
        <div className={cn("font-medium tabular-nums", incoming && "text-money-in")}>
          {tx.type === "transfer" ? money(tx.amount, tx.currency) : money(incoming ? tx.amount : -tx.amount, tx.currency, { signed: incoming })}
        </div>
        {foreign && tx.baseAmount !== null && (
          <div className="text-[11px] text-muted-foreground tabular-nums">≈ {money(tx.baseAmount, tx.baseCurrency ?? undefined)}</div>
        )}
      </td>
    </tr>
  );
}
