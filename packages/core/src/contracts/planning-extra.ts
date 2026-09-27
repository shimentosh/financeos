import { z } from "zod";
import { COMMITMENT_KINDS, COMMITMENT_STATUSES, GOAL_KINDS, GOAL_STATUSES, SUBSCRIPTION_STATUSES } from "../constants.ts";
import { diffDays } from "../dates.ts";
import { currencyCode, dayString, listParam, optionalUuid, shortText } from "./common.ts";
import { markPaidInput, subscriptionInput } from "./planning.ts";

// Request contracts for the planning API (commitments, subscriptions, budgets,
// goals) that the base planning contracts do not cover: query strings, the
// duplicate-override flag on payments, cancellation.

/**
 * A boolean from a query string. `z.coerce.boolean()` reads "false" as true,
 * so query flags use this instead.
 */
export const queryBoolean = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((value) => value === true || value === "true" || value === "1" || value === "yes");

export const BILLING_CYCLES = ["monthly", "quarterly", "half_yearly", "yearly", "custom"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a month as YYYY-MM");
const direction = z.enum(["in", "out"]);
const search = z.string().trim().max(200).optional();

/** Filters shared by the commitment list, upcoming, calendar and annual views. */
const commitmentFilters = {
  kind: listParam(z.enum(COMMITMENT_KINDS)),
  direction: direction.optional(),
  projectId: optionalUuid,
  categoryId: optionalUuid,
  accountId: optionalUuid,
};

// ----------------------------------------------------------------- payments

/**
 * Recording a commitment payment. `force` creates a new transaction even when
 * a matching one already exists (the API otherwise answers 409 with the
 * candidates so the user can link one instead).
 */
export const markPaidRequest = markPaidInput.extend({
  force: z.boolean().default(false),
});
export type MarkPaidRequest = z.input<typeof markPaidRequest>;

export const undoPaymentInput = z.object({ reason: shortText.nullish() });
export type UndoPaymentInput = z.input<typeof undoPaymentInput>;

/** Existing transactions that could be this payment, before recording it. */
export const paymentMatchQuery = z.object({
  paidOn: dayString.optional(),
  amount: z.coerce.number().int().positive().optional(),
  currency: currencyCode.optional(),
  accountId: optionalUuid,
});
export type PaymentMatchQuery = z.input<typeof paymentMatchQuery>;

// -------------------------------------------------------------- commitments

export const commitmentQuery = z.object({
  ...commitmentFilters,
  status: listParam(z.enum(COMMITMENT_STATUSES)),
  q: search,
  /** Subscriptions are commitments too: include them, leave them out, or only them. */
  subscriptions: z.enum(["include", "exclude", "only"]).default("include"),
});
export type CommitmentQuery = z.input<typeof commitmentQuery>;

export const upcomingQuery = z.object({
  ...commitmentFilters,
  days: z.coerce.number().int().min(1).max(366).default(30),
  /** Past-due payments that were never recorded. */
  includeOverdue: queryBoolean.default(true),
});
export type UpcomingQuery = z.input<typeof upcomingQuery>;

export const calendarQuery = z
  .object({
    ...commitmentFilters,
    from: dayString,
    to: dayString,
    /** Paid, skipped and cancelled occurrences in the range. */
    includeSettled: queryBoolean.default(true),
  })
  .refine((query) => query.from <= query.to, { message: "`from` must be on or before `to`", path: ["to"] })
  .refine((query) => diffDays(query.from, query.to) <= 400, { message: "A calendar covers at most 400 days", path: ["to"] });
export type CalendarQuery = z.input<typeof calendarQuery>;

export const annualCommitmentsQuery = z.object({
  ...commitmentFilters,
  year: z.coerce.number().int().min(1970).max(2999).optional(),
});
export type AnnualCommitmentsQuery = z.input<typeof annualCommitmentsQuery>;

// ------------------------------------------------------------ subscriptions

/** A new subscription; `purchaseTransactionId` links an expense already recorded. */
export const subscriptionCreateRequest = subscriptionInput.extend({
  purchaseTransactionId: optionalUuid,
});
export type SubscriptionCreateRequest = z.input<typeof subscriptionCreateRequest>;

export const subscriptionQuery = z.object({
  q: search,
  /** Matches the derived (current) status. */
  status: listParam(z.enum(SUBSCRIPTION_STATUSES)),
  billingCycle: listParam(z.enum(BILLING_CYCLES)),
  projectId: optionalUuid,
  categoryId: optionalUuid,
  accountId: optionalUuid,
  /** Renewal amount range in base-currency minor units. */
  minAmount: z.coerce.number().int().min(0).optional(),
  maxAmount: z.coerce.number().int().min(0).optional(),
  /** Renewing in this month ("2026-10"). */
  renewingIn: monthString.optional(),
  autoRenew: queryBoolean.optional(),
  sort: z.enum(["renewal_asc", "amount_desc", "monthly_desc", "name_asc"]).default("renewal_asc"),
});
export type SubscriptionQuery = z.input<typeof subscriptionQuery>;

export const subscriptionCancelInput = z.object({
  /** When access ends. Defaults to the expiry date, else the next renewal date, else today. */
  effectiveDate: dayString.nullish(),
  reason: shortText.nullish(),
});
export type SubscriptionCancelInput = z.input<typeof subscriptionCancelInput>;

// ------------------------------------------------------------------ budgets

export const budgetQuery = z.object({
  /** Measure the period containing this day (default today). */
  date: dayString.optional(),
  active: queryBoolean.optional(),
  categoryId: optionalUuid,
  projectId: optionalUuid,
  /** Also return this many periods of history per budget (0 = none), for sparklines. */
  history: z.coerce.number().int().min(0).max(24).default(0),
});
export type BudgetQuery = z.input<typeof budgetQuery>;

export const budgetDetailQuery = z.object({
  date: dayString.optional(),
  /** Periods of history, ending with the one containing `date`. */
  periods: z.coerce.number().int().min(1).max(24).default(6),
});
export type BudgetDetailQuery = z.input<typeof budgetDetailQuery>;

// -------------------------------------------------------------------- goals

export const goalQuery = z.object({
  kind: listParam(z.enum(GOAL_KINDS)),
  status: listParam(z.enum(GOAL_STATUSES)),
  /** Only goals with a planned monthly contribution. */
  savingsPlan: queryBoolean.optional(),
});
export type GoalQuery = z.input<typeof goalQuery>;
