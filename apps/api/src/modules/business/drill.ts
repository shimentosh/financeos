import type { TransactionType } from "@financeos/core";
import { type Day, endOfMonth, type PeriodPreset, presetRange, startOfMonth } from "@financeos/core";
import { todayFor, type WorkspaceContext } from "../../common/context.js";

/**
 * Where a number comes from: the list and filters that show the records
 * behind it. For `transactions` the query is a valid `GET /transactions`
 * query (arrays are repeated or comma-separated params); `status: ["posted"]`
 * makes the list's totals match the figure.
 */
export type Drill = {
  target: "transactions" | "receivables" | "payables" | "commitments";
  query: Record<string, string | string[]>;
};

/** A money figure (base currency, minor units) with its drill-down. */
export type Figure = { amount: number; drill: Drill };

export type ResolvedRange = { from: Day | null; to: Day };

export function txDrill(
  range: { from?: Day | null; to?: Day | null },
  types: TransactionType[],
  extra: { projectId?: string | null; categoryId?: string | null; counterpartyId?: string | null; source?: string | null } = {},
): Drill {
  const query: Record<string, string | string[]> = { status: ["posted"], type: types };
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  if (extra.projectId !== undefined) query.projectId = extra.projectId ?? "none";
  if (extra.categoryId !== undefined) query.categoryId = extra.categoryId ?? "none";
  if (extra.counterpartyId) query.counterpartyId = extra.counterpartyId;
  if (extra.source) query.source = [extra.source];
  return { target: "transactions", query };
}

export const figure = (amount: number, drill: Drill): Figure => ({ amount, drill });

/**
 * A reporting range from a query: a preset, explicit dates, or the default
 * (`lifetime`: open start, ends today; `last_12_months`: the 12 calendar
 * months ending with this one).
 */
export function resolveRange(
  ctx: WorkspaceContext,
  query: { from?: Day; to?: Day; preset?: PeriodPreset },
  fallback: "lifetime" | "last_12_months",
): ResolvedRange {
  const day = todayFor(ctx);
  if (query.preset) {
    if (query.preset === "all_time") return { from: null, to: day };
    const range = presetRange(query.preset, day, ctx.fiscalYearStartMonth);
    return { from: range.from, to: range.to };
  }
  if (query.from || query.to) return { from: query.from ?? null, to: query.to ?? day };
  if (fallback === "lifetime") return { from: null, to: day };
  const range = presetRange("last_12_months", day, ctx.fiscalYearStartMonth);
  return { from: startOfMonth(range.from), to: endOfMonth(range.to) };
}
