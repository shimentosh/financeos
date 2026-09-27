import { sql } from "drizzle-orm";
import { type AnyPgColumn, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, currency, day, decimal, money, pk, updatedAt } from "./_columns.js";
import { workspaces } from "./core.js";
import { assetKind, assetStatus, investmentKind, investmentStatus, liabilityKind, liabilityStatus, receivableKind, receivableStatus } from "./enums.js";
import { integrationConnections } from "./integrations.js";
import { categories, counterparties, financialAccounts, projects } from "./ledger.js";

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const assets = pgTable(
  "asset",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    kind: assetKind("kind").notNull(),
    purchasePrice: money("purchase_price"),
    currency: currency().notNull(),
    purchaseDate: day("purchase_date"),
    /** Latest valuation, denormalised from asset_valuation for fast reads. */
    currentValue: money("current_value").notNull(),
    valuedAt: day("valued_at"),
    /** Who owns it: "Me", "Spouse", "Company". */
    owner: text("owner"),
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    status: assetStatus("status").notNull().default("owned"),
    soldOn: day("sold_on"),
    soldAmount: money("sold_amount"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("asset_workspace_idx").on(t.workspaceId, t.status)],
);

export const assetValuations = pgTable(
  "asset_valuation",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    value: money("value").notNull(),
    date: day("date").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("asset_valuation_asset_date_idx").on(t.assetId, t.date)],
);

/**
 * Holdings kept apart from spending. Contributions and withdrawals are
 * `investment` transactions linked here; valuations track market value.
 */
export const investments = pgTable(
  "investment",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    name: text("name").notNull(),
    kind: investmentKind("kind").notNull(),
    institution: text("institution"),
    currency: currency().notNull(),
    openedOn: day("opened_on"),
    maturityDate: day("maturity_date"),
    /** Annual percent, e.g. 11.28 for a savings certificate. */
    interestRate: decimal("interest_rate", 7, 4),
    /** Cost of a holding that existed before it was tracked here. */
    openingCostBasis: money("opening_cost_basis").notNull().default(0),
    /** Latest valuation, denormalised from investment_valuation. */
    currentValue: money("current_value"),
    valuedAt: day("valued_at"),
    status: investmentStatus("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("investment_workspace_idx").on(t.workspaceId, t.status)],
);

export const investmentValuations = pgTable(
  "investment_valuation",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    investmentId: uuid("investment_id")
      .notNull()
      .references(() => investments.id, { onDelete: "cascade" }),
    value: money("value").notNull(),
    date: day("date").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("investment_valuation_investment_date_idx").on(t.investmentId, t.date)],
);

/**
 * Loans, credit, personal and business debt, and payables. Outstanding is the
 * opening outstanding, plus borrowing (`loan` in) and minus payments
 * (`debt_payment` or `expense` out) linked to it.
 */
export const liabilities = pgTable(
  "liability",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: liabilityKind("kind").notNull(),
    name: text("name").notNull(),
    counterpartyId: uuid("counterparty_id").references((): AnyPgColumn => counterparties.id, { onDelete: "set null" }),
    counterpartyName: text("counterparty_name"),
    principal: money("principal").notNull(),
    currency: currency().notNull(),
    /** What was owed when it was added here. */
    openingOutstanding: money("opening_outstanding").notNull(),
    interestRate: decimal("interest_rate", 7, 4),
    startDate: day("start_date"),
    dueDate: day("due_date"),
    categoryId: uuid("category_id").references((): AnyPgColumn => categories.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    /** The card account for a credit liability, when one exists. */
    accountId: uuid("account_id").references((): AnyPgColumn => financialAccounts.id, { onDelete: "set null" }),
    status: liabilityStatus("status").notNull().default("active"),
    notes: text("notes"),
    externalKey: text("external_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("liability_workspace_idx").on(t.workspaceId, t.status),
    uniqueIndex("liability_external_key_idx").on(t.workspaceId, t.externalKey).where(sql`external_key is not null`),
  ],
);

/**
 * Money owed to the workspace: customer invoices (paid by `income`) and money
 * lent (collected by `debt_payment` in). Paid amount is summed from them.
 */
export const receivables = pgTable(
  "receivable",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: receivableKind("kind").notNull().default("invoice"),
    counterpartyId: uuid("counterparty_id").references((): AnyPgColumn => counterparties.id, { onDelete: "set null" }),
    counterpartyName: text("counterparty_name").notNull(),
    title: text("title").notNull(),
    /** Invoice number or other reference. */
    reference: text("reference"),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    issueDate: day("issue_date").notNull(),
    dueDate: day("due_date"),
    /** `cancelled` is stored; paid/overdue are recomputed from payments. */
    status: receivableStatus("status").notNull().default("pending"),
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references((): AnyPgColumn => categories.id, { onDelete: "set null" }),
    source: text("source").notNull().default("manual"),
    externalKey: text("external_key"),
    connectionId: uuid("connection_id").references((): AnyPgColumn => integrationConnections.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("receivable_workspace_status_idx").on(t.workspaceId, t.status, t.dueDate),
    index("receivable_project_idx").on(t.projectId),
    uniqueIndex("receivable_external_key_idx").on(t.workspaceId, t.externalKey).where(sql`external_key is not null`),
  ],
);
