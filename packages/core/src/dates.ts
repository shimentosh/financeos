// Financial dates are calendar days ("YYYY-MM-DD"), not instants. All math
// here is on UTC midnights, so no timezone offset can move a day.

export type Day = string;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is Day {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toDate(day: Day): Date {
  return new Date(`${day}T00:00:00Z`);
}

function fromDate(date: Date): Day {
  return date.toISOString().slice(0, 10);
}

/** Today in a timezone, as a day. */
export function today(timeZone = "Asia/Dhaka", now = new Date()): Day {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(day: Day, days: number): Day {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return fromDate(date);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Adds months, clamping to the month's last day: 31 Jan + 1 month = 28/29 Feb.
 * `anchorDay` keeps a schedule on its original day after a short month
 * (31 Jan → 28 Feb → 31 Mar, not 28 Mar).
 */
export function addMonths(day: Day, months: number, anchorDay?: number): Day {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const wanted = anchorDay ?? d;
  const clamped = Math.min(wanted, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

export function addYears(day: Day, years: number, anchorDay?: number): Day {
  return addMonths(day, years * 12, anchorDay);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function diffDays(a: Day, b: Day): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

export function startOfMonth(day: Day): Day {
  return `${day.slice(0, 7)}-01`;
}

export function endOfMonth(day: Day): Day {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return `${day.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

export function monthKey(day: Day): string {
  return day.slice(0, 7);
}

export function startOfQuarter(day: Day): Day {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const first = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(first).padStart(2, "0")}-01`;
}

export function endOfQuarter(day: Day): Day {
  return endOfMonth(addMonths(startOfQuarter(day), 2));
}

/** Start of the (fiscal) year containing `day`. */
export function startOfYear(day: Day, fiscalStartMonth = 1): Day {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const year = m >= fiscalStartMonth ? y : y - 1;
  return `${year}-${String(fiscalStartMonth).padStart(2, "0")}-01`;
}

export function endOfYear(day: Day, fiscalStartMonth = 1): Day {
  return addDays(addMonths(startOfYear(day, fiscalStartMonth), 12), -1);
}

/** Monday-based (or Sunday/Saturday) week start. */
export function startOfWeek(day: Day, weekStartsOn: 0 | 1 | 6 = 1): Day {
  const weekday = toDate(day).getUTCDay();
  const offset = (weekday - weekStartsOn + 7) % 7;
  return addDays(day, -offset);
}

export function minDay(a: Day, b: Day): Day {
  return a < b ? a : b;
}

export function maxDay(a: Day, b: Day): Day {
  return a > b ? a : b;
}

/** Every day in [from, to]. */
export function eachDay(from: Day, to: Day, limit = 1000): Day[] {
  const days: Day[] = [];
  let cursor = from;
  while (cursor <= to && days.length < limit) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Month keys ("2026-09") from the month of `from` to the month of `to`. */
export function eachMonth(from: Day, to: Day, limit = 240): string[] {
  const months: string[] = [];
  let cursor = startOfMonth(from);
  while (cursor <= to && months.length < limit) {
    months.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export type Range = { from: Day; to: Day };

export type PeriodPreset =
  | "this_month"
  | "last_month"
  | "last_30_days"
  | "last_90_days"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "last_year"
  | "last_12_months"
  | "all_time";

export function presetRange(preset: PeriodPreset, reference: Day, fiscalStartMonth = 1): Range {
  switch (preset) {
    case "this_month":
      return { from: startOfMonth(reference), to: endOfMonth(reference) };
    case "last_month": {
      const previous = addMonths(startOfMonth(reference), -1);
      return { from: previous, to: endOfMonth(previous) };
    }
    case "last_30_days":
      return { from: addDays(reference, -29), to: reference };
    case "last_90_days":
      return { from: addDays(reference, -89), to: reference };
    case "this_quarter":
      return { from: startOfQuarter(reference), to: endOfQuarter(reference) };
    case "last_quarter": {
      const previous = addMonths(startOfQuarter(reference), -3);
      return { from: previous, to: endOfQuarter(previous) };
    }
    case "this_year":
      return {
        from: startOfYear(reference, fiscalStartMonth),
        to: endOfYear(reference, fiscalStartMonth),
      };
    case "last_year": {
      const previous = addMonths(startOfYear(reference, fiscalStartMonth), -12);
      return { from: previous, to: endOfYear(previous, fiscalStartMonth) };
    }
    case "last_12_months":
      return { from: startOfMonth(addMonths(reference, -11)), to: endOfMonth(reference) };
    case "all_time":
      return { from: "1970-01-01", to: "2999-12-31" };
  }
}

/** The equally long range immediately before `range`. */
export function previousRange(range: Range): Range {
  const length = diffDays(range.from, range.to) + 1;
  // Whole calendar months compare against whole calendar months.
  if (range.from === startOfMonth(range.from) && range.to === endOfMonth(range.to)) {
    const months = (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 + Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7)) + 1;
    const from = addMonths(range.from, -months);
    return { from, to: addDays(range.from, -1) };
  }
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parses the dates found on statements, receipts and CSVs. `format` resolves
 * the DD/MM vs MM/DD ambiguity; "auto" prefers day-first (Bangladesh, UK).
 */
export function parseDay(input: string, format: "auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" | "DD-MM-YYYY" | "DD.MM.YYYY" = "auto"): Day | null {
  const text = input
    .trim()
    .replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)))
    .replace(/\s+/g, " ");
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ ,T].*)?$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = normalizeYear(Number(numeric[3]));
    if (format === "MM/DD/YYYY") return build(year, a, b);
    if (format === "auto" && a <= 12 && b > 12) return build(year, a, b);
    return build(year, b, a);
  }

  // "26 Sep 2026", "26-Sep-26", "Sep 26, 2026", "September 26 2026"
  const named = text.toLowerCase().match(/^(\d{1,2})[\s-]([a-z]{3,9})[\s,-]+(\d{2,4})/);
  if (named) {
    const month = MONTHS.indexOf(named[2]?.slice(0, 3) ?? "") + 1;
    if (month > 0) return build(normalizeYear(Number(named[3])), month, Number(named[1]));
  }
  const monthFirst = text.toLowerCase().match(/^([a-z]{3,9})[\s-](\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/);
  if (monthFirst) {
    const month = MONTHS.indexOf(monthFirst[1]?.slice(0, 3) ?? "") + 1;
    if (month > 0) return build(normalizeYear(Number(monthFirst[3])), month, Number(monthFirst[2]));
  }
  return null;
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

function build(year: number, month: number, dayOfMonth: number): Day | null {
  const day = `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
  return isDay(day) ? day : null;
}

export function formatDay(day: Day, style: "short" | "medium" | "long" = "medium", locale = "en-GB"): string {
  const options: Intl.DateTimeFormatOptions =
    style === "short"
      ? { day: "numeric", month: "short" }
      : style === "medium"
        ? { day: "numeric", month: "short", year: "numeric" }
        : { weekday: "short", day: "numeric", month: "long", year: "numeric" };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(toDate(day));
}

export function formatMonth(key: string, locale = "en-GB", short = false): string {
  return new Intl.DateTimeFormat(locale, {
    month: short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}-01T00:00:00Z`));
}

/** "today", "tomorrow", "in 5 days", "3 days ago". */
export function relativeDays(day: Day, reference: Day): string {
  const diff = diffDays(reference, day);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}
