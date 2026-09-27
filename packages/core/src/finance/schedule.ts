import type { Frequency, IntervalUnit } from "../constants.ts";
import { addDays, addMonths, type Day } from "../dates.ts";

export type Schedule = {
  frequency: Frequency;
  /** For `custom`: every `intervalCount` `intervalUnit`s. */
  intervalCount?: number;
  intervalUnit?: IntervalUnit | null;
  startDate: Day;
  endDate?: Day | null;
};

function step(schedule: Schedule): { unit: IntervalUnit; count: number } | null {
  switch (schedule.frequency) {
    case "once":
      return null;
    case "weekly":
      return { unit: "week", count: 1 };
    case "monthly":
      return { unit: "month", count: 1 };
    case "quarterly":
      return { unit: "month", count: 3 };
    case "half_yearly":
      return { unit: "month", count: 6 };
    case "yearly":
      return { unit: "year", count: 1 };
    case "custom":
      return {
        unit: schedule.intervalUnit ?? "month",
        count: Math.max(1, schedule.intervalCount ?? 1),
      };
  }
}

/**
 * The n-th due date of a schedule (n = 0 is the start). Computed from the
 * start date every time rather than by stepping from the previous date, so a
 * schedule anchored on the 31st returns to the 31st after February.
 */
export function nthDueDate(schedule: Schedule, n: number): Day | null {
  const s = step(schedule);
  if (!s) return n === 0 ? schedule.startDate : null;
  const anchor = Number(schedule.startDate.slice(8, 10));
  switch (s.unit) {
    case "day":
      return addDays(schedule.startDate, n * s.count);
    case "week":
      return addDays(schedule.startDate, n * s.count * 7);
    case "month":
      return addMonths(schedule.startDate, n * s.count, anchor);
    case "year":
      return addMonths(schedule.startDate, n * s.count * 12, anchor);
  }
}

/** The first due date on or after `from`, or null when the schedule has ended. */
export function nextDueOnOrAfter(schedule: Schedule, from: Day): Day | null {
  if (from <= schedule.startDate) return withinEnd(schedule, schedule.startDate);
  const s = step(schedule);
  if (!s) return null;
  // Estimate the index, then walk: exact regardless of month lengths.
  const approxDays = s.unit === "day" ? s.count : s.unit === "week" ? 7 * s.count : s.unit === "month" ? 30.44 * s.count : 365.25 * s.count;
  const elapsed = (Date.parse(`${from}T00:00:00Z`) - Date.parse(`${schedule.startDate}T00:00:00Z`)) / 86_400_000;
  let n = Math.max(0, Math.floor(elapsed / approxDays) - 1);
  for (let guard = 0; guard < 10_000; guard++, n++) {
    const due = nthDueDate(schedule, n);
    if (due === null) return null;
    if (due >= from) return withinEnd(schedule, due);
  }
  return null;
}

/** The due date after `current`. */
export function followingDueDate(schedule: Schedule, current: Day): Day | null {
  return nextDueOnOrAfter(schedule, addDays(current, 1));
}

function withinEnd(schedule: Schedule, day: Day): Day | null {
  return schedule.endDate && day > schedule.endDate ? null : day;
}

/** Every due date in [from, to]. */
export function dueDatesBetween(schedule: Schedule, from: Day, to: Day, limit = 500): Day[] {
  const dates: Day[] = [];
  let due = nextDueOnOrAfter(schedule, from);
  while (due && due <= to && dates.length < limit) {
    dates.push(due);
    due = followingDueDate(schedule, due);
  }
  return dates;
}

/** How many times a year the schedule falls due. */
export function occurrencesPerYear(schedule: Pick<Schedule, "frequency" | "intervalCount" | "intervalUnit">): number {
  switch (schedule.frequency) {
    case "once":
      return 0;
    case "weekly":
      return 52;
    case "monthly":
      return 12;
    case "quarterly":
      return 4;
    case "half_yearly":
      return 2;
    case "yearly":
      return 1;
    case "custom": {
      const count = Math.max(1, schedule.intervalCount ?? 1);
      switch (schedule.intervalUnit ?? "month") {
        case "day":
          return 365 / count;
        case "week":
          return 52 / count;
        case "month":
          return 12 / count;
        case "year":
          return 1 / count;
      }
    }
  }
}

/** Annual cost of a recurring amount, rounded to minor units. */
export function annualized(amount: number, schedule: Pick<Schedule, "frequency" | "intervalCount" | "intervalUnit">): number {
  return Math.round(amount * occurrencesPerYear(schedule));
}

/** The monthly equivalent: a $180 yearly plan is $15 a month. */
export function monthlyEquivalent(amount: number, schedule: Pick<Schedule, "frequency" | "intervalCount" | "intervalUnit">): number {
  return Math.round(annualized(amount, schedule) / 12);
}
