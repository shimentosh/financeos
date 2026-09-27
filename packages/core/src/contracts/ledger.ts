import { z } from "zod";
import {
  ACCOUNT_KINDS,
  BUDGET_PERIODS,
  CATEGORY_KINDS,
  COUNTERPARTY_KINDS,
  DIRECTIONS,
  PROJECT_STATUSES,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from "../constants.ts";
import {
  currencyCode,
  dayString,
  decimalString,
  listParam,
  longText,
  nonNegativeMinor,
  optionalUuid,
  pagination,
  positiveMinor,
  shortText,
  signedMinor,
  uuid,
} from "./common.ts";

// ---------------------------------------------------------------- transactions

export const transactionInput = z.object({
  type: z.enum(TRANSACTION_TYPES),
  direction: z.enum(DIRECTIONS).optional(),
  /** `draft` stages it for review; anything posted goes into the ledger. */
  status: z.enum(["draft", "pending", "posted"]).default("posted"),
  accountId: optionalUuid,
  toAccountId: optionalUuid,
  amount: positiveMinor,
  currency: currencyCode,
  /** Needed only when the account's currency differs from `currency`. */
  accountAmount: positiveMinor.nullish(),
  toAccountAmount: positiveMinor.nullish(),
  /** Original currency → base currency; looked up when omitted. */
  fxRate: decimalString.nullish(),
  date: dayString,
  occurredAt: z.iso.datetime({ offset: true }).nullish(),
  merchant: shortText.nullish(),
  counterpartyId: optionalUuid,
  categoryId: optionalUuid,
  projectId: optionalUuid,
  description: shortText.nullish(),
  notes: longText.nullish(),
  reference: shortText.nullish(),
  liabilityId: optionalUuid,
  receivableId: optionalUuid,
  assetId: optionalUuid,
  investmentId: optionalUuid,
  costBasis: nonNegativeMinor.nullish(),
  linkedTransactionId: optionalUuid,
  attachmentFileIds: z.array(uuid).max(10).optional(),
});
export type TransactionInput = z.input<typeof transactionInput>;

export const transactionUpdate = transactionInput.partial().extend({
  /** Why it changed; stored in the audit log. */
  reason: shortText.optional(),
});
export type TransactionUpdate = z.input<typeof transactionUpdate>;

export const transactionQuery = pagination.extend({
  from: dayString.optional(),
  to: dayString.optional(),
  type: listParam(z.enum(TRANSACTION_TYPES)),
  status: listParam(z.enum(TRANSACTION_STATUSES)),
  source: listParam(z.enum(TRANSACTION_SOURCES)),
  accountId: optionalUuid,
  categoryId: z.union([uuid, z.literal("none")]).optional(),
  projectId: z.union([uuid, z.literal("none")]).optional(),
  counterpartyId: optionalUuid,
  commitmentId: optionalUuid,
  ids: listParam(uuid),
  q: z.string().trim().max(200).optional(),
  minAmount: z.coerce.number().int().optional(),
  maxAmount: z.coerce.number().int().optional(),
  /** Include subcategories of `categoryId`. */
  includeChildren: z.coerce.boolean().default(true),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc", "created_desc"]).default("date_desc"),
});
export type TransactionQuery = z.input<typeof transactionQuery>;

export const bulkTransactionAction = z.object({
  ids: z.array(uuid).min(1).max(500),
  action: z.enum(["post", "void", "categorize", "assign_project", "delete_drafts"]),
  categoryId: optionalUuid,
  projectId: optionalUuid,
});

// ------------------------------------------------------------------- accounts

export const accountInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(ACCOUNT_KINDS),
  provider: shortText.nullish(),
  institution: shortText.nullish(),
  mask: z.string().trim().max(8).nullish(),
  currency: currencyCode,
  openingBalance: signedMinor.default(0),
  openingDate: dayString,
  creditLimit: nonNegativeMinor.nullish(),
  isLiability: z.boolean().optional(),
  includeInNetWorth: z.boolean().default(true),
  color: z.string().max(20).nullish(),
  notes: longText.nullish(),
});
export type AccountInput = z.input<typeof accountInput>;
export const accountUpdate = accountInput.partial().extend({ status: z.enum(["active", "archived"]).optional() });

export const reconcileInput = z.object({
  /** The balance shown by the bank or wallet, in the account currency. */
  statementBalance: signedMinor,
  asOf: dayString,
  /** Post the difference as an adjustment so the books match the statement. */
  adjust: z.boolean().default(false),
});

// ----------------------------------------------------------------- categories

export const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(CATEGORY_KINDS),
  parentId: optionalUuid,
  icon: z.string().max(40).nullish(),
  color: z.string().max(20).nullish(),
});
export const categoryUpdate = categoryInput.partial().extend({ archived: z.boolean().optional() });

export const counterpartyInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(COUNTERPARTY_KINDS).default("merchant"),
  email: z.email().nullish(),
  phone: shortText.nullish(),
  defaultCategoryId: optionalUuid,
  defaultProjectId: optionalUuid,
  aliases: z.array(shortText).max(20).optional(),
  notes: longText.nullish(),
});

// ------------------------------------------------------------------- projects

export const projectInput = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().max(16).nullish(),
  status: z.enum(PROJECT_STATUSES).default("active"),
  color: z.string().max(20).nullish(),
  description: longText.nullish(),
  startDate: dayString.nullish(),
  endDate: dayString.nullish(),
  budgetAmount: nonNegativeMinor.nullish(),
});
export const projectUpdate = projectInput.partial();

// ---------------------------------------------------------------------- rules

export const ruleConditionInput = z.object({
  field: z.enum(["merchant", "description", "amount", "currency", "account", "source", "type", "reference"]),
  operator: z.enum(["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "between"]),
  value: z.union([z.string().max(200), z.number()]),
  value2: z.number().optional(),
});

export const ruleInput = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000).default(100),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(ruleConditionInput).min(1).max(10),
  actions: z
    .object({
      categoryId: uuid.optional(),
      projectId: uuid.optional(),
      accountId: uuid.optional(),
      type: z.enum(["expense", "income", "transfer", "refund", "investment", "asset_purchase", "debt_payment"]).optional(),
      merchant: shortText.optional(),
      requireReview: z.boolean().optional(),
      ignore: z.boolean().optional(),
      note: shortText.optional(),
    })
    .refine((actions) => Object.values(actions).some((v) => v !== undefined && v !== null), "A rule needs at least one action"),
  stopProcessing: z.boolean().default(false),
});
export type RuleInput = z.input<typeof ruleInput>;

// -------------------------------------------------------------------- budgets

export const budgetInput = z.object({
  name: z.string().trim().min(1).max(80),
  period: z.enum(BUDGET_PERIODS).default("monthly"),
  amount: positiveMinor,
  categoryId: optionalUuid,
  projectId: optionalUuid,
  startDate: dayString,
  endDate: dayString.nullish(),
  alertThreshold: z.number().int().min(1).max(200).default(80),
  notes: longText.nullish(),
});
export const budgetUpdate = budgetInput.partial().extend({ active: z.boolean().optional() });

// ----------------------------------------------------------------------- fx

export const exchangeRateInput = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  rate: decimalString,
  date: dayString,
});

// ------------------------------------------------------------------ workspace

export const workspaceInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["personal", "business"]),
  baseCurrency: currencyCode.default("BDT"),
  timezone: z.string().max(60).default("Asia/Dhaka"),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
});
export const workspaceUpdate = workspaceInput.partial().extend({
  settings: z
    .object({
      reminderOffsets: z.array(z.number().int().min(0).max(365)).max(10).optional(),
      reviewThreshold: nonNegativeMinor.nullable().optional(),
      autoPostHighConfidence: z.boolean().optional(),
      aiEnabled: z.boolean().optional(),
      aiMonthlyBudgetUsd: z.number().min(0).max(10_000).nullable().optional(),
      lowCashThreshold: nonNegativeMinor.nullable().optional(),
      autoCreateDetectedSubscriptions: z.boolean().optional(),
    })
    .optional(),
});
