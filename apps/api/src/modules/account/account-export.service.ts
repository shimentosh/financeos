import { minorToInput } from "@expensewise/core";
import { Injectable } from "@nestjs/common";
import { asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { SessionUser, WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import {
  assets,
  assetValuations,
  auditLogs,
  authAccounts,
  budgets,
  categories,
  commitmentOccurrences,
  commitments,
  counterparties,
  employees,
  exchangeRates,
  files,
  financialAccounts,
  goalContributions,
  goals,
  integrationConnections,
  investments,
  investmentValuations,
  ledgerEntries,
  liabilities,
  payrollItems,
  payrollRuns,
  projects,
  receivables,
  rules,
  sessions,
  subscriptions,
  transactionAttachments,
  transactions,
  userSettings,
  users,
  workspaceMembers,
  workspaces,
} from "../../db/schema/index.js";

export const EXPORT_FORMAT = "expense-wise-export";
export const EXPORT_VERSION = 1;
const AUDIT_EXPORT_LIMIT = 1000;

/** A file name segment: lowercase letters, digits and dashes. */
export function fileSlug(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

// Spreadsheet apps run cells that start with these as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, quote or line break,
 * quotes doubled. Text that a spreadsheet would run as a formula is prefixed
 * with an apostrophe; amounts are passed as `numeric` and left alone.
 */
export function csvCell(value: string | number | null | undefined, kind: "text" | "numeric" = "text"): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (kind === "text" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: string[]): string {
  return cells.join(",");
}

const TRANSACTION_COLUMNS = [
  "date",
  "type",
  "direction",
  "status",
  "account",
  "to_account",
  "merchant",
  "counterparty",
  "category",
  "project",
  "description",
  "amount",
  "currency",
  "account_amount",
  "account_currency",
  "to_account_amount",
  "to_account_currency",
  "base_amount",
  "base_currency",
  "fx_rate",
  "reference",
  "source",
  "notes",
  "id",
  "created_at",
] as const;

/**
 * Everything a workspace holds, as data its owners can take elsewhere. Every
 * query filters by the workspace from the verified context; secrets
 * (integration credentials, file storage keys, API key hashes) are left out.
 */
@Injectable()
export class AccountExportService {
  async workspace(ctx: WorkspaceContext, user: SessionUser) {
    const ws = ctx.workspaceId;
    const [
      [workspace],
      members,
      accountRows,
      categoryRows,
      counterpartyRows,
      projectRows,
      ruleRows,
      rateRows,
      transactionRows,
      entryRows,
      attachmentRows,
      subscriptionRows,
      commitmentRows,
      occurrenceRows,
      budgetRows,
      goalRows,
      contributionRows,
      assetRows,
      assetValuationRows,
      investmentRows,
      investmentValuationRows,
      liabilityRows,
      receivableRows,
      employeeRows,
      payrollRunRows,
      payrollItemRows,
      fileRows,
      integrationRows,
      auditRows,
    ] = await Promise.all([
      db.select().from(workspaces).where(eq(workspaces.id, ws)),
      db
        .select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, ws))
        .orderBy(asc(workspaceMembers.createdAt)),
      db
        .select()
        .from(financialAccounts)
        .where(eq(financialAccounts.workspaceId, ws))
        .orderBy(asc(financialAccounts.sortOrder), asc(financialAccounts.createdAt)),
      db.select().from(categories).where(eq(categories.workspaceId, ws)).orderBy(asc(categories.kind), asc(categories.sortOrder)),
      db.select().from(counterparties).where(eq(counterparties.workspaceId, ws)).orderBy(asc(counterparties.name)),
      db.select().from(projects).where(eq(projects.workspaceId, ws)).orderBy(asc(projects.createdAt)),
      db.select().from(rules).where(eq(rules.workspaceId, ws)).orderBy(asc(rules.priority)),
      db.select().from(exchangeRates).where(eq(exchangeRates.workspaceId, ws)).orderBy(asc(exchangeRates.date)),
      db.select().from(transactions).where(eq(transactions.workspaceId, ws)).orderBy(asc(transactions.date), asc(transactions.createdAt)),
      db.select().from(ledgerEntries).where(eq(ledgerEntries.workspaceId, ws)).orderBy(asc(ledgerEntries.date), asc(ledgerEntries.createdAt)),
      db
        .select({ transactionId: transactionAttachments.transactionId, fileId: transactionAttachments.fileId, createdAt: transactionAttachments.createdAt })
        .from(transactionAttachments)
        .innerJoin(transactions, eq(transactions.id, transactionAttachments.transactionId))
        .where(eq(transactions.workspaceId, ws)),
      db.select().from(subscriptions).where(eq(subscriptions.workspaceId, ws)),
      db.select().from(commitments).where(eq(commitments.workspaceId, ws)),
      db.select().from(commitmentOccurrences).where(eq(commitmentOccurrences.workspaceId, ws)).orderBy(asc(commitmentOccurrences.dueDate)),
      db.select().from(budgets).where(eq(budgets.workspaceId, ws)),
      db.select().from(goals).where(eq(goals.workspaceId, ws)),
      db.select().from(goalContributions).where(eq(goalContributions.workspaceId, ws)),
      db.select().from(assets).where(eq(assets.workspaceId, ws)),
      db.select().from(assetValuations).where(eq(assetValuations.workspaceId, ws)),
      db.select().from(investments).where(eq(investments.workspaceId, ws)),
      db.select().from(investmentValuations).where(eq(investmentValuations.workspaceId, ws)),
      db.select().from(liabilities).where(eq(liabilities.workspaceId, ws)),
      db.select().from(receivables).where(eq(receivables.workspaceId, ws)),
      db.select().from(employees).where(eq(employees.workspaceId, ws)),
      db.select().from(payrollRuns).where(eq(payrollRuns.workspaceId, ws)),
      db.select().from(payrollItems).where(eq(payrollItems.workspaceId, ws)),
      db
        .select({
          id: files.id,
          filename: files.filename,
          contentType: files.contentType,
          size: files.size,
          sha256: files.sha256,
          kind: files.kind,
          uploadedBy: files.uploadedBy,
          createdAt: files.createdAt,
        })
        .from(files)
        .where(eq(files.workspaceId, ws))
        .orderBy(asc(files.createdAt)),
      db
        .select({
          id: integrationConnections.id,
          provider: integrationConnections.provider,
          name: integrationConnections.name,
          status: integrationConnections.status,
          syncFrequency: integrationConnections.syncFrequency,
          trustLevel: integrationConnections.trustLevel,
          lastSyncedAt: integrationConnections.lastSyncedAt,
          recordsTotal: integrationConnections.recordsTotal,
          createdAt: integrationConnections.createdAt,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.workspaceId, ws)),
      db.select().from(auditLogs).where(eq(auditLogs.workspaceId, ws)).orderBy(desc(auditLogs.createdAt)).limit(AUDIT_EXPORT_LIMIT),
    ]);

    const data = {
      members,
      accounts: accountRows,
      categories: categoryRows,
      counterparties: counterpartyRows,
      projects: projectRows,
      rules: ruleRows,
      exchangeRates: rateRows,
      transactions: transactionRows,
      ledgerEntries: entryRows,
      transactionAttachments: attachmentRows,
      subscriptions: subscriptionRows,
      commitments: commitmentRows,
      commitmentOccurrences: occurrenceRows,
      budgets: budgetRows,
      goals: goalRows,
      goalContributions: contributionRows,
      assets: assetRows,
      assetValuations: assetValuationRows,
      investments: investmentRows,
      investmentValuations: investmentValuationRows,
      liabilities: liabilityRows,
      receivables: receivableRows,
      employees: employeeRows,
      payrollRuns: payrollRunRows,
      payrollItems: payrollItemRows,
      files: fileRows,
      integrations: integrationRows,
      auditLog: auditRows,
    };
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: { id: user.id, email: user.email },
      notes: [
        "Amounts are integer minor units (cents, poisha) in the currency named next to them.",
        "File contents are not included; download receipts from the app. Integration credentials are never exported.",
        `The audit log holds the latest ${AUDIT_EXPORT_LIMIT} entries.`,
      ],
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            kind: workspace.kind,
            baseCurrency: workspace.baseCurrency,
            timezone: workspace.timezone,
            fiscalYearStartMonth: workspace.fiscalYearStartMonth,
            settings: workspace.settings,
            createdAt: workspace.createdAt,
          }
        : null,
      counts: Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, rows.length])),
      data,
    };
  }

  /** Every transaction of the workspace as CSV: original, account and base amounts as decimals. */
  async transactionsCsv(ctx: WorkspaceContext): Promise<string> {
    const toAccount = alias(financialAccounts, "to_account");
    const rows = await db
      .select({
        tx: transactions,
        account: financialAccounts.name,
        accountCurrency: financialAccounts.currency,
        toAccount: toAccount.name,
        toAccountCurrency: toAccount.currency,
        category: categories.name,
        project: projects.name,
        counterparty: counterparties.name,
      })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .leftJoin(toAccount, eq(toAccount.id, transactions.toAccountId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(projects, eq(projects.id, transactions.projectId))
      .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
      .where(eq(transactions.workspaceId, ctx.workspaceId))
      .orderBy(asc(transactions.date), asc(transactions.createdAt));

    const amount = (minor: number | null, currency: string | null) => csvCell(minor === null || !currency ? null : minorToInput(minor, currency), "numeric");
    const lines = [csvRow([...TRANSACTION_COLUMNS])];
    for (const row of rows) {
      const tx = row.tx;
      const accountCurrency = row.accountCurrency ?? tx.currency;
      lines.push(
        csvRow([
          csvCell(tx.date),
          csvCell(tx.type),
          csvCell(tx.direction),
          csvCell(tx.status),
          csvCell(row.account),
          csvCell(row.toAccount),
          csvCell(tx.merchant),
          csvCell(row.counterparty),
          csvCell(row.category),
          csvCell(row.project),
          csvCell(tx.description),
          amount(tx.amount, tx.currency),
          csvCell(tx.currency),
          amount(tx.accountAmount, accountCurrency),
          csvCell(tx.accountAmount === null ? null : accountCurrency),
          amount(tx.toAccountAmount, row.toAccountCurrency),
          csvCell(tx.toAccountAmount === null ? null : row.toAccountCurrency),
          amount(tx.baseAmount, tx.baseCurrency),
          csvCell(tx.baseCurrency),
          csvCell(tx.fxRate, "numeric"),
          csvCell(tx.reference),
          csvCell(tx.source),
          csvCell(tx.notes),
          csvCell(tx.id),
          csvCell(tx.createdAt.toISOString()),
        ]),
      );
    }
    // A byte-order mark so spreadsheet apps read Bangla and other scripts as UTF-8.
    return `﻿${lines.join("\r\n")}\r\n`;
  }

  /** What the service holds about the signed-in person themselves, outside any workspace's books. */
  async user(user: SessionUser) {
    const [[profile], [settings], memberships, signInMethods, activeSessions] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          emailVerified: users.emailVerified,
          image: users.image,
          role: users.role,
          twoFactorEnabled: users.twoFactorEnabled,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, user.id)),
      db
        .select({ preferences: userSettings.preferences, activeWorkspaceId: userSettings.activeWorkspaceId })
        .from(userSettings)
        .where(eq(userSettings.userId, user.id)),
      db
        .select({ workspaceId: workspaces.id, name: workspaces.name, kind: workspaces.kind, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, user.id))
        .orderBy(asc(workspaceMembers.createdAt)),
      db.select({ provider: authAccounts.providerId, createdAt: authAccounts.createdAt }).from(authAccounts).where(eq(authAccounts.userId, user.id)),
      db
        .select({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent })
        .from(sessions)
        .where(eq(sessions.userId, user.id))
        .orderBy(desc(sessions.createdAt)),
    ]);
    return {
      format: `${EXPORT_FORMAT}-profile`,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      profile: profile ?? null,
      preferences: settings?.preferences ?? {},
      activeWorkspaceId: settings?.activeWorkspaceId ?? null,
      memberships,
      signInMethods,
      sessions: activeSessions,
      notes: ["Each workspace's records are exported from that workspace (Settings → Data & account) by its owner or an admin."],
    };
  }
}
