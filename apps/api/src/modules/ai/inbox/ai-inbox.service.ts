import {
  addDays,
  addMonths,
  applyRules,
  type CommitmentInput,
  fromMinor,
  inboxActionInput,
  normalizeName,
  parseEntry,
  type Rule,
  type SubscriptionInput,
} from "@financeos/core";
import {
  type AiConfidenceView,
  type ConfidenceField,
  type InboxDraftView,
  type InboxItemView,
  type InboxQuery,
  type InboxSummary,
  type InboxTrackInput,
  type InboxView,
  inboxDuplicateInput,
  inboxQuery,
  inboxTrackInput,
  type UncategorizedApplyInput,
  type UncategorizedItemView,
  type UncategorizedQuery,
  type UncategorizedView,
  uncategorizedApplyInput,
  uncategorizedQuery,
} from "@financeos/core/contracts/ai-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../../common/context.js";
import { assertFound, badRequest, unprocessable } from "../../../common/errors.js";
import { db } from "../../../db/index.js";
import { commitmentOccurrences, counterparties, inboxItems, transactions } from "../../../db/schema/index.js";
import type { InboxData } from "../../../db/schema/types.js";
import { CategoriesService, ProjectsService, RulesService } from "../../ledger/catalog.service.js";
import { type TransactionRow, TransactionsService } from "../../ledger/transactions.service.js";
import { CommitmentsService } from "../../planning/commitments.service.js";
import { SubscriptionsService } from "../../planning/subscriptions.service.js";
import { AuditService } from "../../system/audit.service.js";
import { AiGateway } from "../gateway/ai.gateway.js";

type InboxRow = typeof inboxItems.$inferSelect;

const ANOMALY_KINDS = new Set(["anomaly", "large_transaction"]);
const WARNING_KINDS = new Set(["budget_warning", "forecast_warning", "price_change", "renewal", "receivable_overdue"]);
const CAPTURE_SOURCES = new Set(["screenshot", "receipt", "pdf", "text", "voice"]);
/** How far back "uncategorised" looks. */
const UNCATEGORIZED_DAYS = 90;
/** One classification call at most, however many rows are shown. */
const CLASSIFY_BATCH = 50;

/** Open, or snoozed until a moment that has passed. */
const isOpen = sql`(${inboxItems.status} = 'open' or (${inboxItems.status} = 'snoozed' and ${inboxItems.snoozedUntil} <= now()))`;

function actionsFor(row: InboxRow): InboxItemView["actions"] {
  const data = row.data ?? {};
  const open = row.status === "open" || (row.status === "snoozed" && row.snoozedUntil !== null && row.snoozedUntil <= new Date());
  const actions: InboxItemView["actions"] = open ? ["resolve", "dismiss", "snooze"] : ["reopen"];
  if (open && row.kind === "duplicate" && (data.transactionIds?.length ?? 0) >= 2) actions.push("keep_both", "keep_first", "keep_second");
  if (open && (row.kind === "recurring_candidate" || row.kind === "subscription_candidate")) actions.push("track_subscription", "track_commitment");
  if (data.href || data.transactionIds?.length) actions.push("view_transactions");
  if (typeof data.captureId === "string") actions.push("open_capture");
  return actions;
}

export function inboxItemView(row: InboxRow): InboxItemView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    severity: row.severity,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    entityType: row.entityType,
    entityId: row.entityId,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actions: actionsFor(row),
  };
}

function cycleFor(cadence: unknown): {
  billingCycle: SubscriptionInput["billingCycle"];
  frequency: CommitmentInput["frequency"];
  intervalUnit: "week" | "month" | null;
} {
  switch (cadence) {
    case "weekly":
      return {
        billingCycle: "custom",
        frequency: "weekly",
        intervalUnit: "week",
      };
    case "quarterly":
      return {
        billingCycle: "quarterly",
        frequency: "quarterly",
        intervalUnit: null,
      };
    case "half_yearly":
      return {
        billingCycle: "half_yearly",
        frequency: "half_yearly",
        intervalUnit: null,
      };
    case "yearly":
      return {
        billingCycle: "yearly",
        frequency: "yearly",
        intervalUnit: null,
      };
    default:
      return {
        billingCycle: "monthly",
        frequency: "monthly",
        intervalUnit: null,
      };
  }
}

/**
 * The AI Inbox: everything waiting for a decision — drafts to review,
 * uncategorised spending, duplicates, recurring charges, anomalies — with
 * the actions that settle each one.
 */
@Injectable()
export class AiInboxService {
  constructor(
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
    @Inject(CommitmentsService)
    private readonly commitments: CommitmentsService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async item(ctx: WorkspaceContext, id: string): Promise<InboxRow> {
    const [row] = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.id, id), eq(inboxItems.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Inbox item");
  }

  async summary(ctx: WorkspaceContext): Promise<InboxSummary> {
    const since = addDays(todayFor(ctx), -UNCATEGORIZED_DAYS);
    const [[review], [uncategorized], kinds] = await Promise.all([
      db
        .select({ value: count() })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, ctx.workspaceId), inArray(transactions.status, ["draft", "pending"]))),
      db
        .select({ value: count() })
        .from(transactions)
        .where(
          and(
            eq(transactions.workspaceId, ctx.workspaceId),
            eq(transactions.status, "posted"),
            inArray(transactions.type, ["expense", "income"]),
            isNull(transactions.categoryId),
            gte(transactions.date, since),
          ),
        ),
      db
        .select({ kind: inboxItems.kind, value: count() })
        .from(inboxItems)
        .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), isOpen))
        .groupBy(inboxItems.kind),
    ]);
    const byKind = new Map(kinds.map((row) => [row.kind as string, row.value]));
    const sumOf = (predicate: (kind: string) => boolean) =>
      [...byKind.entries()].filter(([kind]) => predicate(kind)).reduce((total, [, value]) => total + value, 0);
    return {
      needsReview: review?.value ?? 0,
      uncategorized: uncategorized?.value ?? 0,
      duplicates: byKind.get("duplicate") ?? 0,
      recurring: (byKind.get("recurring_candidate") ?? 0) + (byKind.get("subscription_candidate") ?? 0),
      anomalies: sumOf((kind) => ANOMALY_KINDS.has(kind)),
      integrationErrors: byKind.get("integration_error") ?? 0,
      warnings: sumOf((kind) => WARNING_KINDS.has(kind)),
      observations: byKind.get("observation") ?? 0,
    };
  }

  async overview(ctx: WorkspaceContext, raw: InboxQuery = {}): Promise<InboxView> {
    const query = inboxQuery.parse(raw);
    const statusFilter: SQL | undefined =
      query.status === "all"
        ? undefined
        : query.status === "open"
          ? isOpen
          : query.status === "snoozed"
            ? sql`(${inboxItems.status} = 'snoozed' and (${inboxItems.snoozedUntil} is null or ${inboxItems.snoozedUntil} > now()))`
            : eq(inboxItems.status, query.status);
    const [summary, rows, drafts] = await Promise.all([
      this.summary(ctx),
      db
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), statusFilter, query.kind?.length ? inArray(inboxItems.kind, query.kind) : undefined))
        .orderBy(desc(inboxItems.createdAt))
        .limit(query.limit),
      this.transactions.list(ctx, {
        status: ["draft", "pending"],
        sort: "created_desc",
        pageSize: 50,
      }),
    ]);
    return {
      summary,
      items: rows.map(inboxItemView),
      drafts: drafts.items.map((row): InboxDraftView => {
        const meta = (row.metadata ?? {}) as {
          captureId?: string;
          review?: { missing?: ConfidenceField[] };
        };
        return {
          id: row.id,
          status: row.status,
          type: row.type,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
          date: row.date,
          merchant: row.merchant,
          description: row.description,
          accountId: row.accountId,
          accountName: row.accountName,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          source: row.source,
          reviewReason: row.reviewReason,
          confidence: (row.aiConfidence as AiConfidenceView | null) ?? null,
          missing: meta.review?.missing ?? [],
          captureId: meta.captureId ?? (CAPTURE_SOURCES.has(row.source) ? row.sourceRef : null),
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  async act(ctx: WorkspaceContext, id: string, raw: z.input<typeof inboxActionInput>): Promise<InboxItemView> {
    const input = inboxActionInput.parse(raw);
    const before = await this.item(ctx, id);
    const now = new Date();
    const changes: Partial<InboxRow> =
      input.action === "resolve"
        ? {
            status: "resolved",
            resolvedAt: now,
            resolvedBy: ctx.userId,
            snoozedUntil: null,
          }
        : input.action === "dismiss"
          ? {
              status: "dismissed",
              resolvedAt: now,
              resolvedBy: ctx.userId,
              snoozedUntil: null,
            }
          : input.action === "snooze"
            ? {
                status: "snoozed",
                snoozedUntil: new Date(now.getTime() + (input.snoozeDays ?? 7) * 86_400_000),
              }
            : {
                status: "open",
                resolvedAt: null,
                resolvedBy: null,
                snoozedUntil: null,
              };
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(inboxItems).set(changes).where(eq(inboxItems.id, id)).returning();
      await this.audit.record(tx, ctx, {
        action: `inbox.${input.action}`,
        entityType: "inbox_item",
        entityId: id,
        before: { status: before.status },
        after: { status: updated?.status },
      });
      return updated as InboxRow;
    });
    return inboxItemView(row);
  }

  /** Settles a possible duplicate: keep both, or void one of the two transactions. */
  async resolveDuplicate(ctx: WorkspaceContext, id: string, raw: z.input<typeof inboxDuplicateInput>) {
    const input = inboxDuplicateInput.parse(raw);
    const item = await this.item(ctx, id);
    if (item.kind !== "duplicate") throw badRequest("This item is not a possible duplicate", "wrong_kind");
    const [first, second] = item.data.transactionIds ?? [];
    if (!first || !second) throw unprocessable("This item does not name two transactions", "invalid_item");
    const voidId = input.keep === "first" ? second : input.keep === "second" ? first : null;
    const keptId = voidId === first ? second : voidId === second ? first : null;
    const row = await db.transaction(async (tx) => {
      if (voidId)
        await this.transactions.void(ctx, voidId, `Duplicate of ${keptId}`, {
          exec: tx,
        });
      const [updated] = await tx
        .update(inboxItems)
        .set({
          status: "resolved",
          resolvedAt: new Date(),
          resolvedBy: ctx.userId,
          data: {
            ...item.data,
            resolution: input.keep,
            voidedTransactionId: voidId,
          },
        })
        .where(eq(inboxItems.id, id))
        .returning();
      await this.audit.record(tx, ctx, {
        action: "inbox.duplicate_resolved",
        entityType: "inbox_item",
        entityId: id,
        after: { keep: input.keep, voided: voidId },
      });
      return updated as InboxRow;
    });
    return { item: inboxItemView(row), voidedTransactionId: voidId };
  }

  /** Turns a recurring or subscription candidate into a tracked subscription or commitment. */
  async track(ctx: WorkspaceContext, id: string, raw: InboxTrackInput) {
    const input = inboxTrackInput.parse(raw);
    const item = await this.item(ctx, id);
    if (item.kind !== "recurring_candidate" && item.kind !== "subscription_candidate")
      throw badRequest("Only recurring or subscription candidates can be tracked", "wrong_kind");
    const data = item.data as InboxData & {
      purchaseTransactionId?: string | null;
      subscription?: Record<string, unknown>;
      lastDate?: string;
      nextExpected?: string;
    };
    const suggestion = (data.subscription ?? {}) as {
      planName?: string | null;
      billingCycle?: string | null;
      nextRenewalDate?: string | null;
      expiryDate?: string | null;
      cancellationDeadline?: string | null;
      autoRenew?: boolean | null;
      startDate?: string | null;
      purchaseDate?: string | null;
      renewalAmount?: number | null;
      currency?: string | null;
    };

    const ids = (data.transactionIds ?? []).filter(Boolean);
    const rows = ids.length
      ? await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.workspaceId, ctx.workspaceId), inArray(transactions.id, ids)))
          .orderBy(asc(transactions.date))
      : [];
    const posted = rows.filter((row) => row.status === "posted");
    const latest: TransactionRow | null = posted[posted.length - 1] ?? rows[rows.length - 1] ?? null;
    const first = posted[0] ?? rows[0] ?? null;

    const cadence = input.billingCycle ?? (item.kind === "subscription_candidate" ? (suggestion.billingCycle ?? data.cadence) : data.cadence);
    const cycle = cycleFor(cadence);
    const nextDate = input.nextRenewalDate ?? suggestion.nextRenewalDate ?? data.nextExpected ?? (latest ? addMonths(latest.date, 1) : null);
    const amount = input.amount ?? suggestion.renewalAmount ?? (typeof data.amount === "number" ? data.amount : null) ?? latest?.amount ?? null;
    const currency = input.currency ?? suggestion.currency ?? data.currency ?? latest?.currency ?? null;
    const name = input.name ?? data.merchant ?? latest?.merchant ?? null;
    if (!nextDate || !amount || !currency || !name) throw unprocessable("Give the name, amount and next date to track this", "missing_details");

    // Link the most recent posted charge as the purchase, unless it already settles something.
    let purchaseId: string | null =
      typeof data.purchaseTransactionId === "string" ? data.purchaseTransactionId : latest?.status === "posted" ? latest.id : null;
    if (purchaseId) {
      const [linked] = await db
        .select({ id: commitmentOccurrences.id })
        .from(commitmentOccurrences)
        .where(eq(commitmentOccurrences.transactionId, purchaseId))
        .limit(1);
      const [purchase] = await db
        .select({ date: transactions.date, status: transactions.status })
        .from(transactions)
        .where(and(eq(transactions.id, purchaseId), eq(transactions.workspaceId, ctx.workspaceId)));
      if (linked || !purchase || purchase.status !== "posted" || purchase.date >= nextDate) purchaseId = null;
    }

    const result = await db.transaction(async (tx) => {
      let tracked: {
        kind: "subscription" | "commitment";
        subscriptionId: string | null;
        commitmentId: string;
      };
      if (input.kind === "subscription") {
        const created = await this.subscriptions.create(
          ctx,
          {
            provider: String(name).slice(0, 120),
            planName: suggestion.planName ?? null,
            amount,
            currency,
            billingCycle: cycle.billingCycle,
            intervalCount: 1,
            intervalUnit: cycle.intervalUnit,
            purchaseDate: suggestion.purchaseDate ?? null,
            startDate: suggestion.startDate ?? first?.date ?? nextDate,
            nextRenewalDate: nextDate,
            expiryDate: suggestion.expiryDate ?? null,
            cancellationDeadline: suggestion.cancellationDeadline ?? null,
            autoRenew: input.autoRenew ?? suggestion.autoRenew ?? true,
            accountId: input.accountId ?? latest?.accountId ?? null,
            categoryId: input.categoryId ?? latest?.categoryId ?? null,
            projectId: input.projectId ?? latest?.projectId ?? null,
            notes: input.notes ?? null,
          },
          { exec: tx, purchaseTransactionId: purchaseId },
        );
        tracked = {
          kind: "subscription",
          subscriptionId: created.subscription.id,
          commitmentId: created.commitment.id,
        };
      } else {
        const commitment = await this.commitments.create(
          ctx,
          {
            kind: "custom",
            direction: "out",
            name: String(name).slice(0, 120),
            payee: String(name).slice(0, 200),
            counterpartyId: latest?.counterpartyId ?? null,
            amount,
            currency,
            frequency: cycle.frequency,
            intervalCount: 1,
            intervalUnit: null,
            startDate: first?.date ?? nextDate,
            nextDueDate: nextDate,
            accountId: input.accountId ?? latest?.accountId ?? null,
            categoryId: input.categoryId ?? latest?.categoryId ?? null,
            projectId: input.projectId ?? latest?.projectId ?? null,
            autoPay: false,
            notes: input.notes ?? null,
          },
          { exec: tx },
        );
        tracked = {
          kind: "commitment",
          subscriptionId: null,
          commitmentId: commitment.id,
        };
      }
      const [updated] = await tx
        .update(inboxItems)
        .set({
          status: "resolved",
          resolvedAt: new Date(),
          resolvedBy: ctx.userId,
          data: {
            ...item.data,
            trackedAs: tracked.kind,
            subscriptionId: tracked.subscriptionId ?? undefined,
            commitmentId: tracked.commitmentId,
          },
        })
        .where(eq(inboxItems.id, id))
        .returning();
      await this.audit.record(tx, ctx, {
        action: "inbox.tracked",
        entityType: "inbox_item",
        entityId: id,
        after: tracked,
      });
      return {
        item: inboxItemView(updated as InboxRow),
        ...tracked,
        purchaseTransactionId: purchaseId,
      };
    });
    return result;
  }

  /**
   * Posted income and spending without a category, each with a suggestion
   * from rules, merchant memory or keywords — and, for what those cannot
   * place, one batched model call when AI is available.
   */
  async uncategorized(ctx: WorkspaceContext, raw: UncategorizedQuery = {}): Promise<UncategorizedView> {
    const query = uncategorizedQuery.parse(raw);
    const today = todayFor(ctx);
    const listed = await this.transactions.list(ctx, {
      status: ["posted"],
      type: ["expense", "income"],
      categoryId: "none",
      from: addDays(today, -query.days),
      to: today,
      sort: "date_desc",
      pageSize: query.limit,
    });
    const [ruleRows, categoryRows, projectRows] = await Promise.all([this.rules.list(ctx), this.categories.list(ctx), this.projects.list(ctx)]);
    const enabledRules = ruleRows.filter((rule) => rule.enabled) as Rule[];
    const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const counterpartyIds = [...new Set(listed.items.map((row) => row.counterpartyId).filter((value): value is string => Boolean(value)))];
    const memory = counterpartyIds.length
      ? await db
          .select()
          .from(counterparties)
          .where(and(eq(counterparties.workspaceId, ctx.workspaceId), inArray(counterparties.id, counterpartyIds)))
      : [];
    const memoryById = new Map(memory.map((row) => [row.id, row]));
    const byName = (name: string | null, kind: "expense" | "income") => {
      if (!name) return null;
      const wanted = normalizeName(name);
      const sameKind = categoryRows.filter((c) => c.kind === kind);
      return (
        sameKind.find((c) => normalizeName(c.name) === wanted) ??
        sameKind.find((c) => normalizeName(c.name).includes(wanted) || wanted.includes(normalizeName(c.name))) ??
        null
      );
    };

    const items: UncategorizedItemView[] = listed.items.map((row) => {
      const kind = row.type === "income" ? "income" : "expense";
      const merchantName = row.counterpartyName ?? row.merchant;
      let suggestion: UncategorizedItemView["suggestion"] = null;
      const outcome = applyRules(enabledRules, {
        merchant: merchantName,
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        accountId: row.accountId,
        source: row.source,
        type: row.type,
        reference: row.reference,
      });
      const ruleCategory = outcome.actions.categoryId ? categoryById.get(outcome.actions.categoryId) : undefined;
      const known = row.counterpartyId ? memoryById.get(row.counterpartyId) : undefined;
      const memoryCategory = known?.defaultCategoryId ? categoryById.get(known.defaultCategoryId) : undefined;
      const projectFor = (id: string | null | undefined) => (id ? (projectById.get(id) ?? null) : null);
      if (ruleCategory && ruleCategory.kind === kind) {
        const project = projectFor(outcome.actions.projectId);
        suggestion = {
          categoryId: ruleCategory.id,
          categoryName: ruleCategory.name,
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
          source: "rule",
          confidence: 1,
        };
      } else if (memoryCategory && memoryCategory.kind === kind) {
        const project = row.projectId ? null : projectFor(known?.defaultProjectId);
        const confirmations = known?.confirmations ?? 0;
        suggestion = {
          categoryId: memoryCategory.id,
          categoryName: memoryCategory.name,
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
          source: "merchant",
          confidence: confirmations >= 2 ? 0.95 : confirmations === 1 ? 0.8 : 0.6,
        };
      } else {
        const hint = parseEntry(`${row.type === "income" ? "received" : "paid"} ${[merchantName, row.description].filter(Boolean).join(" ")}`, {
          today,
        }).categoryHint;
        const match = byName(hint, kind);
        if (match)
          suggestion = {
            categoryId: match.id,
            categoryName: match.name,
            projectId: null,
            projectName: null,
            source: "parser",
            confidence: 0.7,
          };
      }
      return {
        transaction: {
          id: row.id,
          type: row.type,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
          baseAmount: row.baseAmount,
          date: row.date,
          merchant: merchantName,
          description: row.description,
          counterpartyId: row.counterpartyId,
          accountName: row.accountName,
          projectId: row.projectId,
        },
        suggestion,
      };
    });

    const ai: UncategorizedView["ai"] = {
      used: false,
      reason: null,
      costUsd: 0,
    };
    const unplaced = items.filter((item) => !item.suggestion).slice(0, CLASSIFY_BATCH);
    if (!query.suggest) ai.reason = "Suggestions were not requested";
    else if (!unplaced.length) ai.reason = "Rules and merchant memory placed everything";
    else if (!this.gateway.configured) ai.reason = "AI is not configured";
    else {
      const result = await this.gateway.classify(ctx, {
        items: unplaced.map((item) => ({
          id: item.transaction.id,
          merchant: item.transaction.merchant,
          description: item.transaction.description,
          type: item.transaction.type === "income" ? "income" : "expense",
          amount: fromMinor(item.transaction.amount, item.transaction.currency),
          currency: item.transaction.currency,
        })),
        categories: categoryRows.map((c) => ({ name: c.name, kind: c.kind })),
        projects: projectRows.map((p) => p.name),
        workspaceKind: ctx.workspaceKind,
      });
      ai.costUsd = result.costUsd;
      if (!result.ok) ai.reason = result.message;
      else {
        ai.used = true;
        const byId = new Map(unplaced.map((item) => [item.transaction.id, item]));
        for (const answer of result.output.items) {
          const item = byId.get(answer.id);
          if (!item || !answer.category) continue;
          const match = byName(answer.category, item.transaction.type === "income" ? "income" : "expense");
          if (!match) continue;
          const project = answer.project ? (projectRows.find((p) => normalizeName(p.name) === normalizeName(answer.project ?? "")) ?? null) : null;
          item.suggestion = {
            categoryId: match.id,
            categoryName: match.name,
            projectId: item.transaction.projectId ? null : (project?.id ?? null),
            projectName: item.transaction.projectId ? null : (project?.name ?? null),
            source: "ai",
            confidence: Math.round(Math.min(0.85, Math.max(0, answer.confidence)) * 100) / 100,
          };
        }
      }
    }
    return { items, total: listed.total, ai };
  }

  /** Applies chosen categories (and projects); confirming a category teaches merchant memory. */
  async applyCategories(ctx: WorkspaceContext, raw: UncategorizedApplyInput) {
    const input = uncategorizedApplyInput.parse(raw);
    let updated = 0;
    const failures: Array<{ transactionId: string; message: string }> = [];
    for (const item of input.items) {
      try {
        await this.transactions.update(ctx, item.transactionId, {
          categoryId: item.categoryId,
          ...(item.projectId !== undefined ? { projectId: item.projectId } : {}),
          reason: "Categorised from the AI Inbox",
        });
        updated++;
      } catch (error) {
        failures.push({
          transactionId: item.transactionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { updated, failures };
  }
}
