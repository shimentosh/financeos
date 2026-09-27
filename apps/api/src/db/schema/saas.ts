import type {
  BillingInterval,
  BillingProvider,
  BillingStatus,
  CreditKind,
  CreditSource,
  InvitationStatus,
  PaymentPurpose,
  PaymentStatus,
  PlanId,
  SupportStatus,
} from "@expensewise/core";
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, currency, decimal, money, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { workspaces } from "./core.js";
import { memberRole } from "./enums.js";

// Running Expense Wise as a hosted service: invitations, plans and payments,
// AI credits, single-run scheduling across instances, and support requests.

/**
 * An emailed, single-use invitation to a workspace. Only the SHA-256 of the
 * token is stored; it can be accepted by the signed-in owner of the verified
 * email it was sent to.
 */
export const workspaceInvitations = pgTable(
  "workspace_invitation",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull().default("member"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    status: text("status").$type<InvitationStatus>().notNull().default("pending"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One open invitation per address per workspace.
    uniqueIndex("workspace_invitation_pending_idx").on(t.workspaceId, t.email).where(sql`status = 'pending'`),
    index("workspace_invitation_email_idx").on(t.email),
  ],
);

/** A user's plan. It covers every workspace the user owns. One row per user; no row = Free. */
export const billingSubscriptions = pgTable(
  "billing_subscription",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    plan: text("plan").$type<PlanId>().notNull().default("free"),
    status: text("status").$type<BillingStatus>().notNull().default("active"),
    provider: text("provider").$type<BillingProvider>(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    interval: text("interval").$type<BillingInterval>(),
    currentPeriodStart: ts("current_period_start"),
    currentPeriodEnd: ts("current_period_end"),
    trialEndsAt: ts("trial_ends_at"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: ts("canceled_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("billing_subscription_provider_idx").on(t.provider, t.providerSubscriptionId)],
);

/** Money received for the service: a plan period or a pack of AI credits. */
export const billingPayments = pgTable(
  "billing_payment",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<BillingProvider>().notNull(),
    /** Checkout session id, SSLCommerz tran_id, or a manual reference. */
    providerRef: text("provider_ref").notNull(),
    providerPaymentId: text("provider_payment_id"),
    purpose: text("purpose").$type<PaymentPurpose>().notNull(),
    plan: text("plan").$type<PlanId>(),
    interval: text("interval").$type<BillingInterval>(),
    credits: integer("credits"),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    status: text("status").$type<PaymentStatus>().notNull().default("pending"),
    paidAt: ts("paid_at"),
    receiptUrl: text("receipt_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("billing_payment_provider_ref_idx").on(t.provider, t.providerRef), index("billing_payment_user_idx").on(t.userId, t.createdAt)],
);

/**
 * The AI credit ledger of a user (the owner of the workspaces that used them).
 * Additions are positive, usage negative. `allowance` rows count against the
 * plan's monthly credits; `balance` rows are purchased or granted credits.
 */
export const creditTransactions = pgTable(
  "credit_transaction",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    kind: text("kind").$type<CreditKind>().notNull(),
    source: text("source").$type<CreditSource>().notNull(),
    credits: integer("credits").notNull(),
    /** The model cost behind a usage row. */
    costUsd: decimal("cost_usd", 14, 6),
    aiUsageId: uuid("ai_usage_id"),
    paymentId: uuid("payment_id").references(() => billingPayments.id, { onDelete: "set null" }),
    note: text("note"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("credit_transaction_user_idx").on(t.userId, t.source, t.createdAt), uniqueIndex("credit_transaction_payment_idx").on(t.paymentId)],
);

/** One row per scheduled task per firing: whichever instance inserts it runs the task; the others skip. */
export const schedulerRuns = pgTable(
  "scheduler_run",
  {
    name: text("name").notNull(),
    slot: ts("slot").notNull(),
    instance: text("instance").notNull(),
    startedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.name, t.slot] })],
);

/** A message to the people running the service, from the in-app help form or the public contact page. */
export const supportRequests = pgTable(
  "support_request",
  {
    id: pk(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    name: text("name"),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    page: text("page"),
    status: text("status").$type<SupportStatus>().notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("support_request_status_idx").on(t.status, t.createdAt)],
);

/**
 * Actions on the installation itself, outside any workspace: platform admins
 * banning users or changing roles, account and workspace deletions. Actor and
 * target are plain text so the record outlives the users it names.
 */
export const platformAuditLogs = pgTable(
  "platform_audit_log",
  {
    id: pk(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("platform_audit_created_idx").on(t.createdAt), index("platform_audit_target_idx").on(t.targetType, t.targetId)],
);
