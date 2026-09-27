import { formatMoney, isUuid, LedgerError, normalizeName, type TransactionInput, type TransactionType } from "@expensewise/core";
import { type CanonicalRecord, type CanonicalRecordInput, canonicalRecord } from "@expensewise/core/contracts/integrations-extra";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { DomainError } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { categories, financialAccounts, projects, receivables, transactions } from "../../db/schema/index.js";
import type { SyncErrorDetail } from "../../db/schema/types.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { CategoriesService, CounterpartiesService, ProjectsService, RulesService } from "../ledger/catalog.service.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { InboxService } from "../system/notify.service.js";
import type { AnyConnector, ConnectionInfo, RawRecord } from "./connectors/types.js";
import { ConnectorError } from "./connectors/types.js";
import type { ConnectionRow } from "./store.js";

/** One line of a sync run's log. Stored in `sync_run.error_details`. */
export type RunDetail = SyncErrorDetail & {
  kind: "error" | "skipped" | "review" | "balance";
  transactionId?: string;
  accountId?: string | null;
  balance?: number;
  currency?: string;
  asOf?: string;
  bookBalance?: number | null;
  difference?: number | null;
};

const DETAIL_CAP = 100;
const BALANCE_CAP = 20;

/**
 * What a run saw. found = created + updated + skipped + duplicates + errors;
 * balances are reported separately and not counted as records.
 */
export class RunLog {
  found = 0;
  created = 0;
  updated = 0;
  skipped = 0;
  duplicates = 0;
  errors = 0;
  private readonly errorDetails: RunDetail[] = [];
  private readonly skipDetails: RunDetail[] = [];
  private readonly reviewDetails: RunDetail[] = [];
  private readonly balanceDetails: RunDetail[] = [];

  error(externalId: string | undefined, message: string) {
    this.errors++;
    if (this.errorDetails.length < DETAIL_CAP) this.errorDetails.push({ kind: "error", externalId, message: message.slice(0, 500) });
  }

  skip(externalId: string | undefined, reason: string) {
    this.skipped++;
    if (this.skipDetails.length < DETAIL_CAP) this.skipDetails.push({ kind: "skipped", externalId, message: reason.slice(0, 300) });
  }

  review(externalId: string, message: string, transactionId: string) {
    if (this.reviewDetails.length < DETAIL_CAP) this.reviewDetails.push({ kind: "review", externalId, message: message.slice(0, 300), transactionId });
  }

  balance(detail: Omit<RunDetail, "kind">) {
    if (this.balanceDetails.length < BALANCE_CAP) this.balanceDetails.push({ kind: "balance", ...detail });
  }

  get firstError(): string | null {
    return this.errorDetails[0]?.message ?? null;
  }

  details(): RunDetail[] {
    return [...this.errorDetails, ...this.skipDetails, ...this.reviewDetails, ...this.balanceDetails];
  }
}

export type IngestScope = {
  ctx: WorkspaceContext;
  connection: ConnectionRow;
  /** The connector's parsed config for this connection. */
  config: Record<string, unknown>;
  runId: string;
};

const USER_FACING = [DomainError, LedgerError, ConnectorError];

/** A message safe to show in the sync log. Unexpected errors are logged, not echoed. */
export function recordErrorMessage(error: unknown, logger?: Logger): string {
  if (USER_FACING.some((type) => error instanceof type)) return (error as Error).message;
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
      .join("; ");
  }
  const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  if (code === "23505") return "A record with these details already exists";
  if (code === "23503") return "The record points at something that no longer exists";
  logger?.warn(error instanceof Error ? (error.stack ?? error.message) : String(error));
  return "Unexpected error while importing this record";
}

function guessExternalId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const direct =
    record.externalId ?? record.id ?? (record.item as Record<string, unknown> | undefined)?.id ?? (record.object as Record<string, unknown> | undefined)?.id;
  return typeof direct === "string" || typeof direct === "number" ? String(direct).slice(0, 200) : undefined;
}

type MoneyDraft = {
  externalId: string;
  type: TransactionType;
  direction?: "in" | "out";
  amount: number;
  currency: string;
  date: string;
  occurredAt?: string | null;
  description?: string | null;
  counterparty?: string | null;
  categoryHint?: string | null;
  projectHint?: string | null;
  accountRef?: string | null;
  toAccountRef?: string | null;
  reference?: string | null;
  metadata: Record<string, unknown>;
};

function toMoneyDraft(record: Extract<CanonicalRecord, { kind: "transaction" | "revenue" | "expense" }>): MoneyDraft {
  if (record.kind === "revenue") {
    return {
      externalId: record.externalId,
      type: "income",
      direction: "in",
      amount: record.amount,
      currency: record.currency,
      date: record.date,
      occurredAt: record.occurredAt,
      description: record.description ?? record.product ?? null,
      counterparty: record.customer,
      categoryHint: record.categoryHint,
      projectHint: record.project,
      accountRef: record.accountRef,
      reference: record.reference,
      metadata: { ...record.metadata, source: record.source ?? null, customer: record.customer ?? null, product: record.product ?? null },
    };
  }
  if (record.kind === "expense") {
    return {
      externalId: record.externalId,
      type: "expense",
      direction: "out",
      amount: record.amount,
      currency: record.currency,
      date: record.date,
      occurredAt: record.occurredAt,
      description: record.description,
      counterparty: record.vendor,
      categoryHint: record.categoryHint,
      projectHint: record.project,
      accountRef: record.accountRef,
      reference: record.reference,
      metadata: record.metadata,
    };
  }
  return { ...record };
}

/** The category kind a transaction of this type and direction may carry, if any. */
function categoryKindFor(type: TransactionType, direction: "in" | "out" | undefined): "income" | "expense" | null {
  if (type === "income") return "income";
  if (type === "expense") return "expense";
  if (type === "refund") return direction === "out" ? "income" : "expense";
  return null;
}

/** Per-run lookups, so a page of records does not re-query the catalogue per row. */
class Resolver {
  private accountIds: Map<string, { currency: string; openingBalance: number; openingDate: string }> | null = null;
  private categoryKinds: Map<string, "income" | "expense"> | null = null;
  private readonly categoryByName = new Map<string, string | null>();
  private readonly projectByName = new Map<string, string | null>();

  constructor(
    private readonly scope: IngestScope,
    private readonly services: { categories: CategoriesService; projects: ProjectsService },
  ) {}

  async accounts() {
    if (!this.accountIds) {
      const rows = await db
        .select({
          id: financialAccounts.id,
          currency: financialAccounts.currency,
          openingBalance: financialAccounts.openingBalance,
          openingDate: financialAccounts.openingDate,
        })
        .from(financialAccounts)
        .where(eq(financialAccounts.workspaceId, this.scope.ctx.workspaceId));
      this.accountIds = new Map(rows.map((row) => [row.id, row]));
    }
    return this.accountIds;
  }

  /**
   * An account reference from the source: `@connection`, a key of the
   * connection's `accountMap`, or an account id in this workspace.
   */
  async account(ref: string | null | undefined, fallback: string | null): Promise<string | null> {
    if (!ref) return fallback;
    const accounts = await this.accounts();
    if (ref === "@connection") return this.scope.connection.accountId;
    const map = this.scope.config.accountMap;
    const mapped = map && typeof map === "object" ? (map as Record<string, unknown>)[ref] : undefined;
    if (typeof mapped === "string" && accounts.has(mapped)) return mapped;
    if (isUuid(ref) && accounts.has(ref)) return ref;
    return fallback;
  }

  async categoryKind(id: string): Promise<"income" | "expense" | null> {
    if (!this.categoryKinds) {
      const rows = await db.select({ id: categories.id, kind: categories.kind }).from(categories).where(eq(categories.workspaceId, this.scope.ctx.workspaceId));
      this.categoryKinds = new Map(rows.map((row) => [row.id, row.kind]));
    }
    return this.categoryKinds.get(id) ?? null;
  }

  async category(hint: string | null | undefined, kind: "income" | "expense"): Promise<string | null> {
    if (!hint) return null;
    const key = `${kind}:${normalizeName(hint)}`;
    if (!this.categoryByName.has(key)) {
      this.categoryByName.set(key, (await this.services.categories.resolveName(this.scope.ctx, hint, kind))?.id ?? null);
    }
    return this.categoryByName.get(key) ?? null;
  }

  async project(hint: string | null | undefined): Promise<string | null> {
    if (!hint) return null;
    const key = normalizeName(hint);
    if (!this.projectByName.has(key)) this.projectByName.set(key, (await this.services.projects.resolveName(this.scope.ctx, hint))?.id ?? null);
    return this.projectByName.get(key) ?? null;
  }
}

/**
 * The one path from a provider's records into Expense Wise, shared by syncs
 * and webhooks: normalize → validate → rules → hints → dedupe → ledger.
 * Every record is processed on its own, so one bad record never fails the
 * rest.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger("IntegrationPipeline");

  constructor(
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(CounterpartiesService) private readonly counterparties: CounterpartiesService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Raw provider records to canonical ones; a record the connector cannot read is logged, not fatal. */
  normalize(connector: AnyConnector, raws: RawRecord[], connection: ConnectionInfo & { config: unknown }, log: RunLog): CanonicalRecordInput[] {
    const out: CanonicalRecordInput[] = [];
    for (const raw of raws) {
      try {
        const result = connector.normalize(raw, connection);
        if (result === null || result === undefined) {
          log.found++;
          log.skip(guessExternalId(raw), "Not an importable record");
          continue;
        }
        out.push(...(Array.isArray(result) ? result : [result]));
      } catch (error) {
        log.found++;
        log.error(guessExternalId(raw), recordErrorMessage(error, this.logger));
      }
    }
    return out;
  }

  async ingest(scope: IngestScope, records: CanonicalRecordInput[], log: RunLog): Promise<void> {
    const resolver = new Resolver(scope, { categories: this.categories, projects: this.projects });
    for (const input of records) {
      const parsed = canonicalRecord.safeParse(input);
      if (!parsed.success) {
        if (input?.kind !== "balance") log.found++;
        log.error(guessExternalId(input), `Invalid ${input?.kind ?? "record"}: ${recordErrorMessage(parsed.error)}`);
        continue;
      }
      const record = parsed.data;
      if (record.kind === "balance") {
        await this.recordBalance(scope, record, resolver, log).catch((error) =>
          this.logger.warn(`Balance check failed: ${recordErrorMessage(error, this.logger)}`),
        );
        continue;
      }
      log.found++;
      if (record.kind === "skip") {
        log.skip(record.externalId, record.reason);
        continue;
      }
      try {
        if (record.kind === "project") await this.upsertProject(scope, record, log);
        else if (record.kind === "receivable") await this.upsertReceivable(scope, record, resolver, log);
        else await this.importMoney(scope, toMoneyDraft(record), resolver, log);
      } catch (error) {
        log.error(record.externalId, recordErrorMessage(error, this.logger));
      }
    }
  }

  private async importMoney(scope: IngestScope, draft: MoneyDraft, resolver: Resolver, log: RunLog) {
    const { ctx, connection } = scope;
    const externalKey = `integration:${connection.id}:${draft.externalId}`;
    const [existing] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.externalKey, externalKey)))
      .limit(1);
    if (existing) {
      log.duplicates++;
      return;
    }

    const baseAccount = await resolver.account(draft.accountRef, connection.accountId);
    const outcome = await this.rules.evaluate(ctx, {
      merchant: draft.counterparty,
      description: draft.description,
      amount: draft.amount,
      currency: draft.currency,
      accountId: baseAccount,
      source: "integration",
      type: draft.type,
      reference: draft.reference,
    });
    if (outcome.actions.ignore) {
      log.skip(draft.externalId, "Ignored by one of your rules");
      return;
    }

    let type = draft.type;
    let direction = draft.direction;
    if (outcome.actions.type && outcome.actions.type !== type) {
      type = outcome.actions.type;
      direction = undefined;
    }
    const merchant = outcome.actions.merchant ?? draft.counterparty ?? null;
    const accountId = outcome.actions.accountId && (await resolver.account(outcome.actions.accountId, null)) ? outcome.actions.accountId : baseAccount;
    const toAccountId = type === "transfer" ? await resolver.account(draft.toAccountRef, null) : null;

    const kind = categoryKindFor(type, direction);
    let categoryId: string | null = null;
    if (kind) {
      const candidates = [outcome.actions.categoryId ?? null, await resolver.category(draft.categoryHint, kind)];
      if (!candidates.some(Boolean) && merchant) {
        // Merchant memory: a merchant whose category the user confirmed before.
        const known = await this.counterparties.match(db, ctx.workspaceId, merchant);
        candidates.push(known?.defaultCategoryId ?? null);
      }
      for (const candidate of candidates) {
        if (candidate && (await resolver.categoryKind(candidate)) === kind) {
          categoryId = candidate;
          break;
        }
      }
    }
    const projectId = outcome.actions.projectId ?? (await resolver.project(draft.projectHint)) ?? connection.projectId ?? null;

    // The external key (built as TransactionsService builds it) lets the scorer
    // tell two distinct records from the same source apart, however alike.
    const matches = (
      await this.transactions.findDuplicates(ctx, {
        date: draft.date,
        amount: draft.amount,
        currency: draft.currency,
        merchant,
        accountId,
        reference: draft.reference,
        externalKey,
      })
    ).filter((match) => match.transaction.connectionId !== connection.id);
    const match = matches[0] ?? null;

    let reviewReason: string | null = null;
    if (match) {
      reviewReason = `Possible duplicate of a transaction recorded on ${match.transaction.date} (${match.reasons.join(", ").toLowerCase()})`;
    } else if (outcome.actions.requireReview) {
      reviewReason = "One of your rules asks to review this";
    } else if (!accountId) {
      reviewReason = `Choose the account this ${connection.name} record belongs to`;
    } else if (type === "transfer" && !toAccountId) {
      reviewReason = "Choose the account this transfer went to";
    } else if (connection.trustLevel !== "trusted") {
      reviewReason = `Imported from ${connection.name}: review before posting`;
    }
    const post = reviewReason === null;

    const input: TransactionInput = {
      type,
      direction,
      status: post ? "posted" : "draft",
      accountId,
      toAccountId,
      amount: draft.amount,
      currency: draft.currency,
      date: draft.date,
      occurredAt: draft.occurredAt ?? null,
      merchant: type === "transfer" ? null : merchant?.slice(0, 200),
      categoryId,
      projectId,
      description: draft.description?.slice(0, 200) ?? null,
      notes: outcome.actions.note ?? null,
      reference: draft.reference?.slice(0, 200) ?? null,
    };
    const metadata = {
      ...draft.metadata,
      connector: connection.provider,
      syncRunId: scope.runId,
      ...(draft.categoryHint && !categoryId ? { categoryHint: draft.categoryHint } : {}),
      ...(draft.projectHint && !projectId ? { projectHint: draft.projectHint } : {}),
      ...(match ? { duplicateOf: match.id } : {}),
      ...(outcome.matchedRuleIds.length ? { ruleIds: outcome.matchedRuleIds } : {}),
    };

    const create = (candidate: TransactionInput, reason: string | null) =>
      db.transaction(async (tx) => {
        const result = await this.transactions.create(ctx, candidate, {
          exec: tx,
          source: "integration",
          sourceRef: scope.runId,
          externalId: draft.externalId,
          connectionId: connection.id,
          metadata,
          reviewReason: reason,
          skipLearning: true,
        });
        if (!result.duplicate && match) await this.flagDuplicate(tx, ctx, connection, result.transaction.id, match);
        return result;
      });

    let result: Awaited<ReturnType<typeof create>>;
    try {
      result = await create(input, reviewReason);
    } catch (error) {
      // Could not post (a missing exchange rate, an archived account): keep it as a draft to review.
      if (!post || !(error instanceof DomainError || error instanceof LedgerError)) throw error;
      result = await create({ ...input, status: "draft" }, `Could not post automatically: ${error.message}`);
    }
    if (result.duplicate) {
      log.duplicates++;
      return;
    }
    log.created++;
    if (match) log.review(draft.externalId, reviewReason ?? "Possible duplicate", result.transaction.id);
  }

  private async flagDuplicate(
    exec: Executor,
    ctx: WorkspaceContext,
    connection: ConnectionRow,
    transactionId: string,
    match: Awaited<ReturnType<TransactionsService["findDuplicates"]>>[number],
  ) {
    const pair = [transactionId, match.id].sort().join(":");
    const amount = formatMoney(match.transaction.amount, match.transaction.currency);
    await this.inbox.upsert(
      {
        workspaceId: ctx.workspaceId,
        kind: "duplicate",
        severity: "warning",
        title: `Possible duplicate from ${connection.name}: ${match.transaction.merchant ?? match.transaction.description ?? "transaction"} ${amount}`,
        body: `${connection.name} sent a transaction that looks like one already in your books (${match.reasons.join(", ").toLowerCase()}). It was saved as a draft: confirm it if it is new money, or void it if it is the same.`,
        data: {
          transactionIds: [transactionId, match.id],
          matchTransactionId: match.id,
          score: match.score,
          reasons: match.reasons,
          amount: match.transaction.amount,
          currency: match.transaction.currency,
          merchant: match.transaction.merchant ?? undefined,
          connectionId: connection.id,
          // The web's transactions list, filtered to the pair.
          href: `/transactions?period=all_time&ids=${transactionId},${match.id}`,
        },
        entityType: "transaction",
        entityId: transactionId,
        dedupeKey: `duplicate:${pair}`,
      },
      exec,
    );
  }

  private async upsertProject(scope: IngestScope, record: Extract<CanonicalRecord, { kind: "project" }>, log: RunLog) {
    const { ctx } = scope;
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, ctx.workspaceId),
            record.code
              ? sql`(lower(${projects.name}) = lower(${record.name}) or lower(${projects.code}) = lower(${record.code}))`
              : sql`lower(${projects.name}) = lower(${record.name})`,
          ),
        )
        .limit(1);
      if (existing) {
        const changes: Partial<typeof projects.$inferInsert> = {};
        if (record.code && record.code !== existing.code) changes.code = record.code;
        if (record.description && record.description !== existing.description) changes.description = record.description;
        if (record.status && record.status !== existing.status) changes.status = record.status;
        if (!Object.keys(changes).length) {
          log.duplicates++;
          return;
        }
        const [row] = await tx.update(projects).set(changes).where(eq(projects.id, existing.id)).returning();
        await this.audit.record(tx, ctx, {
          action: "project.updated",
          entityType: "project",
          entityId: existing.id,
          before: existing,
          after: row,
          source: "integration",
        });
        log.updated++;
        return;
      }
      const [row] = await tx
        .insert(projects)
        .values({
          workspaceId: ctx.workspaceId,
          name: record.name,
          code: record.code ?? null,
          status: record.status ?? "active",
          description: record.description ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        log.duplicates++;
        return;
      }
      await this.audit.record(tx, ctx, {
        action: "project.created",
        entityType: "project",
        entityId: row.id,
        after: { ...row, externalId: record.externalId, connectionId: scope.connection.id },
        source: "integration",
      });
      log.created++;
    });
  }

  private async upsertReceivable(scope: IngestScope, record: Extract<CanonicalRecord, { kind: "receivable" }>, resolver: Resolver, log: RunLog) {
    const { ctx, connection } = scope;
    const externalKey = `integration:${connection.id}:${record.externalId}`;
    const projectId = (await resolver.project(record.project)) ?? connection.projectId ?? null;
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(receivables)
        .where(and(eq(receivables.workspaceId, ctx.workspaceId), eq(receivables.externalKey, externalKey)))
        .limit(1);
      const counterparty = await this.counterparties.findOrCreate(tx, ctx.workspaceId, record.customer, "customer");
      // Paid and overdue are otherwise derived from payments; the source may settle or cancel it.
      const status =
        record.status === "cancelled"
          ? "cancelled"
          : record.status === "paid"
            ? "paid"
            : existing && existing.status !== "cancelled" && existing.status !== "paid"
              ? existing.status
              : "pending";
      const values = {
        counterpartyId: counterparty?.id ?? null,
        counterpartyName: record.customer,
        title: record.title,
        reference: record.reference ?? null,
        amount: record.amount,
        currency: record.currency,
        issueDate: record.issueDate,
        dueDate: record.dueDate ?? null,
        status,
        projectId,
        notes: record.notes ?? null,
      } as const;
      if (existing) {
        const changed = (Object.keys(values) as Array<keyof typeof values>).some((key) => (existing[key] ?? null) !== (values[key] ?? null));
        if (!changed) {
          log.duplicates++;
          return;
        }
        const [row] = await tx.update(receivables).set(values).where(eq(receivables.id, existing.id)).returning();
        await this.audit.record(tx, ctx, {
          action: "receivable.updated",
          entityType: "receivable",
          entityId: existing.id,
          before: existing,
          after: row,
          source: "integration",
        });
        log.updated++;
        return;
      }
      const [row] = await tx
        .insert(receivables)
        .values({ workspaceId: ctx.workspaceId, kind: "invoice", ...values, source: "integration", externalKey, connectionId: connection.id })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        log.duplicates++;
        return;
      }
      await this.audit.record(tx, ctx, { action: "receivable.imported", entityType: "receivable", entityId: row.id, after: row, source: "integration" });
      log.created++;
    });
  }

  /** Compares the source's balance with the books on the same day. */
  private async recordBalance(scope: IngestScope, record: Extract<CanonicalRecord, { kind: "balance" }>, resolver: Resolver, log: RunLog) {
    const accountId = await resolver.account(record.accountRef, scope.connection.accountId);
    const account = accountId ? (await resolver.accounts()).get(accountId) : undefined;
    let bookBalance: number | null = null;
    if (accountId && account && account.currency === record.currency) {
      const sums = await this.accounts.balances(scope.ctx.workspaceId, record.asOf, [accountId]);
      bookBalance = (account.openingDate <= record.asOf ? account.openingBalance : 0) + (sums.get(accountId)?.total ?? 0);
    }
    log.balance({
      message: `Reported balance ${formatMoney(record.balance, record.currency)} on ${record.asOf}`,
      accountId: accountId ?? null,
      balance: record.balance,
      currency: record.currency,
      asOf: record.asOf,
      bookBalance,
      difference: bookBalance === null ? null : record.balance - bookBalance,
    });
  }
}
