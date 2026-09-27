import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, currency, day, money, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { files, workspaces } from "./core.js";
import {
  commitmentFrequency,
  commitmentKind,
  commitmentStatus,
  goalKind,
  goalStatus,
  intervalUnit,
  occurrenceStatus,
  priority,
  subscriptionStatus,
  transactionDirection,
} from "./enums.js";
import { categories, counterparties, financialAccounts, projects, transactions } from "./ledger.js";
import { liabilities } from "./wealth.js";

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

/**
 * A future obligation (or expected inflow) on a schedule: rent, a loan
 * installment, insurance, a subscription renewal, salary. It is a promise,
 * not money moving; paying it creates a transaction.
 */
export const commitments = pgTable(
  "commitment",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: commitmentKind("kind").notNull(),
    /** `in` for expected income such as salary received. */
    direction: transactionDirection("direction").notNull().default("out"),
    name: text("name").notNull(),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    payee: text("payee"),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    frequency: commitmentFrequency("frequency").notNull(),
    /** For `custom`: every `intervalCount` `intervalUnit`s. */
    intervalCount: integer("interval_count").notNull().default(1),
    intervalUnit: intervalUnit("interval_unit"),
    startDate: day("start_date").notNull(),
    endDate: day("end_date"),
    /** Null once a one-off has been paid or the schedule has ended. */
    nextDueDate: day("next_due_date"),
    accountId: uuid("account_id").references(() => financialAccounts.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    liabilityId: uuid("liability_id").references(() => liabilities.id, {
      onDelete: "set null",
    }),
    /** Paid automatically (auto-debit, auto-renew) rather than by hand. */
    autoPay: boolean("auto_pay").notNull().default(false),
    status: commitmentStatus("status").notNull().default("active"),
    /** Days-before-due reminders; null uses the workspace defaults. */
    reminderOffsets: integer("reminder_offsets").array(),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("commitment_workspace_due_idx").on(t.workspaceId, t.status, t.nextDueDate),
    index("commitment_workspace_kind_idx").on(t.workspaceId, t.kind),
    index("commitment_project_idx").on(t.projectId),
  ],
);

/**
 * The subscription-specific facts about a commitment: plan, purchase, expiry,
 * cancellation deadline, lifecycle. The schedule and renewal amount stay on
 * the commitment, so they are never stored twice.
 */
export const subscriptions = pgTable(
  "subscription",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .unique()
      .references(() => commitments.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    planName: text("plan_name"),
    purchaseDate: day("purchase_date"),
    startDate: day("start_date"),
    trialEndsOn: day("trial_ends_on"),
    /** When access ends if not renewed. Often, not always, the renewal date. */
    expiryDate: day("expiry_date"),
    /** Last day to cancel without being charged for the next period. */
    cancellationDeadline: day("cancellation_deadline"),
    autoRenew: boolean("auto_renew").notNull().default(true),
    status: subscriptionStatus("status").notNull().default("active"),
    externalProviderId: text("external_provider_id"),
    attachmentFileId: uuid("attachment_file_id").references(() => files.id, {
      onDelete: "set null",
    }),
    cancelledAt: ts("cancelled_at"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("subscription_workspace_idx").on(t.workspaceId, t.status)],
);

/**
 * One due instance of a commitment: the renewal on 10 Oct 2027, the rent for
 * October. Paid occurrences link the transaction that settled them, which is
 * the renewal history and the source for price-change detection.
 */
export const commitmentOccurrences = pgTable(
  "commitment_occurrence",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitments.id, { onDelete: "cascade" }),
    dueDate: day("due_date").notNull(),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    status: occurrenceStatus("status").notNull().default("scheduled"),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    paidOn: day("paid_on"),
    paidAmount: money("paid_amount"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("commitment_occurrence_due_unique").on(t.commitmentId, t.dueDate),
    index("commitment_occurrence_workspace_idx").on(t.workspaceId, t.status, t.dueDate),
    uniqueIndex("commitment_occurrence_transaction_idx").on(t.transactionId).where(sql`transaction_id is not null`),
  ],
);

export const goals = pgTable(
  "goal",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: goalKind("kind").notNull(),
    name: text("name").notNull(),
    targetAmount: money("target_amount").notNull(),
    currency: currency().notNull(),
    targetDate: day("target_date"),
    priority: priority("priority").notNull().default("medium"),
    /** Planned monthly contribution (a savings plan). */
    monthlyPlan: money("monthly_plan"),
    startingAmount: money("starting_amount").notNull().default(0),
    /** When set, progress is this account's balance, not contributions. */
    linkedAccountId: uuid("linked_account_id").references(() => financialAccounts.id, { onDelete: "set null" }),
    imageFileId: uuid("image_file_id").references(() => files.id, {
      onDelete: "set null",
    }),
    icon: text("icon"),
    notes: text("notes"),
    status: goalStatus("status").notNull().default("active"),
    achievedAt: ts("achieved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("goal_workspace_idx").on(t.workspaceId, t.status)],
);

export const goalContributions = pgTable(
  "goal_contribution",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    /** Negative for a withdrawal from the goal. */
    amount: money("amount").notNull(),
    date: day("date").notNull(),
    note: text("note"),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("goal_contribution_goal_idx").on(t.goalId, t.date)],
);
