import { relations } from "drizzle-orm";
import { captures } from "./ai.js";
import { workspaceMembers, workspaces } from "./core.js";
import { integrationConnections, syncRuns } from "./integrations.js";
import { categories, counterparties, financialAccounts, ledgerEntries, projects, transactions } from "./ledger.js";
import { commitmentOccurrences, commitments, goalContributions, goals, subscriptions } from "./planning.js";

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
}));

export const workspaceMemberRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
}));

export const transactionRelations = relations(transactions, ({ one, many }) => ({
  account: one(financialAccounts, {
    fields: [transactions.accountId],
    references: [financialAccounts.id],
    relationName: "transaction_account",
  }),
  toAccount: one(financialAccounts, {
    fields: [transactions.toAccountId],
    references: [financialAccounts.id],
    relationName: "transaction_to_account",
  }),
  category: one(categories, {
    fields: [transactions.categoryId],
    references: [categories.id],
  }),
  project: one(projects, {
    fields: [transactions.projectId],
    references: [projects.id],
  }),
  counterparty: one(counterparties, {
    fields: [transactions.counterpartyId],
    references: [counterparties.id],
  }),
  entries: many(ledgerEntries),
}));

export const ledgerEntryRelations = relations(ledgerEntries, ({ one }) => ({
  transaction: one(transactions, {
    fields: [ledgerEntries.transactionId],
    references: [transactions.id],
  }),
  account: one(financialAccounts, {
    fields: [ledgerEntries.accountId],
    references: [financialAccounts.id],
  }),
}));

export const categoryRelations = relations(categories, ({ one }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
  }),
}));

export const commitmentRelations = relations(commitments, ({ one, many }) => ({
  subscription: one(subscriptions),
  occurrences: many(commitmentOccurrences),
  account: one(financialAccounts, {
    fields: [commitments.accountId],
    references: [financialAccounts.id],
  }),
  category: one(categories, {
    fields: [commitments.categoryId],
    references: [categories.id],
  }),
  project: one(projects, {
    fields: [commitments.projectId],
    references: [projects.id],
  }),
}));

export const subscriptionRelations = relations(subscriptions, ({ one }) => ({
  commitment: one(commitments, {
    fields: [subscriptions.commitmentId],
    references: [commitments.id],
  }),
}));

export const occurrenceRelations = relations(commitmentOccurrences, ({ one }) => ({
  commitment: one(commitments, {
    fields: [commitmentOccurrences.commitmentId],
    references: [commitments.id],
  }),
  transaction: one(transactions, {
    fields: [commitmentOccurrences.transactionId],
    references: [transactions.id],
  }),
}));

export const goalRelations = relations(goals, ({ many }) => ({
  contributions: many(goalContributions),
}));

export const goalContributionRelations = relations(goalContributions, ({ one }) => ({
  goal: one(goals, {
    fields: [goalContributions.goalId],
    references: [goals.id],
  }),
}));

export const connectionRelations = relations(integrationConnections, ({ many }) => ({
  runs: many(syncRuns),
}));

export const syncRunRelations = relations(syncRuns, ({ one }) => ({
  connection: one(integrationConnections, {
    fields: [syncRuns.connectionId],
    references: [integrationConnections.id],
  }),
}));

export const captureRelations = relations(captures, () => ({}));
