import { endOfMonth, startOfMonth, type TransactionInput } from "@expensewise/core";
import type { publicExpenseInput, publicRevenueInput, publicTransactionInput, publicTransactionQuery } from "@expensewise/core/contracts/integrations-extra";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../../common/context.js";
import { unprocessable } from "../../../common/errors.js";
import { AccountsService } from "../../ledger/accounts.service.js";
import { CategoriesService, ProjectsService } from "../../ledger/catalog.service.js";
import { type TransactionRow, TransactionsService } from "../../ledger/transactions.service.js";

type Listed = Awaited<ReturnType<TransactionsService["list"]>>["items"][number];

/** A transaction as the public API returns it. */
export function publicTransaction(row: TransactionRow | Listed) {
  const named = row as Partial<Listed>;
  return {
    id: row.id,
    type: row.type,
    direction: row.direction,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    accountId: row.accountId,
    accountName: named.accountName ?? null,
    toAccountId: row.toAccountId,
    accountAmount: row.accountAmount,
    baseAmount: row.baseAmount,
    baseCurrency: row.baseCurrency,
    fxRate: row.fxRate,
    date: row.date,
    occurredAt: row.occurredAt,
    merchant: row.merchant,
    counterpartyName: named.counterpartyName ?? null,
    categoryId: row.categoryId,
    categoryName: named.categoryName ?? null,
    projectId: row.projectId,
    projectName: named.projectName ?? null,
    description: row.description,
    notes: row.notes,
    reference: row.reference,
    source: row.source,
    externalId: row.externalId,
    reviewReason: row.reviewReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The public API v1: a thin, stable layer over the ledger for your own apps. */
@Injectable()
export class PublicApiService {
  constructor(
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  async listAccounts(ctx: WorkspaceContext) {
    const rows = await this.accounts.list(ctx);
    return {
      items: rows.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        currency: a.currency,
        balance: a.balance,
        baseBalance: a.baseBalance,
        baseCurrency: ctx.baseCurrency,
        provider: a.provider,
        institution: a.institution,
        isLiability: a.isLiability,
        lastActivity: a.lastActivity,
      })),
    };
  }

  async listTransactions(ctx: WorkspaceContext, query: z.output<typeof publicTransactionQuery>) {
    const result = await this.transactions.list(ctx, { ...query, sort: "date_desc" });
    return { items: result.items.map(publicTransaction), total: result.total, page: result.page, pageSize: result.pageSize };
  }

  async createTransaction(ctx: WorkspaceContext, input: z.output<typeof publicTransactionInput>) {
    const { externalId, ...fields } = input;
    const result = await this.transactions.create(ctx, fields, {
      source: "api",
      sourceRef: ctx.apiKeyId ?? null,
      externalId: externalId ?? null,
      reviewReason: fields.status === "posted" ? null : "Received through the API: review before posting",
      metadata: { apiKeyId: ctx.apiKeyId ?? null },
    });
    return { duplicate: result.duplicate, transaction: publicTransaction(result.transaction) };
  }

  private async resolveNames(ctx: WorkspaceContext, category: string | null | undefined, project: string | null | undefined, kind: "income" | "expense") {
    const warnings: string[] = [];
    const categoryId = category ? ((await this.categories.resolveName(ctx, category, kind))?.id ?? null) : null;
    if (category && !categoryId) warnings.push(`No ${kind} category called "${category}"; left uncategorised`);
    const projectId = project ? ((await this.projects.resolveName(ctx, project))?.id ?? null) : null;
    if (project && !projectId) warnings.push(`No project called "${project}"; left unassigned`);
    return { categoryId, projectId, warnings };
  }

  private async record(
    ctx: WorkspaceContext,
    kind: "income" | "expense",
    input: z.output<typeof publicRevenueInput> | z.output<typeof publicExpenseInput>,
    counterparty: string | null | undefined,
    metadata: Record<string, unknown>,
  ) {
    if (input.status === "posted" && !input.account_id) throw unprocessable("A posted record needs account_id", "missing_account");
    const { categoryId, projectId, warnings } = await this.resolveNames(ctx, input.category, input.project, kind);
    const transaction: TransactionInput = {
      type: kind,
      direction: kind === "income" ? "in" : "out",
      status: input.status,
      accountId: input.account_id ?? null,
      amount: input.amountMinor,
      currency: input.currency,
      date: input.date,
      occurredAt: input.occurred_at ?? null,
      merchant: counterparty ?? null,
      categoryId,
      projectId,
      description: input.description ?? null,
      reference: input.reference ?? null,
    };
    const result = await this.transactions.create(ctx, transaction, {
      source: "api",
      sourceRef: ctx.apiKeyId ?? null,
      externalId: input.external_id,
      reviewReason:
        input.status === "posted"
          ? null
          : input.account_id
            ? "Received through the API: review before posting"
            : "Received through the API: choose the account",
      metadata: { ...input.metadata, ...metadata, apiKeyId: ctx.apiKeyId ?? null },
    });
    return {
      id: result.transaction.id,
      duplicate: result.duplicate,
      status: result.transaction.status,
      transaction: publicTransaction(result.transaction),
      warnings: result.duplicate ? [] : warnings,
    };
  }

  createRevenue(ctx: WorkspaceContext, input: z.output<typeof publicRevenueInput>) {
    return this.record(ctx, "income", { ...input, description: input.description ?? input.product ?? null }, input.customer, {
      source: input.source ?? null,
      customer: input.customer ?? null,
      product: input.product ?? null,
    });
  }

  createExpense(ctx: WorkspaceContext, input: z.output<typeof publicExpenseInput>) {
    return this.record(ctx, "expense", input, input.vendor, { vendor: input.vendor ?? null });
  }

  /** This month in the workspace's base currency, posted transactions only. */
  async summary(ctx: WorkspaceContext) {
    const day = todayFor(ctx);
    const from = startOfMonth(day);
    const to = endOfMonth(day);
    const result = await this.transactions.list(ctx, { from, to, status: ["posted"], pageSize: 1 });
    return {
      period: { from, to },
      currency: ctx.baseCurrency,
      income: result.totals.income,
      expense: result.totals.expense,
      net: result.totals.income - result.totals.expense,
      transactionCount: result.total,
    };
  }
}
