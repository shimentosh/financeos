import type { BillingInterval } from "@financeos/core";

const DAY_MS = 86_400_000;

/** `date` plus `months` calendar months (UTC), the day clamped to the month's end: Jan 31 + 1 month = Feb 28. */
export function addMonthsUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()),
  );
}

export function addInterval(date: Date, interval: BillingInterval, count = 1): Date {
  return addMonthsUtc(date, interval === "year" ? 12 * count : count);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days from `now` until `date`, rounded up (a couple of minutes of clock skew ignored); 0 once it has passed. */
export function daysUntil(date: Date, now = new Date()): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime() - 120_000) / DAY_MS));
}

/** The UTC calendar month containing `now`. */
export function calendarMonthUtc(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: addMonthsUtc(start, 1) };
}

/**
 * The month-long window containing `now`, counted from `anchor`: monthly AI
 * credits on a yearly plan renew on the same day each month as the plan began.
 */
export function monthlyWindow(anchor: Date, now: Date): { start: Date; end: Date } {
  if (now < anchor) return { start: anchor, end: addMonthsUtc(anchor, 1) };
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  let start = addMonthsUtc(anchor, months);
  if (start > now) {
    months -= 1;
    start = addMonthsUtc(anchor, months);
  }
  return { start, end: addMonthsUtc(anchor, months + 1) };
}

/** Unix seconds (Stripe's timestamps) to a Date. */
export const fromUnix = (seconds: unknown): Date | null => (typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null);
