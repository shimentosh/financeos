import type { BudgetPeriod } from "../constants.ts";
import {
  addDays,
  addMonths,
  type Day,
  diffDays,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  type Range,
  startOfMonth,
  startOfQuarter,
  startOfYear,
} from "../dates.ts";

/** The budget period containing `day`. */
export function budgetPeriodRange(period: BudgetPeriod, day: Day, budget: { startDate: Day; endDate?: Day | null }, fiscalStartMonth = 1): Range {
  switch (period) {
    case "monthly":
      return { from: startOfMonth(day), to: endOfMonth(day) };
    case "quarterly":
      return { from: startOfQuarter(day), to: endOfQuarter(day) };
    case "yearly":
      return { from: startOfYear(day, fiscalStartMonth), to: endOfYear(day, fiscalStartMonth) };
    case "total":
      return { from: budget.startDate, to: budget.endDate ?? "2999-12-31" };
  }
}

export type BudgetStatus = "on_track" | "warning" | "over" | "under";

export type BudgetMetrics = {
  budget: number;
  actual: number;
  remaining: number;
  /** Budget − actual: positive is under budget. */
  variance: number;
  utilization: number;
  status: BudgetStatus;
  /** Spending pace projected to the period end, when the period is running. */
  projected: number | null;
  daysLeft: number;
};

export function budgetMetrics(budget: number, actual: number, range: Range, today: Day, alertThreshold = 80): BudgetMetrics {
  const utilization = budget > 0 ? Math.round((actual / budget) * 1000) / 10 : actual > 0 ? 100 : 0;
  const status: BudgetStatus = actual > budget ? "over" : utilization >= alertThreshold ? "warning" : "on_track";
  const running = today >= range.from && today <= range.to && range.to !== "2999-12-31";
  const elapsed = running ? diffDays(range.from, today) + 1 : 0;
  const length = diffDays(range.from, range.to) + 1;
  const projected = running && elapsed > 0 ? Math.round((actual / elapsed) * length) : null;
  return {
    budget,
    actual,
    remaining: budget - actual,
    variance: budget - actual,
    utilization,
    status,
    projected,
    daysLeft: running ? Math.max(0, diffDays(today, range.to)) : 0,
  };
}

/** The ranges of the last `count` periods ending with the one containing `day`. */
export function recentPeriods(period: Exclude<BudgetPeriod, "total">, day: Day, count: number, fiscalStartMonth = 1): Range[] {
  const ranges: Range[] = [];
  let cursor = day;
  for (let i = 0; i < count; i++) {
    const range = budgetPeriodRange(period, cursor, { startDate: day }, fiscalStartMonth);
    ranges.unshift(range);
    cursor = addDays(range.from, -1);
  }
  return ranges;
}

export function monthsBetween(from: Day, to: Day): number {
  const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  return Math.max(0, months);
}

export { addMonths };
