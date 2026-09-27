import { DEFAULT_REMINDER_OFFSETS, type SubscriptionStatus } from "../constants.ts";
import { type Day, diffDays, formatDay } from "../dates.ts";
import { percentChange } from "../money.ts";

export type SubscriptionFacts = {
  name: string;
  status: SubscriptionStatus;
  autoRenew: boolean;
  nextRenewalDate: Day | null;
  expiryDate: Day | null;
  cancellationDeadline: Day | null;
  trialEndsOn?: Day | null;
};

/**
 * The status a subscription should show today. Stored states the user chose
 * (cancelled, paused, cancellation pending) are kept; time-driven ones
 * (renewal due, expired, trial over) follow from the dates.
 */
export function deriveSubscriptionStatus(facts: SubscriptionFacts, today: Day): SubscriptionStatus {
  if (facts.status === "paused") return "paused";
  if (facts.status === "cancelled" || facts.status === "cancellation_pending") {
    if (facts.expiryDate && facts.expiryDate < today) return "expired";
    return facts.status;
  }
  if (facts.status === "trial" && facts.trialEndsOn && facts.trialEndsOn >= today) {
    return "trial";
  }
  if (!facts.autoRenew && facts.expiryDate && facts.expiryDate < today) return "expired";
  if (facts.nextRenewalDate && diffDays(today, facts.nextRenewalDate) <= 7) return "renewal_due";
  return "active";
}

export type RenewalAlertStage = "upcoming" | "soon" | "tomorrow" | "today" | "overdue";

export type RenewalAlert = {
  kind: "renewal" | "expiry" | "cancellation_deadline" | "unconfirmed";
  stage: RenewalAlertStage;
  /** Days until the date (negative once passed). */
  days: number;
  /** The reminder offset this alert belongs to — part of its dedupe key. */
  offset: number;
  date: Day;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
};

function stageFor(days: number): RenewalAlertStage {
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "soon";
  return "upcoming";
}

function inDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/**
 * The reminder offset that is due today, if any: the smallest configured
 * offset at or above the days remaining. Sending only that one means a
 * reminder missed while the app was down still goes out, but never twice.
 */
export function dueReminderOffset(days: number, offsets: number[] = DEFAULT_REMINDER_OFFSETS): number | null {
  if (days < 0) return null;
  const eligible = offsets.filter((offset) => offset >= days).sort((a, b) => a - b);
  return eligible[0] ?? null;
}

export type AlertInput = {
  name: string;
  amountLabel: string;
  autoRenew: boolean;
  dueDate: Day | null;
  expiryDate?: Day | null;
  cancellationDeadline?: Day | null;
  /** True when a scheduled payment has passed without being recorded. */
  unpaid?: boolean;
  reminderOffsets?: number[] | null;
};

/**
 * The alerts a commitment warrants today. Each carries the offset it fires
 * for, so the caller can dedupe on (entity, kind, offset) and a reminder is
 * never sent twice.
 */
export function renewalAlerts(input: AlertInput, today: Day): RenewalAlert[] {
  const offsets = input.reminderOffsets?.length ? input.reminderOffsets : DEFAULT_REMINDER_OFFSETS;
  const alerts: RenewalAlert[] = [];

  if (input.dueDate) {
    const days = diffDays(today, input.dueDate);
    if (days < 0 && input.unpaid) {
      alerts.push({
        kind: "unconfirmed",
        stage: "overdue",
        days,
        offset: -1,
        date: input.dueDate,
        title: `${input.name} payment not recorded`,
        body: `${input.name} was expected ${days === -1 ? "yesterday" : `${-days} days ago`} (${formatDay(input.dueDate)}) but no payment has been recorded.`,
        severity: "warning",
      });
    } else {
      const offset = dueReminderOffset(days, offsets);
      if (offset !== null) {
        const stage = stageFor(days);
        const title =
          days === 0 ? `${input.name} renewal is due today` : days === 1 ? `${input.name} renewal is tomorrow` : `${input.name} renews ${inDays(days)}`;
        const body = input.autoRenew
          ? `Expected renewal payment: ${input.amountLabel} on ${formatDay(input.dueDate)}.`
          : `Manual renewal required before ${formatDay(input.dueDate)} (${input.amountLabel}).`;
        alerts.push({
          kind: "renewal",
          stage,
          days,
          offset,
          date: input.dueDate,
          title,
          body,
          severity: days <= 1 ? "warning" : "info",
        });
      }
    }
  }

  // Expiry matters on its own only when nothing will renew it.
  if (input.expiryDate && !input.autoRenew && input.expiryDate !== input.dueDate) {
    const days = diffDays(today, input.expiryDate);
    const offset = dueReminderOffset(days, offsets);
    if (offset !== null) {
      alerts.push({
        kind: "expiry",
        stage: stageFor(days),
        days,
        offset,
        date: input.expiryDate,
        title: days === 0 ? `${input.name} expires today` : days === 1 ? `${input.name} expires tomorrow` : `${input.name} expires ${inDays(days)}`,
        body: `${input.name} expires ${inDays(days)}. Renewal will need to be completed manually.`,
        severity: days <= 7 ? "warning" : "info",
      });
    }
  }

  if (input.cancellationDeadline) {
    const days = diffDays(today, input.cancellationDeadline);
    const offset = dueReminderOffset(days, offsets.filter((o) => o <= 14).length ? offsets.filter((o) => o <= 14) : offsets);
    if (offset !== null) {
      alerts.push({
        kind: "cancellation_deadline",
        stage: stageFor(days),
        days,
        offset,
        date: input.cancellationDeadline,
        title: days === 0 ? `Last day to cancel ${input.name}` : `Cancellation deadline for ${input.name} is ${inDays(days)}`,
        body: `Cancel by ${formatDay(input.cancellationDeadline)} to avoid being charged ${input.amountLabel} for the next period.`,
        severity: days <= 3 ? "critical" : "warning",
      });
    }
  }

  return alerts;
}

export type PriceChange = {
  previous: number;
  current: number;
  difference: number;
  percent: number | null;
  direction: "increase" | "decrease";
};

/** A renewal whose price differs from the last one paid. */
export function detectPriceChange(previous: number | null | undefined, current: number): PriceChange | null {
  if (previous === null || previous === undefined || previous === current) return null;
  return {
    previous,
    current,
    difference: current - previous,
    percent: percentChange(previous, current),
    direction: current > previous ? "increase" : "decrease",
  };
}
