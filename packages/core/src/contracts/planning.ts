import { z } from "zod";
import {
  ASSET_KINDS,
  COMMITMENT_KINDS,
  FREQUENCIES,
  GOAL_KINDS,
  GOAL_STATUSES,
  INTERVAL_UNITS,
  INVESTMENT_KINDS,
  LIABILITY_KINDS,
  PRIORITIES,
  RECEIVABLE_KINDS,
  SUBSCRIPTION_STATUSES,
} from "../constants.ts";
import {
  attachmentFileIds,
  currencyCode,
  dayString,
  decimalString,
  longText,
  nonNegativeMinor,
  optionalUuid,
  positiveMinor,
  shortText,
  signedMinor,
} from "./common.ts";

// ------------------------------------------------------------- commitments

export const commitmentInput = z.object({
  kind: z.enum(COMMITMENT_KINDS),
  direction: z.enum(["in", "out"]).default("out"),
  name: z.string().trim().min(1).max(120),
  payee: shortText.nullish(),
  counterpartyId: optionalUuid,
  amount: positiveMinor,
  currency: currencyCode,
  frequency: z.enum(FREQUENCIES),
  intervalCount: z.number().int().min(1).max(365).default(1),
  intervalUnit: z.enum(INTERVAL_UNITS).nullish(),
  startDate: dayString,
  endDate: dayString.nullish(),
  /** First due date if not the start date (e.g. already paid this month). */
  nextDueDate: dayString.nullish(),
  accountId: optionalUuid,
  categoryId: optionalUuid,
  projectId: optionalUuid,
  liabilityId: optionalUuid,
  autoPay: z.boolean().default(false),
  reminderOffsets: z.array(z.number().int().min(0).max(365)).max(10).nullish(),
  notes: longText.nullish(),
});
export type CommitmentInput = z.input<typeof commitmentInput>;
export const commitmentUpdate = commitmentInput.partial().extend({
  status: z.enum(["active", "paused", "ended"]).optional(),
});

export const subscriptionInput = z.object({
  provider: z.string().trim().min(1).max(120),
  planName: shortText.nullish(),
  name: shortText.optional(),
  amount: positiveMinor,
  currency: currencyCode,
  billingCycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly", "custom"]),
  intervalCount: z.number().int().min(1).max(60).default(1),
  intervalUnit: z.enum(INTERVAL_UNITS).nullish(),
  purchaseDate: dayString.nullish(),
  startDate: dayString,
  trialEndsOn: dayString.nullish(),
  expiryDate: dayString.nullish(),
  nextRenewalDate: dayString,
  cancellationDeadline: dayString.nullish(),
  autoRenew: z.boolean().default(true),
  status: z.enum(SUBSCRIPTION_STATUSES).default("active"),
  accountId: optionalUuid,
  categoryId: optionalUuid,
  projectId: optionalUuid,
  externalProviderId: shortText.nullish(),
  attachmentFileId: optionalUuid,
  reminderOffsets: z.array(z.number().int().min(0).max(365)).max(10).nullish(),
  notes: longText.nullish(),
  /** Also record the initial purchase as an expense transaction. */
  recordPurchase: z.object({ accountId: optionalUuid, date: dayString, amount: positiveMinor.optional() }).nullish(),
});
export type SubscriptionInput = z.input<typeof subscriptionInput>;
export const subscriptionUpdate = subscriptionInput.partial().omit({ recordPurchase: true });

export const markPaidInput = z.object({
  /** Defaults to the scheduled amount. A different amount is a price change. */
  amount: positiveMinor.optional(),
  currency: currencyCode.optional(),
  paidOn: dayString,
  accountId: optionalUuid,
  /** Link an existing transaction instead of creating one (no duplicates). */
  existingTransactionId: optionalUuid,
  /** When the amount changed: use it for future renewals too. */
  updateFutureAmount: z.boolean().default(false),
  note: shortText.nullish(),
  /** The receipt or invoice, uploaded through /files first. */
  attachmentFileIds,
});
export type MarkPaidInput = z.input<typeof markPaidInput>;

export const skipOccurrenceInput = z.object({ note: shortText.nullish() });

// ------------------------------------------------------------------- wealth

export const assetInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(ASSET_KINDS),
  purchasePrice: nonNegativeMinor.nullish(),
  currency: currencyCode,
  purchaseDate: dayString.nullish(),
  currentValue: nonNegativeMinor,
  valuedAt: dayString.nullish(),
  owner: shortText.nullish(),
  projectId: optionalUuid,
  notes: longText.nullish(),
  /** Record the purchase as an asset_purchase transaction from this account. */
  paidFromAccountId: optionalUuid,
  /** The purchase invoice, attached to that transaction. */
  attachmentFileIds,
});
export const assetUpdate = assetInput
  .partial()
  .omit({ paidFromAccountId: true, attachmentFileIds: true })
  .extend({
    status: z.enum(["owned", "sold", "disposed"]).optional(),
    soldOn: dayString.nullish(),
    soldAmount: nonNegativeMinor.nullish(),
  });
export const valuationInput = z.object({
  value: nonNegativeMinor,
  date: dayString,
  note: shortText.nullish(),
});

export const investmentInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(INVESTMENT_KINDS),
  institution: shortText.nullish(),
  currency: currencyCode,
  openedOn: dayString.nullish(),
  maturityDate: dayString.nullish(),
  interestRate: decimalString.nullish(),
  openingCostBasis: nonNegativeMinor.default(0),
  currentValue: nonNegativeMinor.nullish(),
  valuedAt: dayString.nullish(),
  notes: longText.nullish(),
});
export const investmentUpdate = investmentInput.partial().extend({ status: z.enum(["active", "closed"]).optional() });
export const investmentFlowInput = z.object({
  direction: z.enum(["out", "in"]),
  amount: positiveMinor,
  accountId: z.uuid(),
  date: dayString,
  costBasis: nonNegativeMinor.nullish(),
  note: shortText.nullish(),
  attachmentFileIds,
});

export const liabilityInput = z.object({
  kind: z.enum(LIABILITY_KINDS),
  name: z.string().trim().min(1).max(120),
  counterpartyName: shortText.nullish(),
  counterpartyId: optionalUuid,
  principal: positiveMinor,
  currency: currencyCode,
  openingOutstanding: nonNegativeMinor,
  interestRate: decimalString.nullish(),
  startDate: dayString.nullish(),
  dueDate: dayString.nullish(),
  categoryId: optionalUuid,
  projectId: optionalUuid,
  accountId: optionalUuid,
  notes: longText.nullish(),
  /** Record receiving the borrowed money into this account. */
  receivedIntoAccountId: optionalUuid,
  /** Create an installment schedule. */
  schedule: z.object({ amount: positiveMinor, frequency: z.enum(FREQUENCIES), firstDueDate: dayString, autoPay: z.boolean().default(false) }).nullish(),
});
export const liabilityUpdate = liabilityInput
  .partial()
  .omit({ receivedIntoAccountId: true, schedule: true })
  .extend({
    status: z.enum(["active", "paid_off", "overdue", "cancelled"]).optional(),
  });
export const liabilityPaymentInput = z.object({
  amount: positiveMinor,
  /** Part of `amount` that is interest, recorded as an interest expense. */
  interest: nonNegativeMinor.default(0),
  accountId: z.uuid(),
  date: dayString,
  note: shortText.nullish(),
  attachmentFileIds,
});

export const receivableInput = z.object({
  kind: z.enum(RECEIVABLE_KINDS).default("invoice"),
  counterpartyName: z.string().trim().min(1).max(120),
  counterpartyId: optionalUuid,
  title: z.string().trim().min(1).max(160),
  reference: shortText.nullish(),
  amount: positiveMinor,
  currency: currencyCode,
  issueDate: dayString,
  dueDate: dayString.nullish(),
  projectId: optionalUuid,
  categoryId: optionalUuid,
  notes: longText.nullish(),
  /** For money lent: record it leaving this account. */
  lentFromAccountId: optionalUuid,
});
export const receivableUpdate = receivableInput
  .partial()
  .omit({ lentFromAccountId: true })
  .extend({
    status: z.enum(["pending", "cancelled"]).optional(),
  });
export const receivablePaymentInput = z.object({
  amount: positiveMinor,
  accountId: z.uuid(),
  date: dayString,
  reference: shortText.nullish(),
  note: shortText.nullish(),
  attachmentFileIds,
});

// -------------------------------------------------------------------- goals

export const goalInput = z.object({
  kind: z.enum(GOAL_KINDS),
  name: z.string().trim().min(1).max(120),
  targetAmount: positiveMinor,
  currency: currencyCode,
  targetDate: dayString.nullish(),
  priority: z.enum(PRIORITIES).default("medium"),
  monthlyPlan: nonNegativeMinor.nullish(),
  startingAmount: nonNegativeMinor.default(0),
  linkedAccountId: optionalUuid,
  icon: z.string().max(40).nullish(),
  /** A picture of the dream purchase (uploaded through /files). */
  imageFileId: optionalUuid,
  notes: longText.nullish(),
});
export const goalUpdate = goalInput.partial().extend({ status: z.enum(GOAL_STATUSES).optional() });
export const goalContributionInput = z.object({
  amount: signedMinor.refine((v) => v !== 0, "Amount cannot be zero"),
  date: dayString,
  note: shortText.nullish(),
  /** Move the money into a savings account as a transfer too. */
  transfer: z.object({ fromAccountId: z.uuid(), toAccountId: z.uuid() }).nullish(),
});
