import {
  addDays,
  bulkTransactionAction,
  computeEntries,
  convertMinor,
  currencyDecimals,
  DUPLICATE_THRESHOLD,
  type DuplicateMatch,
  isDirectionAllowed,
  scoreDuplicate,
  type TransactionInput,
  type TransactionQuery,
  type TransactionSource,
  type TransactionUpdate,
  TYPE_RULES,
  transactionInput,
  transactionQuery,
  transactionUpdate,
} from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import {
  assets,
  auditLogs,
  categories,
  commitmentOccurrences,
  commitments,
  counterparties,
  files,
  financialAccounts,
  investments,
  ledgerEntries,
  liabilities,
  projects,
  receivables,
  transactionAttachments,
  transactions,
} from "../../db/schema/index.js";
import type { AiConfidence } from "../../db/schema/types.js";
import { AuditService } from "../system/audit.service.js";
import { EventsService } from "../system/events.service.js";
import { CategoriesService, CounterpartiesService } from "./catalog.service.js";
import { FxService } from "./fx.service.js";
import { assertInWorkspace } from "./references.js";

export type TransactionRow = typeof transactions.$inferSelect;
type Parsed = z.output<typeof transactionInput>;

export type CreateOptions = {
  /** Run inside the caller's database transaction. */
  exec?: Executor;
  source?: TransactionSource;
  sourceRef?: string | null;
  externalId?: string | null;
  connectionId?: string | null;
  aiConfidence?: AiConfidence | null;
  metadata?: Record<string, unknown>;
  reviewReason?: string | null;
  /** Skip merchant-memory learning (e.g. bulk imports). */
  skipLearning?: boolean;
};

export type CreateResult = { transaction: TransactionRow; duplicate: boolean };

/** The shape of a stored transaction as an input, for edits that merge changes. */
function rowToInput(row: TransactionRow): Parsed {
  return {
    type: row.type,
    direction: row.direction,
    status: row.status === "void" ? "posted" : row.status,
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    amount: row.amount,
    currency: row.currency,
    accountAmount: row.accountAmount,
    toAccountAmount: row.toAccountAmount,
    fxRate: row.fxRate,
    date: row.date,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    merchant: row.merchant,
    counterpartyId: row.counterpartyId,
    categoryId: row.categoryId,
    projectId: row.projectId,
    description: row.description,
    notes: row.notes,
    reference: row.reference,
    liabilityId: row.liabilityId,
    receivableId: row.receivableId,
    assetId: row.assetId,
    investmentId: row.investmentId,
    costBasis: row.costBasis,
    linkedTransactionId: row.linkedTransactionId,
  };
}

/** original → base rate implied by two amounts, to 10 decimals. */
function impliedRate(amount: number, currency: string, converted: number, target: string): string {
  const original = amount / 10 ** currencyDecimals(currency);
  const result = converted / 10 ** currencyDecimals(target);
  return (result / original).toFixed(10);
}

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(FxService) private readonly fx: FxService,
    @Inject(CounterpartiesService) private readonly counterparties: CounterpartiesService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
  ) {}

  private run<T>(exec: Executor | undefined, work: (tx: Executor) => Promise<T>): Promise<T> {
    return exec ? work(exec) : db.transaction((tx) => work(tx));
  }

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<TransactionRow> {
    const [row] = await exec
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Transaction");
  }

  /**
   * Validates references and resolves amounts. Returns the columns to store
   * and, for posted transactions, the ledger entries.
   */
  private async prepare(tx: Executor, ctx: WorkspaceContext, input: Parsed) {
    const ws = ctx.workspaceId;
    const direction = input.direction ?? TYPE_RULES[input.type].defaultDirection;
    if (!isDirectionAllowed(input.type, direction)) {
      const noun = input.type.replace("_", " ");
      throw unprocessable(`${/^[aeiou]/.test(noun) ? "An" : "A"} ${noun} cannot be money ${direction}`, "invalid_direction");
    }
    const posted = input.status === "posted";

    await assertInWorkspace(tx, financialAccounts, ws, [input.accountId, input.toAccountId], "Account");
    await assertInWorkspace(tx, categories, ws, [input.categoryId], "Category");
    await assertInWorkspace(tx, projects, ws, [input.projectId], "Project");
    await assertInWorkspace(tx, counterparties, ws, [input.counterpartyId], "Counterparty");
    await assertInWorkspace(tx, liabilities, ws, [input.liabilityId], "Liability");
    await assertInWorkspace(tx, receivables, ws, [input.receivableId], "Receivable");
    await assertInWorkspace(tx, assets, ws, [input.assetId], "Asset");
    await assertInWorkspace(tx, investments, ws, [input.investmentId], "Investment");
    await assertInWorkspace(tx, transactions, ws, [input.linkedTransactionId], "Linked transaction");
    await assertInWorkspace(tx, files, ws, input.attachmentFileIds ?? [], "Attachment");

    if (input.categoryId) {
      const [category] = await tx.select({ kind: categories.kind }).from(categories).where(eq(categories.id, input.categoryId));
      const expected =
        input.type === "income" || (input.type === "refund" && direction === "out")
          ? "income"
          : input.type === "expense" || input.type === "refund"
            ? "expense"
            : null;
      if (expected && category && category.kind !== expected) {
        throw unprocessable(`That is ${category.kind === "income" ? "an income" : "an expense"} category`, "category_kind_mismatch");
      }
    }

    if (input.type === "transfer" && posted && !input.toAccountId) {
      throw unprocessable("A transfer needs the account the money went to", "missing_destination");
    }
    if (posted && !input.accountId) throw unprocessable("Choose the account this money moved through", "missing_account");

    const loadAccount = async (id: string | null | undefined) => {
      if (!id) return null;
      const [account] = await tx.select().from(financialAccounts).where(eq(financialAccounts.id, id));
      if (account && account.status === "archived" && posted) throw unprocessable(`${account.name} is archived`, "account_archived");
      return account ?? null;
    };
    const account = await loadAccount(input.accountId);
    const toAccount = input.type === "transfer" ? await loadAccount(input.toAccountId) : null;

    // Amount in the account's currency.
    let accountAmount: number | null = input.accountAmount ?? null;
    if (account) {
      if (account.currency === input.currency) accountAmount = input.amount;
      else if (accountAmount === null) {
        accountAmount = (await this.fx.convert(input.amount, input.currency, account.currency, input.date, ws, tx)).amount;
      }
    }

    // Amount in the workspace base currency, and the rate behind it.
    let baseAmount: number | null = null;
    let fxRate: string | null = null;
    if (input.currency === ctx.baseCurrency) {
      baseAmount = input.amount;
      fxRate = "1";
    } else if (input.fxRate) {
      baseAmount = convertMinor(input.amount, input.currency, ctx.baseCurrency, input.fxRate);
      fxRate = input.fxRate;
    } else if (account && account.currency === ctx.baseCurrency && accountAmount !== null) {
      // What the account was actually charged is the truest conversion.
      baseAmount = accountAmount;
      fxRate = impliedRate(input.amount, input.currency, accountAmount, ctx.baseCurrency);
    } else {
      const rate = await this.fx.rate(input.currency, ctx.baseCurrency, input.date, ws, tx);
      if (rate) {
        baseAmount = convertMinor(input.amount, input.currency, ctx.baseCurrency, rate);
        fxRate = rate;
      } else if (posted) {
        throw unprocessable(
          `No ${input.currency}→${ctx.baseCurrency} exchange rate for ${input.date}. Add one in Settings → Currency.`,
          "missing_exchange_rate",
        );
      }
    }

    let toAccountAmount: number | null = input.toAccountAmount ?? null;
    if (toAccount && toAccountAmount === null) {
      if (account && toAccount.currency === account.currency) toAccountAmount = accountAmount;
      else if (toAccount.currency === input.currency) toAccountAmount = input.amount;
      else toAccountAmount = (await this.fx.convert(input.amount, input.currency, toAccount.currency, input.date, ws, tx)).amount;
    }

    let counterpartyId = input.counterpartyId ?? null;
    if (!counterpartyId && input.merchant && input.type !== "transfer") {
      const kind = input.type === "income" ? "customer" : "merchant";
      counterpartyId = (await this.counterparties.findOrCreate(tx, ws, input.merchant, kind))?.id ?? null;
    }

    const entries =
      posted && account && accountAmount !== null && baseAmount !== null
        ? computeEntries({
            type: input.type,
            direction,
            accountId: account.id,
            accountCurrency: account.currency,
            accountAmount,
            baseAmount,
            toAccountId: toAccount?.id,
            toAccountCurrency: toAccount?.currency,
            toAccountAmount,
            date: input.date,
          })
        : [];

    return {
      values: {
        type: input.type,
        direction,
        status: input.status,
        accountId: input.accountId ?? null,
        toAccountId: input.type === "transfer" ? (input.toAccountId ?? null) : null,
        amount: input.amount,
        currency: input.currency,
        accountAmount,
        toAccountAmount: input.type === "transfer" ? toAccountAmount : null,
        fxRate,
        baseAmount,
        baseCurrency: ctx.baseCurrency,
        date: input.date,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
        merchant: input.merchant ?? null,
        counterpartyId,
        categoryId: input.type === "transfer" ? null : (input.categoryId ?? null),
        projectId: input.projectId ?? null,
        description: input.description ?? null,
        notes: input.notes ?? null,
        reference: input.reference ?? null,
        liabilityId: input.liabilityId ?? null,
        receivableId: input.receivableId ?? null,
        assetId: input.assetId ?? null,
        investmentId: input.investmentId ?? null,
        costBasis: input.costBasis ?? null,
        linkedTransactionId: input.linkedTransactionId ?? null,
      },
      entries,
    };
  }

  private async writeEntries(
    tx: Executor,
    ctx: WorkspaceContext,
    transactionId: string,
    entries: Awaited<ReturnType<TransactionsService["prepare"]>>["entries"],
  ) {
    if (!entries.length) return;
    await tx.insert(ledgerEntries).values(entries.map((entry) => ({ workspaceId: ctx.workspaceId, transactionId, ...entry })));
  }

  async create(ctx: WorkspaceContext, raw: TransactionInput, options: CreateOptions = {}): Promise<CreateResult> {
    const input = transactionInput.parse(raw);
    const source = options.source ?? (ctx.actorType === "api" ? "api" : "manual");
    const externalKey = options.externalId ? `${source}:${options.connectionId ?? "-"}:${options.externalId}` : null;

    return this.run(options.exec, async (tx) => {
      if (externalKey) {
        const [existing] = await tx
          .select()
          .from(transactions)
          .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.externalKey, externalKey)))
          .limit(1);
        if (existing) return { transaction: existing, duplicate: true };
      }

      let status = input.status;
      let reviewReason = options.reviewReason ?? null;
      const prepared = await this.prepare(tx, ctx, input);
      const threshold = ctx.settings.reviewThreshold;
      // A person entering a transaction is its confirmation; anything else
      // above the review threshold waits for one.
      if (status === "posted" && ctx.actorType !== "user" && threshold && (prepared.values.baseAmount ?? 0) >= threshold) {
        status = "pending";
        reviewReason ??= "Above your review threshold";
      }
      const entries = status === "posted" ? prepared.entries : [];

      const [row] = await tx
        .insert(transactions)
        .values({
          workspaceId: ctx.workspaceId,
          ...prepared.values,
          status,
          source,
          sourceRef: options.sourceRef ?? null,
          externalId: options.externalId ?? null,
          externalKey,
          connectionId: options.connectionId ?? null,
          aiConfidence: options.aiConfidence ?? null,
          metadata: options.metadata ?? {},
          reviewReason,
          attachmentFileId: input.attachmentFileIds?.[0] ?? null,
          createdBy: ctx.userId,
          postedAt: status === "posted" ? new Date() : null,
        })
        .onConflictDoNothing()
        .returning();

      if (!row) {
        // Lost a race with a concurrent import of the same record.
        const [existing] = await tx
          .select()
          .from(transactions)
          .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.externalKey, externalKey ?? "")))
          .limit(1);
        return { transaction: assertFound(existing, "Transaction"), duplicate: true };
      }

      await this.writeEntries(tx, ctx, row.id, entries);
      if (input.attachmentFileIds?.length) {
        await tx.insert(transactionAttachments).values(input.attachmentFileIds.map((fileId) => ({ transactionId: row.id, fileId })));
      }
      if (!options.skipLearning && ctx.actorType === "user" && status === "posted" && row.counterpartyId && row.categoryId) {
        await this.counterparties.learn(tx, row.counterpartyId, row.categoryId, row.projectId);
      }

      await this.audit.record(tx, ctx, {
        action: source === "integration" || source === "csv" || source === "excel" ? "transaction.imported" : "transaction.created",
        entityType: "transaction",
        entityId: row.id,
        after: row,
        source,
      });
      await this.events.publish(tx, ctx, externalKey ? "transaction.imported" : "transaction.created", {
        transactionId: row.id,
        status: row.status,
        type: row.type,
        source,
      });
      return { transaction: row, duplicate: false };
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: TransactionUpdate, options: { exec?: Executor } = {}): Promise<TransactionRow> {
    const changes = transactionUpdate.parse(raw);
    return this.run(options.exec, async (tx) => {
      const before = await this.get(ctx, id, tx);
      if (before.status === "void") throw conflict("A voided transaction cannot be edited", "voided");

      const { reason, ...fields } = changes;
      const merged = { ...rowToInput(before), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) } as Parsed;
      // A new amount or currency invalidates derived amounts unless restated.
      if (fields.amount !== undefined || fields.currency !== undefined || fields.accountId !== undefined || fields.date !== undefined) {
        if (fields.accountAmount === undefined) merged.accountAmount = null;
        if (fields.toAccountAmount === undefined) merged.toAccountAmount = null;
        if (fields.fxRate === undefined) merged.fxRate = null;
      }
      const input = transactionInput.parse(merged);
      const prepared = await this.prepare(tx, ctx, input);

      const [row] = await tx
        .update(transactions)
        .set({
          ...prepared.values,
          reviewReason: input.status === "posted" ? null : before.reviewReason,
          postedAt: input.status === "posted" ? (before.postedAt ?? new Date()) : null,
          // The first attachment is the one lists show (the paperclip); keep it in step with the set.
          ...(fields.attachmentFileIds ? { attachmentFileId: fields.attachmentFileIds[0] ?? null } : {}),
        })
        .where(eq(transactions.id, id))
        .returning();

      await tx.delete(ledgerEntries).where(eq(ledgerEntries.transactionId, id));
      if (input.status === "posted") await this.writeEntries(tx, ctx, id, prepared.entries);
      if (fields.attachmentFileIds) {
        await tx.delete(transactionAttachments).where(eq(transactionAttachments.transactionId, id));
        if (fields.attachmentFileIds.length) {
          await tx.insert(transactionAttachments).values(fields.attachmentFileIds.map((fileId) => ({ transactionId: id, fileId })));
        }
      }
      const confirmed = before.status !== "posted" && input.status === "posted";
      if (ctx.actorType === "user" && input.status === "posted" && row?.counterpartyId && row.categoryId) {
        await this.counterparties.learn(tx, row.counterpartyId, row.categoryId, row.projectId);
      }

      await this.audit.record(tx, ctx, {
        action: confirmed ? "transaction.confirmed" : before.amount !== row?.amount ? "transaction.amount_changed" : "transaction.updated",
        entityType: "transaction",
        entityId: id,
        before,
        after: { ...row, reason },
      });
      await this.events.publish(tx, ctx, confirmed ? "transaction.confirmed" : "transaction.updated", {
        transactionId: id,
        previousStatus: before.status,
        status: row?.status,
      });
      return row as TransactionRow;
    });
  }

  confirm(ctx: WorkspaceContext, id: string, changes: TransactionUpdate = {}, options: { exec?: Executor } = {}) {
    return this.update(ctx, id, { ...changes, status: "posted" }, options);
  }

  /**
   * Reverses a transaction: its ledger entries go, the row stays (void) for
   * the audit trail and so an integration never re-imports it.
   */
  async void(ctx: WorkspaceContext, id: string, reason?: string, options: { exec?: Executor } = {}) {
    return this.run(options.exec, async (tx) => {
      const before = await this.get(ctx, id, tx);
      if (before.status === "void") return before;
      if (before.status === "draft" && !before.externalKey) {
        await tx.delete(transactions).where(eq(transactions.id, id));
        await this.audit.record(tx, ctx, { action: "transaction.deleted", entityType: "transaction", entityId: id, before });
        return { ...before, status: "void" as const };
      }
      await tx.delete(ledgerEntries).where(eq(ledgerEntries.transactionId, id));
      const [row] = await tx
        .update(transactions)
        .set({ status: "void", voidedAt: new Date(), reviewReason: reason ?? null })
        .where(eq(transactions.id, id))
        .returning();
      await this.audit.record(tx, ctx, { action: "transaction.deleted", entityType: "transaction", entityId: id, before, after: { reason } });
      await this.events.publish(tx, ctx, "transaction.voided", { transactionId: id, previousStatus: before.status });
      return row as TransactionRow;
    });
  }

  private async conditions(ctx: WorkspaceContext, query: z.output<typeof transactionQuery>): Promise<SQL[]> {
    const where: SQL[] = [eq(transactions.workspaceId, ctx.workspaceId)];
    if (query.status?.length) where.push(inArray(transactions.status, query.status));
    else where.push(ne(transactions.status, "void"));
    if (query.from) where.push(gte(transactions.date, query.from));
    if (query.to) where.push(lte(transactions.date, query.to));
    if (query.type?.length) where.push(inArray(transactions.type, query.type));
    if (query.source?.length) where.push(inArray(transactions.source, query.source));
    if (query.ids?.length) where.push(inArray(transactions.id, query.ids));
    if (query.accountId) where.push(or(eq(transactions.accountId, query.accountId), eq(transactions.toAccountId, query.accountId)) as SQL);
    if (query.categoryId === "none") where.push(isNull(transactions.categoryId));
    else if (query.categoryId) {
      const ids = query.includeChildren ? await this.categories.withDescendants(ctx.workspaceId, query.categoryId) : [query.categoryId];
      where.push(inArray(transactions.categoryId, ids));
    }
    if (query.projectId === "none") where.push(isNull(transactions.projectId));
    else if (query.projectId) where.push(eq(transactions.projectId, query.projectId));
    if (query.counterpartyId) where.push(eq(transactions.counterpartyId, query.counterpartyId));
    if (query.commitmentId) {
      where.push(
        inArray(
          transactions.id,
          db
            .select({ id: sql<string>`${commitmentOccurrences.transactionId}` })
            .from(commitmentOccurrences)
            .where(and(eq(commitmentOccurrences.commitmentId, query.commitmentId), sql`${commitmentOccurrences.transactionId} is not null`)),
        ),
      );
    }
    if (query.minAmount !== undefined) where.push(gte(transactions.baseAmount, query.minAmount));
    if (query.maxAmount !== undefined) where.push(lte(transactions.baseAmount, query.maxAmount));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      where.push(
        or(
          ilike(transactions.merchant, needle),
          ilike(transactions.description, needle),
          ilike(transactions.notes, needle),
          ilike(transactions.reference, needle),
          inArray(
            transactions.counterpartyId,
            db
              .select({ id: counterparties.id })
              .from(counterparties)
              .where(and(eq(counterparties.workspaceId, ctx.workspaceId), ilike(counterparties.name, needle))),
          ),
        ) as SQL,
      );
    }
    return where;
  }

  async list(ctx: WorkspaceContext, raw: TransactionQuery) {
    const query = transactionQuery.parse(raw);
    const where = and(...(await this.conditions(ctx, query)));
    const toAccount = alias(financialAccounts, "to_account");
    const order =
      query.sort === "date_asc"
        ? [asc(transactions.date), asc(transactions.createdAt)]
        : query.sort === "amount_desc"
          ? [desc(transactions.baseAmount)]
          : query.sort === "amount_asc"
            ? [asc(transactions.baseAmount)]
            : query.sort === "created_desc"
              ? [desc(transactions.createdAt)]
              : [desc(transactions.date), desc(transactions.createdAt)];

    const [items, [totals]] = await Promise.all([
      db
        .select({
          transaction: transactions,
          accountName: financialAccounts.name,
          accountCurrency: financialAccounts.currency,
          toAccountName: toAccount.name,
          categoryName: categories.name,
          categoryIcon: categories.icon,
          categoryColor: categories.color,
          projectName: projects.name,
          projectColor: projects.color,
          counterpartyName: counterparties.name,
        })
        .from(transactions)
        .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
        .leftJoin(toAccount, eq(toAccount.id, transactions.toAccountId))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
        .where(where)
        .orderBy(...order)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db
        .select({
          count: count(),
          income: sql<string>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.baseAmount} when ${transactions.type} = 'refund' and ${transactions.direction} = 'out' then -${transactions.baseAmount} else 0 end), 0)`,
          expense: sql<string>`coalesce(sum(case when ${transactions.type} = 'expense' then ${transactions.baseAmount} when ${transactions.type} = 'refund' and ${transactions.direction} = 'in' then -${transactions.baseAmount} else 0 end), 0)`,
          moneyIn: sql<string>`coalesce(sum(case when ${transactions.direction} = 'in' and ${transactions.type} <> 'transfer' then ${transactions.baseAmount} else 0 end), 0)`,
          moneyOut: sql<string>`coalesce(sum(case when ${transactions.direction} = 'out' and ${transactions.type} <> 'transfer' then ${transactions.baseAmount} else 0 end), 0)`,
        })
        .from(transactions)
        .where(where),
    ]);

    return {
      items: items.map((row) => ({
        ...row.transaction,
        accountName: row.accountName,
        accountCurrency: row.accountCurrency,
        toAccountName: row.toAccountName,
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        categoryColor: row.categoryColor,
        projectName: row.projectName,
        projectColor: row.projectColor,
        counterpartyName: row.counterpartyName,
      })),
      total: totals?.count ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      totals: {
        income: Number(totals?.income ?? 0),
        expense: Number(totals?.expense ?? 0),
        moneyIn: Number(totals?.moneyIn ?? 0),
        moneyOut: Number(totals?.moneyOut ?? 0),
        currency: ctx.baseCurrency,
      },
    };
  }

  /** Everything behind one transaction: entries, attachments, links, history. */
  async detail(ctx: WorkspaceContext, id: string) {
    const row = await this.get(ctx, id);
    const [listed] = (await this.list(ctx, { ids: [id], status: [row.status], pageSize: 1 })).items;
    const [entries, attachments, history, occurrence, duplicates] = await Promise.all([
      db
        .select({ entry: ledgerEntries, accountName: financialAccounts.name })
        .from(ledgerEntries)
        .innerJoin(financialAccounts, eq(financialAccounts.id, ledgerEntries.accountId))
        .where(eq(ledgerEntries.transactionId, id)),
      db
        .select({ id: files.id, filename: files.filename, contentType: files.contentType, size: files.size })
        .from(transactionAttachments)
        .innerJoin(files, eq(files.id, transactionAttachments.fileId))
        .where(eq(transactionAttachments.transactionId, id)),
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.workspaceId, ctx.workspaceId), eq(auditLogs.entityType, "transaction"), eq(auditLogs.entityId, id)))
        .orderBy(asc(auditLogs.createdAt)),
      db
        .select({ occurrence: commitmentOccurrences, commitmentName: commitments.name, commitmentKind: commitments.kind })
        .from(commitmentOccurrences)
        .innerJoin(commitments, eq(commitments.id, commitmentOccurrences.commitmentId))
        .where(eq(commitmentOccurrences.transactionId, id))
        .limit(1),
      row.status === "void" ? Promise.resolve([]) : this.findDuplicates(ctx, row),
    ]);
    return {
      ...(listed ?? row),
      entries: entries.map((e) => ({ ...e.entry, accountName: e.accountName })),
      attachments,
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        actorType: h.actorType,
        actorId: h.actorId,
        createdAt: h.createdAt,
        source: h.source,
        before: h.before,
        after: h.after,
      })),
      commitment: occurrence[0] ? { ...occurrence[0].occurrence, name: occurrence[0].commitmentName, kind: occurrence[0].commitmentKind } : null,
      possibleDuplicates: duplicates,
    };
  }

  /**
   * Candidates that may be the same money: an exact wallet/bank reference, or
   * the same amount and currency within three days, scored by merchant and
   * account as well.
   */
  async findDuplicates(
    ctx: WorkspaceContext,
    subject: {
      id?: string;
      date: string;
      amount: number;
      currency: string;
      merchant?: string | null;
      accountId?: string | null;
      reference?: string | null;
      externalKey?: string | null;
    },
    exec: Executor = db,
  ): Promise<Array<DuplicateMatch & { transaction: TransactionRow }>> {
    const tolerance = Math.max(1, Math.round(subject.amount * 0.01));
    const pool = await exec
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          ne(transactions.status, "void"),
          subject.id ? ne(transactions.id, subject.id) : undefined,
          or(
            subject.reference ? eq(transactions.reference, subject.reference) : sql`false`,
            and(
              eq(transactions.currency, subject.currency),
              gte(transactions.amount, subject.amount - tolerance),
              lte(transactions.amount, subject.amount + tolerance),
              gte(transactions.date, addDays(subject.date, -3)),
              lte(transactions.date, addDays(subject.date, 3)),
            ),
          ),
        ),
      )
      .limit(25);
    const occurrenceLinks = pool.length
      ? await exec
          .select({ transactionId: commitmentOccurrences.transactionId })
          .from(commitmentOccurrences)
          .where(
            inArray(
              commitmentOccurrences.transactionId,
              pool.map((p) => p.id),
            ),
          )
      : [];
    const linked = new Set(occurrenceLinks.map((o) => o.transactionId));
    return pool
      .map((candidate) => ({
        transaction: candidate,
        id: candidate.id,
        ...scoreDuplicate(subject, {
          id: candidate.id,
          date: candidate.date,
          amount: candidate.amount,
          currency: candidate.currency,
          merchant: candidate.merchant,
          accountId: candidate.accountId,
          reference: candidate.reference,
          externalKey: candidate.externalKey,
          occurrenceId: linked.has(candidate.id) ? candidate.id : null,
        }),
      }))
      .filter((match) => match.exact || match.score >= DUPLICATE_THRESHOLD)
      .sort((a, b) => b.score - a.score);
  }

  async bulk(ctx: WorkspaceContext, raw: z.input<typeof bulkTransactionAction>) {
    const input = bulkTransactionAction.parse(raw);
    let changed = 0;
    const failures: Array<{ id: string; message: string }> = [];
    for (const id of input.ids) {
      try {
        if (input.action === "post") await this.confirm(ctx, id);
        else if (input.action === "void" || input.action === "delete_drafts") await this.void(ctx, id, "Bulk action");
        else if (input.action === "categorize") await this.update(ctx, id, { categoryId: input.categoryId ?? null });
        else if (input.action === "assign_project") await this.update(ctx, id, { projectId: input.projectId ?? null });
        changed++;
      } catch (error) {
        failures.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { changed, failures };
  }
}
