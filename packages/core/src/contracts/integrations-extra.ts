import { z } from "zod";
import { DIRECTIONS, PROJECT_STATUSES, TRANSACTION_STATUSES, TRANSACTION_TYPES } from "../constants.ts";
import { currencyDecimals, toMinor } from "../money.ts";
import { currencyCode, dayString, listParam, longText, optionalUuid, pagination, positiveMinor, shortText, signedMinor, uuid } from "./common.ts";
import { transactionInput } from "./ledger.ts";
import { importMappingInput } from "./operations.ts";

// Integrations, imports and the public API: vocabularies, canonical records
// every connector produces, and the request contracts of those endpoints.

export const CONNECTOR_CATEGORIES = ["payments", "banking", "accounting", "crm", "projects", "ecommerce", "custom"] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export const CONNECTION_STATUSES = ["connected", "syncing", "error", "needs_attention", "disconnected"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const SYNC_FREQUENCIES = ["manual", "hourly", "daily"] as const;
export const TRUST_LEVELS = ["trusted", "review"] as const;

export const SYNC_TRIGGERS = ["initial", "incremental", "manual", "scheduled", "webhook", "retry"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const WEBHOOK_EVENT_STATUSES = ["received", "processed", "ignored", "failed", "duplicate"] as const;

export const IMPORT_STATUSES = ["uploaded", "mapped", "previewed", "importing", "completed", "failed", "cancelled"] as const;
export const IMPORT_ROW_STATUSES = ["valid", "invalid", "duplicate", "imported", "skipped"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const API_KEY_SCOPES = ["read", "write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const queryBoolean = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
  .optional()
  .transform((value) => value === true || value === "true" || value === "1");

// ------------------------------------------------------------ canonical records

const externalId = z.string().trim().min(1).max(200);
/** Free-form provider data kept on the record; capped so a feed cannot bloat rows. */
const metadata = z
  .record(z.string(), z.unknown())
  .default({})
  .refine((value) => JSON.stringify(value).length <= 8_000, "Metadata must be at most 8 KB of JSON");
const hint = shortText.nullish();
const accountRef = z.string().trim().max(200).nullish();

/**
 * Any money movement, as a connector reports it. `amount` is positive minor
 * units; `direction` carries the sign. `accountRef` / `toAccountRef` name an
 * account in the source system, resolved through the connection's account map
 * (or an FinanceOS account id); omitted, the connection's account is used.
 */
export const canonicalTransaction = z.object({
  kind: z.literal("transaction"),
  externalId,
  type: z.enum(TRANSACTION_TYPES),
  direction: z.enum(DIRECTIONS).optional(),
  amount: positiveMinor,
  currency: currencyCode,
  date: dayString,
  occurredAt: z.iso.datetime({ offset: true }).nullish(),
  description: hint,
  counterparty: hint,
  categoryHint: hint,
  projectHint: hint,
  accountRef,
  toAccountRef: accountRef,
  reference: hint,
  metadata,
});

/** Gross revenue from a sale; becomes an income transaction. */
export const canonicalRevenue = z.object({
  kind: z.literal("revenue"),
  externalId,
  amount: positiveMinor,
  currency: currencyCode,
  date: dayString,
  occurredAt: z.iso.datetime({ offset: true }).nullish(),
  source: hint,
  customer: hint,
  product: hint,
  project: hint,
  description: hint,
  categoryHint: hint,
  accountRef,
  reference: hint,
  metadata,
});

/** A cost; becomes an expense transaction. */
export const canonicalExpense = z.object({
  kind: z.literal("expense"),
  externalId,
  amount: positiveMinor,
  currency: currencyCode,
  date: dayString,
  occurredAt: z.iso.datetime({ offset: true }).nullish(),
  vendor: hint,
  description: hint,
  categoryHint: hint,
  project: hint,
  accountRef,
  reference: hint,
  metadata,
});

/** An invoice someone owes; upserted as a receivable by its external key. */
export const canonicalReceivable = z.object({
  kind: z.literal("receivable"),
  externalId,
  customer: shortText.pipe(z.string().min(1, "A receivable needs a customer")),
  title: shortText.pipe(z.string().min(1, "A receivable needs a title")),
  reference: hint,
  amount: positiveMinor,
  currency: currencyCode,
  issueDate: dayString,
  dueDate: dayString.nullish(),
  status: z.enum(["pending", "paid", "cancelled"]).default("pending"),
  project: hint,
  notes: longText.nullish(),
  metadata,
});

/** A project in the source system; upserted by name (or code). */
export const canonicalProject = z.object({
  kind: z.literal("project"),
  externalId,
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().max(16).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  description: longText.nullish(),
  metadata,
});

/** A balance the source reports, kept on the sync run to compare with the books. */
export const canonicalBalance = z.object({
  kind: z.literal("balance"),
  accountRef,
  balance: signedMinor,
  currency: currencyCode,
  asOf: dayString,
});

/** Seen, deliberately not imported (the reason is shown in the sync log). */
export const canonicalSkip = z.object({
  kind: z.literal("skip"),
  externalId,
  reason: z.string().max(300),
});

export const canonicalRecord = z.discriminatedUnion("kind", [
  canonicalTransaction,
  canonicalRevenue,
  canonicalExpense,
  canonicalReceivable,
  canonicalProject,
  canonicalBalance,
  canonicalSkip,
]);
export type CanonicalRecordInput = z.input<typeof canonicalRecord>;
export type CanonicalRecord = z.output<typeof canonicalRecord>;

// ------------------------------------------------------------------ connections

/** PATCH /integrations/:id. Unlike `connectionUpdate`, nothing is defaulted. */
export const connectionPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** Replaces every credential; validated with the connector before saving. */
  credentials: z.record(z.string(), z.string()).optional(),
  /** Shallow-merged into the stored config; a `null` value removes the key. */
  config: z.record(z.string(), z.unknown()).optional(),
  accountId: optionalUuid,
  projectId: optionalUuid,
  syncFrequency: z.enum(SYNC_FREQUENCIES).optional(),
  trustLevel: z.enum(TRUST_LEVELS).optional(),
});
export type ConnectionPatch = z.input<typeof connectionPatch>;

export const connectionRecordsQuery = pagination.extend({
  status: listParam(z.enum(TRANSACTION_STATUSES)),
  type: listParam(z.enum(TRANSACTION_TYPES)),
  from: dayString.optional(),
  to: dayString.optional(),
  q: z.string().trim().max(200).optional(),
});

export const syncRunQuery = pagination.extend({
  connectionId: optionalUuid,
  status: listParam(z.enum(SYNC_STATUSES)),
  trigger: listParam(z.enum(SYNC_TRIGGERS)),
  from: dayString.optional(),
  to: dayString.optional(),
});

export const webhookTestInput = z.object({
  /** Provider event type, e.g. "charge.succeeded"; the connector's default when omitted. */
  eventType: z.string().trim().max(60).optional(),
});

// ---------------------------------------------------------------------- imports

export const importUploadFields = z.object({
  /** Excel sheet name; the first sheet when omitted. */
  sheet: z.string().trim().max(100).optional(),
});

/**
 * PUT /imports/:id/mapping: `importMappingInput` plus the optional running
 * balance column (kept on each row for reference).
 */
export const importMappingRequest = importMappingInput.extend({
  mapping: importMappingInput.shape.mapping.extend({ balance: z.string().optional() }),
});

export const importRowsQuery = pagination.extend({
  status: listParam(z.enum(IMPORT_ROW_STATUSES)),
});

export const importListQuery = pagination.extend({
  status: listParam(z.enum(IMPORT_STATUSES)),
});

export const importCommitInput = z.object({
  /** Ids of rows flagged `duplicate` that should be imported anyway. */
  includeDuplicates: z.array(uuid).max(20_000).default([]),
});

export const importDeleteQuery = z.object({
  /** For a completed import: void every transaction it created. */
  revert: queryBoolean,
});

// ------------------------------------------------------------------- public API

/** An amount in minor units (default) or major units, converted to minor. */
const amountFields = {
  amount: z.number().positive().max(Number.MAX_SAFE_INTEGER),
  amount_unit: z.enum(["minor", "major"]).default("minor"),
  currency: currencyCode,
};

function amountInMinor(value: { amount: number; amount_unit: "minor" | "major"; currency: string }): number | null {
  if (value.amount_unit === "major") {
    const minor = toMinor(value.amount, value.currency);
    return minor > 0 ? minor : null;
  }
  return Number.isInteger(value.amount) ? value.amount : null;
}

function withMinorAmount<T extends { amount: number; amount_unit: "minor" | "major"; currency: string }>(value: T, ctx: z.RefinementCtx) {
  const minor = amountInMinor(value);
  if (minor === null) {
    ctx.addIssue({
      code: "custom",
      path: ["amount"],
      message:
        value.amount_unit === "minor"
          ? "In minor units (the default) the amount must be a whole number, e.g. 150050 for 1,500.50"
          : `Amount must be positive with at most ${currencyDecimals(value.currency)} decimals`,
    });
    return z.NEVER;
  }
  return { ...value, amountMinor: minor };
}

const revenueFields = {
  ...amountFields,
  date: dayString,
  occurred_at: z.iso.datetime({ offset: true }).nullish(),
  source: hint,
  customer: hint,
  product: hint,
  project: hint,
  category: hint,
  description: hint,
  reference: hint,
  metadata,
};

const expenseFields = {
  ...amountFields,
  date: dayString,
  occurred_at: z.iso.datetime({ offset: true }).nullish(),
  vendor: hint,
  project: hint,
  category: hint,
  description: hint,
  reference: hint,
  metadata,
};

const transactionFields = {
  ...amountFields,
  date: dayString,
  occurred_at: z.iso.datetime({ offset: true }).nullish(),
  type: z.enum(TRANSACTION_TYPES),
  direction: z.enum(DIRECTIONS).optional(),
  counterparty: hint,
  project: hint,
  category: hint,
  description: hint,
  reference: hint,
  metadata,
};

const publicWriteFields = {
  external_id: externalId,
  /** An account in the workspace; without one the record is saved as a draft. */
  account_id: optionalUuid,
  /** `posted` needs `account_id`; the default keeps it as a draft for review. */
  status: z.enum(["draft", "posted"]).default("draft"),
};

/** POST /api/v1/revenue: idempotent by `external_id`. */
export const publicRevenueInput = z.object({ ...revenueFields, ...publicWriteFields }).transform(withMinorAmount);
export type PublicRevenueInput = z.input<typeof publicRevenueInput>;

/** POST /api/v1/expenses: idempotent by `external_id`. */
export const publicExpenseInput = z.object({ ...expenseFields, ...publicWriteFields }).transform(withMinorAmount);
export type PublicExpenseInput = z.input<typeof publicExpenseInput>;

/** POST /api/v1/transactions: the ledger contract, drafted unless `status: "posted"`. */
export const publicTransactionInput = transactionInput.extend({
  status: z.enum(["draft", "pending", "posted"]).default("draft"),
  /** Makes the call idempotent: the same id never creates a second transaction. */
  externalId: externalId.optional(),
});
export type PublicTransactionInput = z.input<typeof publicTransactionInput>;

/** GET /api/v1/transactions: a subset of the dashboard query. */
export const publicTransactionQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  from: dayString.optional(),
  to: dayString.optional(),
  type: listParam(z.enum(TRANSACTION_TYPES)),
  status: listParam(z.enum(TRANSACTION_STATUSES)),
  accountId: uuid.optional(),
  categoryId: uuid.optional(),
  projectId: uuid.optional(),
  q: z.string().trim().max(200).optional(),
});

/**
 * The body a custom app POSTs to a Custom Webhook connection:
 * `{ id, type, data }`, idempotent by `id`. `data` uses the public API's
 * snake_case fields; `data.external_id` defaults to the event id.
 */
export const inboundWebhookEvent = z.discriminatedUnion("type", [
  z.object({
    id: externalId,
    type: z.literal("transaction"),
    data: z.object({ ...transactionFields, external_id: externalId.optional() }).transform(withMinorAmount),
  }),
  z.object({ id: externalId, type: z.literal("revenue"), data: z.object({ ...revenueFields, external_id: externalId.optional() }).transform(withMinorAmount) }),
  z.object({ id: externalId, type: z.literal("expense"), data: z.object({ ...expenseFields, external_id: externalId.optional() }).transform(withMinorAmount) }),
]);
export type InboundWebhookEvent = z.input<typeof inboundWebhookEvent>;
