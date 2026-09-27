import {
  type BudgetMetrics,
  budgetInput,
  budgetMetrics,
  budgetPeriodRange,
  budgetUpdate,
  type Day,
  formatMoney,
  type Range,
  recentPeriods,
} from "@expensewise/core";
import { type BudgetDetailQuery, type BudgetQuery, budgetDetailQuery, budgetQuery } from "@expensewise/core/contracts/planning-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { budgets, categories, inboxItems, projects, transactions } from "../../db/schema/index.js";
import { CategoriesService } from "../ledger/catalog.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { AuditService } from "../system/audit.service.js";
import { EventsService } from "../system/events.service.js";
import { InboxService, NotificationsService } from "../system/notify.service.js";
import { links } from "./planning.shared.js";

export type BudgetRow = typeof budgets.$inferSelect;
type BudgetInputParsed = z.output<typeof budgetInput>;

const OPEN_END = "2999-12-31";
/** Spending is expenses less refunds received; these are the types involved. */
const SPENDING_TYPES = ["expense", "refund"] as const;

export type BudgetDrilldown = {
  /** Query parameters for GET /api/transactions that list the spending behind the figure. */
  query: { from: Day; to?: Day; categoryId?: string; includeChildren?: boolean; projectId?: string; type: string[]; status: string[] };
  href: string;
};

export type BudgetView = BudgetRow & {
  currency: string;
  scope: "workspace" | "category" | "project" | "category_project";
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectName: string | null;
  /** Whether the budget applies on the measured day. */
  inEffect: boolean;
  range: Range;
  metrics: BudgetMetrics;
  drilldown: BudgetDrilldown;
  links: { self: string };
};

function drilldown(budget: BudgetRow, range: Range): BudgetDrilldown {
  const query: BudgetDrilldown["query"] = {
    from: range.from,
    ...(range.to !== OPEN_END ? { to: range.to } : {}),
    ...(budget.categoryId ? { categoryId: budget.categoryId, includeChildren: true } : {}),
    ...(budget.projectId ? { projectId: budget.projectId } : {}),
    type: [...SPENDING_TYPES],
    status: ["posted"],
  };
  return { query, href: links.transactions(query) };
}

/**
 * Budgets: a spending limit per period for the workspace, a category (with
 * its subcategories) and/or a project, measured against posted expenses less
 * refunds, in the base currency.
 */
@Injectable()
export class BudgetsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<BudgetRow> {
    const [row] = await exec
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, id), eq(budgets.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Budget");
  }

  private async validate(tx: Executor, ctx: WorkspaceContext, input: Pick<BudgetInputParsed, "categoryId" | "projectId" | "startDate" | "endDate">) {
    await assertInWorkspace(tx, categories, ctx.workspaceId, [input.categoryId], "Category");
    await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
    if (input.categoryId) {
      const [category] = await tx.select({ kind: categories.kind }).from(categories).where(eq(categories.id, input.categoryId));
      if (category && category.kind !== "expense") throw unprocessable("Budgets track spending: choose an expense category", "category_kind_mismatch");
    }
    if (input.projectId && ctx.workspaceKind !== "business") {
      throw unprocessable("Project budgets belong to business workspaces", "projects_business_only");
    }
    if (input.endDate && input.endDate < input.startDate) throw unprocessable("The end date is before the start date", "invalid_dates");
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof budgetInput>): Promise<BudgetRow> {
    const input = budgetInput.parse(raw);
    return db.transaction(async (tx) => {
      await this.validate(tx, ctx, input);
      const [row] = await tx
        .insert(budgets)
        .values({
          workspaceId: ctx.workspaceId,
          name: input.name,
          period: input.period,
          amount: input.amount,
          categoryId: input.categoryId ?? null,
          projectId: input.projectId ?? null,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          alertThreshold: input.alertThreshold,
          notes: input.notes ?? null,
        })
        .returning();
      await this.audit.record(tx, ctx, { action: "budget.created", entityType: "budget", entityId: row?.id, after: row });
      return row as BudgetRow;
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof budgetUpdate>): Promise<BudgetRow> {
    const changes = budgetUpdate.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<BudgetRow>;
      const merged = { ...before, ...defined };
      await this.validate(tx, ctx, merged);
      const [row] = await tx.update(budgets).set(defined).where(eq(budgets.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "budget.updated", entityType: "budget", entityId: id, before, after: row });
      return row as BudgetRow;
    });
  }

  async remove(ctx: WorkspaceContext, id: string) {
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      await tx.delete(budgets).where(eq(budgets.id, id));
      await this.inbox.resolveForEntity(ctx.workspaceId, id, ["budget_warning"], ctx.userId, tx);
      await this.audit.record(tx, ctx, { action: "budget.deleted", entityType: "budget", entityId: id, before });
    });
    return { deleted: true };
  }

  private async categoryScope(ctx: WorkspaceContext, budget: BudgetRow, exec: Executor): Promise<string[] | null> {
    return budget.categoryId ? this.categories.withDescendants(ctx.workspaceId, budget.categoryId, exec) : null;
  }

  /** Posted expenses less refunds received, in the base currency. */
  async spent(ctx: WorkspaceContext, budget: BudgetRow, range: Range, categoryIds: string[] | null, exec: Executor = db): Promise<number> {
    const where: SQL[] = [
      eq(transactions.workspaceId, ctx.workspaceId),
      eq(transactions.status, "posted"),
      inArray(transactions.type, [...SPENDING_TYPES]),
      gte(transactions.date, range.from),
      lte(transactions.date, range.to),
    ];
    if (categoryIds) where.push(inArray(transactions.categoryId, categoryIds));
    if (budget.projectId) where.push(eq(transactions.projectId, budget.projectId));
    const [row] = await exec
      .select({
        total: sql<string>`coalesce(sum(case when ${transactions.type} = 'expense' then ${transactions.baseAmount} when ${transactions.type} = 'refund' and ${transactions.direction} = 'in' then -${transactions.baseAmount} else 0 end), 0)`,
      })
      .from(transactions)
      .where(and(...where));
    return Number(row?.total ?? 0);
  }

  private rangeFor(ctx: WorkspaceContext, budget: BudgetRow, date: Day): Range {
    return budgetPeriodRange(budget.period, date, budget, ctx.fiscalYearStartMonth);
  }

  private async view(
    ctx: WorkspaceContext,
    row: { budget: BudgetRow; categoryName: string | null; categoryIcon: string | null; categoryColor: string | null; projectName: string | null },
    date: Day,
    exec: Executor = db,
  ): Promise<BudgetView> {
    const budget = row.budget;
    const range = this.rangeFor(ctx, budget, date);
    const actual = await this.spent(ctx, budget, range, await this.categoryScope(ctx, budget, exec), exec);
    return {
      ...budget,
      currency: ctx.baseCurrency,
      scope: budget.categoryId && budget.projectId ? "category_project" : budget.categoryId ? "category" : budget.projectId ? "project" : "workspace",
      categoryName: row.categoryName,
      categoryIcon: row.categoryIcon,
      categoryColor: row.categoryColor,
      projectName: row.projectName,
      inEffect: budget.active && date >= budget.startDate && (!budget.endDate || date <= budget.endDate),
      range,
      metrics: budgetMetrics(budget.amount, actual, range, todayFor(ctx), budget.alertThreshold),
      drilldown: drilldown(budget, range),
      links: { self: links.budget(budget.id) },
    };
  }

  private joined(ctx: WorkspaceContext, where: SQL[], exec: Executor = db) {
    return exec
      .select({
        budget: budgets,
        categoryName: categories.name,
        categoryIcon: categories.icon,
        categoryColor: categories.color,
        projectName: projects.name,
      })
      .from(budgets)
      .leftJoin(categories, eq(categories.id, budgets.categoryId))
      .leftJoin(projects, eq(projects.id, budgets.projectId))
      .where(and(eq(budgets.workspaceId, ctx.workspaceId), ...where))
      .orderBy(desc(budgets.active), asc(budgets.name));
  }

  /** Every budget measured for the period containing `date` (default today). */
  async list(ctx: WorkspaceContext, raw: BudgetQuery = {}) {
    const query = budgetQuery.parse(raw);
    const date = query.date ?? todayFor(ctx);
    const where: SQL[] = [];
    if (query.active !== undefined) where.push(eq(budgets.active, query.active));
    if (query.categoryId) where.push(eq(budgets.categoryId, query.categoryId));
    if (query.projectId) where.push(eq(budgets.projectId, query.projectId));
    const rows = await this.joined(ctx, where);
    const items = await Promise.all(
      rows.map(async (row) => {
        const view = await this.view(ctx, row, date);
        return query.history > 0 ? { ...view, history: await this.history(ctx, row.budget, view.range, date, query.history) } : view;
      }),
    );
    const measured = items.filter((item) => item.inEffect);
    return {
      date,
      baseCurrency: ctx.baseCurrency,
      items,
      total: items.length,
      summary: {
        inEffect: measured.length,
        over: measured.filter((item) => item.metrics.status === "over").length,
        warning: measured.filter((item) => item.metrics.status === "warning").length,
        onTrack: measured.filter((item) => item.metrics.status === "on_track").length,
      },
    };
  }

  /** Spending per period for the last `count` periods ending with the one containing `date`. */
  private async history(ctx: WorkspaceContext, budget: BudgetRow, current: Range, date: Day, count: number) {
    const categoryIds = await this.categoryScope(ctx, budget, db);
    const ranges = budget.period === "total" ? [current] : recentPeriods(budget.period, date, count, ctx.fiscalYearStartMonth);
    const today = todayFor(ctx);
    return Promise.all(
      ranges.map(async (range) => {
        const actual = await this.spent(ctx, budget, range, categoryIds);
        const metrics = budgetMetrics(budget.amount, actual, range, today, budget.alertThreshold);
        return {
          from: range.from,
          to: range.to,
          budget: budget.amount,
          actual,
          remaining: metrics.remaining,
          utilization: metrics.utilization,
          status: metrics.status,
          drilldown: drilldown(budget, range),
        };
      }),
    );
  }

  /** One budget with its current metrics and the last N periods, for charts. */
  async detail(ctx: WorkspaceContext, id: string, raw: BudgetDetailQuery = {}) {
    const query = budgetDetailQuery.parse(raw);
    const date = query.date ?? todayFor(ctx);
    const [row] = await this.joined(ctx, [eq(budgets.id, id)]);
    const joined = assertFound(row, "Budget");
    const view = await this.view(ctx, joined, date);
    const categoryIds = await this.categoryScope(ctx, joined.budget, db);
    const history = await this.history(ctx, joined.budget, view.range, date, query.periods);
    return { ...view, categoryIds: categoryIds ?? [], history };
  }

  /**
   * The hourly threshold check: an Inbox item, a notification and a
   * `budget.threshold_reached` event the first time a budget reaches its
   * alert threshold, and again at 100%, once per budget, period and level.
   *
   * Only the highest level reached has an open Inbox item: reaching 100%
   * resolves the earlier warning, and a level no longer reached (after a
   * refund or a voided expense) is resolved too.
   */
  async scanThresholds(ctx: WorkspaceContext, today: Day = todayFor(ctx)) {
    const rows = await this.joined(ctx, [
      eq(budgets.active, true),
      lte(budgets.startDate, today),
      or(isNull(budgets.endDate), gte(budgets.endDate, today)) as SQL,
    ]);
    let alerts = 0;
    let resolved = 0;
    for (const row of rows) {
      const budget = row.budget;
      const view = await this.view(ctx, row, today);
      const { metrics, range } = view;
      const keyFor = (level: number) => `budget:${budget.id}:${range.from}:${level}`;
      const allLevels = [...new Set([budget.alertThreshold, 100])].sort((a, b) => a - b);
      const highest = allLevels.filter((level) => metrics.utilization >= level).at(-1);
      for (const level of allLevels) {
        if (level === highest) continue;
        const closed = await db
          .update(inboxItems)
          .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: ctx.userId })
          .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.dedupeKey, keyFor(level)), eq(inboxItems.status, "open")))
          .returning({ id: inboxItems.id });
        resolved += closed.length;
      }
      const levels = highest === undefined ? [] : [highest];
      for (const level of levels) {
        const dedupeKey = keyFor(level);
        const [seen] = await db
          .select({ id: inboxItems.id })
          .from(inboxItems)
          .where(and(eq(inboxItems.workspaceId, ctx.workspaceId), eq(inboxItems.dedupeKey, dedupeKey)))
          .limit(1);
        if (seen) continue;
        const money = (value: number) => formatMoney(value, ctx.baseCurrency);
        const over = metrics.actual > budget.amount;
        const title =
          level >= 100
            ? over
              ? `${budget.name} is over budget`
              : `${budget.name} has used its whole budget`
            : `${budget.name} has used ${metrics.utilization}% of its budget`;
        const body = `Spent ${money(metrics.actual)} of ${money(budget.amount)} between ${range.from} and ${range.to === OPEN_END ? "now" : range.to} (${metrics.utilization}%).`;
        await db.transaction(async (tx) => {
          await this.inbox.upsert(
            {
              workspaceId: ctx.workspaceId,
              kind: "budget_warning",
              severity: level >= 100 ? "critical" : "warning",
              title,
              body,
              data: {
                budgetId: budget.id,
                categoryId: budget.categoryId ?? undefined,
                projectId: budget.projectId ?? undefined,
                metric: "utilization",
                expected: budget.amount,
                actual: metrics.actual,
                threshold: level,
                utilization: metrics.utilization,
                periodFrom: range.from,
                periodTo: range.to,
                currency: ctx.baseCurrency,
                href: links.budget(budget.id),
                transactionsHref: view.drilldown.href,
              },
              entityType: "budget",
              entityId: budget.id,
              dedupeKey,
            },
            tx,
          );
          await this.notifications.notify(
            {
              workspaceId: ctx.workspaceId,
              kind: "budget_warning",
              severity: level >= 100 ? "critical" : "warning",
              title,
              body,
              link: links.budget(budget.id),
              entityType: "budget",
              entityId: budget.id,
              dedupeKey,
            },
            tx,
          );
          await this.events.publish(tx, ctx, "budget.threshold_reached", {
            budgetId: budget.id,
            threshold: level,
            utilization: metrics.utilization,
            actual: metrics.actual,
            budget: budget.amount,
            periodFrom: range.from,
            periodTo: range.to,
          });
        });
        alerts += 1;
      }
    }
    return { checked: rows.length, alerts, resolved };
  }
}
