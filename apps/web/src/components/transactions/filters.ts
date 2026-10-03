import { type Day, type PeriodPreset, presetRange } from "@financeos/core";

export const PERIODS: Array<{ value: PeriodPreset; label: string }> = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "this_quarter", label: "This quarter" },
  { value: "this_year", label: "This year" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "all_time", label: "All time" },
];

export type TypeTab = "all" | "expense" | "income" | "transfer" | "other";

export const TYPE_TABS: Array<{ value: TypeTab; label: string; types?: string[] }> = [
  { value: "all", label: "All" },
  { value: "expense", label: "Expenses", types: ["expense", "refund"] },
  { value: "income", label: "Income", types: ["income"] },
  { value: "transfer", label: "Transfers", types: ["transfer"] },
  { value: "other", label: "Other", types: ["adjustment", "investment", "asset_purchase", "debt_payment", "loan", "equity"] },
];

export type TransactionFilters = {
  period: PeriodPreset | "custom";
  from?: string;
  to?: string;
  tab: TypeTab;
  q?: string;
  accountId?: string;
  categoryId?: string;
  projectId?: string;
  counterpartyId?: string;
  commitmentId?: string;
  status?: string;
  source?: string;
  ids?: string;
  page: number;
  sort?: string;
};

/** Reads filters from the URL. Drill-down links pass explicit from/to. */
export function readFilters(params: Record<string, string>, defaults: Partial<TransactionFilters> = {}): TransactionFilters {
  const hasRange = Boolean(params.from || params.to);
  return {
    period: hasRange ? "custom" : ((params.period as PeriodPreset) ?? defaults.period ?? "this_month"),
    from: params.from,
    to: params.to,
    tab: (params.tab as TypeTab) ?? (params.type ? typeTabFor(params.type) : (defaults.tab ?? "all")),
    q: params.q,
    accountId: params.accountId,
    categoryId: params.categoryId,
    projectId: params.projectId,
    counterpartyId: params.counterpartyId,
    commitmentId: params.commitmentId,
    status: params.status,
    source: params.source,
    ids: params.ids,
    page: Math.max(1, Number(params.page ?? 1) || 1),
    sort: params.sort,
  };
}

function typeTabFor(type: string): TypeTab {
  const first = type.split(",")[0] ?? "";
  return TYPE_TABS.find((tab) => tab.types?.includes(first))?.value ?? "all";
}

export function rangeFor(filters: TransactionFilters, today: Day, fiscalStartMonth: number) {
  if (filters.period === "custom") return { from: filters.from, to: filters.to };
  if (filters.period === "all_time") return { from: undefined, to: undefined };
  return presetRange(filters.period, today, fiscalStartMonth);
}

export function apiQuery(filters: TransactionFilters, range: { from?: string; to?: string }, explicitTypes?: string) {
  const tab = TYPE_TABS.find((t) => t.value === filters.tab);
  return {
    from: range.from,
    to: range.to,
    type: explicitTypes ?? tab?.types?.join(","),
    q: filters.q,
    accountId: filters.accountId,
    categoryId: filters.categoryId,
    projectId: filters.projectId,
    counterpartyId: filters.counterpartyId,
    commitmentId: filters.commitmentId,
    status: filters.status,
    source: filters.source,
    ids: filters.ids,
    page: filters.page,
    pageSize: 50,
    sort: filters.sort,
  };
}
