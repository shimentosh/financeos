import type { Drill } from "@/lib/api/types/business";

const TARGETS: Record<Drill["target"], string> = {
  transactions: "/transactions",
  receivables: "/wealth/receivables",
  payables: "/wealth/liabilities",
  commitments: "/commitments",
};

/**
 * The page and filters behind a figure. Arrays join with commas, as the
 * transactions page reads them; a figure with no date bound opens all time
 * (the page would otherwise default to this month).
 */
export function drillHref(drill: Drill): string {
  const params = new URLSearchParams();
  if (drill.target === "payables") params.set("view", "payables");
  for (const [key, value] of Object.entries(drill.query)) {
    const text = Array.isArray(value) ? value.join(",") : value;
    if (text) params.set(key, text);
  }
  if (drill.target === "transactions" && !params.has("from") && !params.has("to")) params.set("period", "all_time");
  const query = params.toString();
  return `${TARGETS[drill.target]}${query ? `?${query}` : ""}`;
}

/** A cost-group drill: the transactions list takes one category, so link the first when there is one. */
export function groupDrillHref(drill: Drill, categoryIds: string[]): string {
  if (categoryIds.length === 1 && categoryIds[0])
    return drillHref({
      ...drill,
      query: { ...drill.query, categoryId: categoryIds[0] },
    });
  return drillHref(drill);
}
