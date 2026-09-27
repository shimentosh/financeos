import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, currency, day, decimal, money, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { files, workspaces } from "./core.js";
import {
  accountKind,
  accountStatus,
  budgetPeriod,
  categoryKind,
  counterpartyKind,
  projectStatus,
  rateSource,
  ruleMatch,
  transactionDirection,
  transactionSource,
  transactionStatus,
  transactionType,
} from "./enums.js";
import { integrationConnections } from "./integrations.js";
import type { AiConfidence, RuleActions, RuleCondition } from "./types.js";
import { assets, investments, liabilities, receivables } from "./wealth.js";

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const financialAccounts = pgTable(
  "financial_account",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    kind: accountKind("kind").notNull(),
    /** bkash, nagad, rocket, stripe, paypal, wise, payoneer, brac_bank, ... */
    provider: text("provider"),
    institution: text("institution"),
    /** Last digits of the card or account number, never the full number. */
    mask: text("mask"),
    currency: currency().notNull(),
    openingBalance: money("opening_balance").notNull().default(0),
    openingDate: day("opening_date").notNull(),
    creditLimit: money("credit_limit"),
    /** Credit cards and overdrafts: a negative balance is money owed. */
    isLiability: boolean("is_liability").notNull().default(false),
    includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
    status: accountStatus("status").notNull().default("active"),
    color: text("color"),
    notes: text("notes"),
    lastReconciledAt: ts("last_reconciled_at"),
    lastReconciledBalance: money("last_reconciled_balance"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("financial_account_workspace_idx").on(t.workspaceId, t.status)],
);

export const categories = pgTable(
  "category",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    /** A lucide icon name. */
    icon: text("icon"),
    color: text("color"),
    isSystem: boolean("is_system").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("category_workspace_idx").on(t.workspaceId, t.kind),
    unique("category_name_unique").on(t.workspaceId, t.kind, t.parentId, t.name).nullsNotDistinct(),
  ],
);

/**
 * Merchants, customers, vendors, people and employees. Also the merchant
 * memory: once a merchant's category is confirmed, known merchants are
 * categorised without an AI call.
 */
export const counterparties = pgTable(
  "counterparty",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    /** Lowercased, punctuation-free form used for matching. */
    normalizedName: text("normalized_name").notNull(),
    kind: counterpartyKind("kind").notNull().default("merchant"),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    email: text("email"),
    phone: text("phone"),
    defaultCategoryId: uuid("default_category_id").references(() => categories.id, { onDelete: "set null" }),
    defaultProjectId: uuid("default_project_id").references((): AnyPgColumn => projects.id, { onDelete: "set null" }),
    defaultAccountId: uuid("default_account_id").references(() => financialAccounts.id, { onDelete: "set null" }),
    /** How many confirmed transactions agree with the default category. */
    confirmations: integer("confirmations").notNull().default(0),
    lastSeenAt: ts("last_seen_at"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("counterparty_name_unique").on(t.workspaceId, t.normalizedName)],
);

export const projects = pgTable(
  "project",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    code: text("code"),
    status: projectStatus("status").notNull().default("active"),
    color: text("color"),
    description: text("description"),
    startDate: day("start_date"),
    endDate: day("end_date"),
    /** Lifetime budget in the workspace base currency. */
    budgetAmount: money("budget_amount"),
    /** The catch-all "General Operations" project. */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("project_workspace_idx").on(t.workspaceId, t.status), unique("project_name_unique").on(t.workspaceId, t.name)],
);

/**
 * The canonical record of money moving. The ledger entries below are derived
 * from posted transactions; balances and reports read the entries.
 */
export const transactions = pgTable(
  "transaction",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    type: transactionType("type").notNull(),
    /** Money into or out of `accountId`. A transfer is `out` of its source. */
    direction: transactionDirection("direction").notNull(),
    status: transactionStatus("status").notNull().default("posted"),
    accountId: uuid("account_id").references(() => financialAccounts.id, {
      onDelete: "restrict",
    }),
    toAccountId: uuid("to_account_id").references(() => financialAccounts.id, {
      onDelete: "restrict",
    }),
    /** The original amount, as it appeared on the receipt or statement. */
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    /** The amount in the account's currency; equals `amount` when they match. */
    accountAmount: money("account_amount"),
    /** For transfers: the amount that arrived, in the destination's currency. */
    toAccountAmount: money("to_account_amount"),
    /** Original currency → base currency, as used for `baseAmount`. */
    fxRate: decimal("fx_rate"),
    baseAmount: money("base_amount"),
    baseCurrency: currency("base_currency"),
    date: day("date").notNull(),
    occurredAt: ts("occurred_at"),
    merchant: text("merchant"),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    description: text("description"),
    notes: text("notes"),
    /** The bank's or wallet's own id for it, e.g. a bKash TrxID. */
    reference: text("reference"),
    source: transactionSource("source").notNull().default("manual"),
    /** Capture, import batch, sync run or API key that produced it. */
    sourceRef: text("source_ref"),
    externalId: text("external_id"),
    /**
     * `${source}:${connectionId ?? "-"}:${externalId}`. Unique per workspace,
     * including voided rows, so a record the user deleted is never re-imported.
     */
    externalKey: text("external_key"),
    connectionId: uuid("connection_id").references((): AnyPgColumn => integrationConnections.id, { onDelete: "set null" }),
    attachmentFileId: uuid("attachment_file_id").references(() => files.id, {
      onDelete: "set null",
    }),
    aiConfidence: jsonb("ai_confidence").$type<AiConfidence>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Cost basis released by an investment withdrawal or an asset sale. */
    costBasis: money("cost_basis"),
    liabilityId: uuid("liability_id").references((): AnyPgColumn => liabilities.id, { onDelete: "set null" }),
    receivableId: uuid("receivable_id").references((): AnyPgColumn => receivables.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references((): AnyPgColumn => assets.id, {
      onDelete: "set null",
    }),
    investmentId: uuid("investment_id").references((): AnyPgColumn => investments.id, { onDelete: "set null" }),
    /** Refund → the purchase it refunds; owner contribution → its twin. */
    linkedTransactionId: uuid("linked_transaction_id").references((): AnyPgColumn => transactions.id, { onDelete: "set null" }),
    /** Why a draft or pending transaction is waiting. */
    reviewReason: text("review_reason"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    postedAt: ts("posted_at"),
    voidedAt: ts("voided_at"),
  },
  (t) => [
    index("transaction_workspace_date_idx").on(t.workspaceId, t.date),
    index("transaction_workspace_status_idx").on(t.workspaceId, t.status),
    index("transaction_workspace_type_date_idx").on(t.workspaceId, t.type, t.date),
    index("transaction_account_date_idx").on(t.accountId, t.date),
    index("transaction_category_date_idx").on(t.categoryId, t.date),
    index("transaction_project_date_idx").on(t.projectId, t.date),
    index("transaction_counterparty_idx").on(t.counterpartyId),
    index("transaction_workspace_source_idx").on(t.workspaceId, t.source),
    index("transaction_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("transaction_workspace_reference_idx").on(t.workspaceId, t.reference),
    index("transaction_connection_idx").on(t.connectionId),
    uniqueIndex("transaction_external_key_idx").on(t.workspaceId, t.externalKey).where(sql`external_key is not null`),
    // Invariants the ledger relies on, enforced by the database as well as
    // the engine: amounts are positive (direction carries the sign), and a
    // posted row is complete enough to produce ledger entries.
    check("transaction_amount_positive", sql`${t.amount} > 0`),
    check(
      "transaction_posted_complete",
      sql`${t.status} <> 'posted' or (${t.accountId} is not null and ${t.accountAmount} is not null and ${t.baseAmount} is not null)`,
    ),
    check(
      "transaction_transfer_destination",
      sql`${t.type} <> 'transfer' or ${t.status} <> 'posted' or (${t.toAccountId} is not null and ${t.toAccountAmount} is not null and ${t.toAccountId} <> ${t.accountId})`,
    ),
  ],
);

/**
 * Double-entry lines: one per account a posted transaction touches. Signed, in
 * the account's currency, with the base-currency value alongside. A balance is
 * the opening balance plus the sum of its entries.
 */
export const ledgerEntries = pgTable(
  "ledger_entry",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "restrict" }),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    baseAmount: money("base_amount").notNull(),
    date: day("date").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entry_account_date_idx").on(t.accountId, t.date),
    index("ledger_entry_workspace_date_idx").on(t.workspaceId, t.date),
    index("ledger_entry_transaction_idx").on(t.transactionId),
  ],
);

export const transactionAttachments = pgTable(
  "transaction_attachment",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.fileId] })],
);

export const exchangeRates = pgTable(
  "exchange_rate",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    fromCurrency: currency("from_currency").notNull(),
    toCurrency: currency("to_currency").notNull(),
    rate: decimal("rate").notNull(),
    date: day("date").notNull(),
    source: rateSource("source").notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("exchange_rate_unique").on(t.workspaceId, t.fromCurrency, t.toCurrency, t.date)],
);

/** User rules. They run before any AI call, in priority order. */
export const rules = pgTable(
  "rule",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    match: ruleMatch("match").notNull().default("all"),
    conditions: jsonb("conditions").$type<RuleCondition[]>().notNull().default([]),
    actions: jsonb("actions").$type<RuleActions>().notNull().default({}),
    stopProcessing: boolean("stop_processing").notNull().default(false),
    timesApplied: integer("times_applied").notNull().default(0),
    lastAppliedAt: ts("last_applied_at"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rule_workspace_idx").on(t.workspaceId, t.enabled, t.priority)],
);

export const budgets = pgTable(
  "budget",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    period: budgetPeriod("period").notNull().default("monthly"),
    /** Per period, in the workspace base currency. */
    amount: money("amount").notNull(),
    /** Neither set: the whole workspace. */
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "cascade",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    startDate: day("start_date").notNull(),
    endDate: day("end_date"),
    /** Percent of the budget at which to warn. */
    alertThreshold: integer("alert_threshold").notNull().default(80),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("budget_workspace_idx").on(t.workspaceId, t.active)],
);
