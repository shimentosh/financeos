import { addMonths, eachDay, endOfMonth, monthKey, today } from "@financeos/core";
import type { AiUsageReportView } from "@financeos/core/contracts/ai-extra";
import { Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { aiUsage } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { loadBillingConfig } from "../billing/billing-config.js";
import { hit } from "../system/rate-limit.js";
import type { TokenUsage } from "./gateway/types.js";

/** ok | error | refusal | budget | credits | disabled. Budget, credits and disabled calls never reached the provider. */
export type AiUsageStatus = "ok" | "error" | "refusal" | "budget" | "credits" | "disabled";

export type AiUsageEntry = {
  workspaceId: string | null;
  userId: string | null;
  feature: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number | null;
  status: AiUsageStatus;
  error?: string | null;
};

export type Budget = {
  limitUsd: number | null;
  source: "workspace" | "default";
};

const money = (value: unknown) => Math.round(Number(value ?? 0) * 1_000_000) / 1_000_000;

/** Per-user AI request limit: 30 per minute, shared across API instances. */
@Injectable()
export class AiRateLimiter {
  allow(userId: string): Promise<boolean> {
    return hit(`ai:${userId}`, 30, 60);
  }
}

/** Every model call is recorded in ai_usage: what it cost, how long it took, whether it worked. */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger("AiUsage");

  async record(entry: AiUsageEntry): Promise<string | null> {
    try {
      const [row] = await db
        .insert(aiUsage)
        .values({
          workspaceId: entry.workspaceId,
          userId: entry.userId,
          feature: entry.feature,
          provider: entry.provider,
          model: entry.model,
          inputTokens: entry.usage.inputTokens,
          outputTokens: entry.usage.outputTokens,
          cacheReadTokens: entry.usage.cacheReadTokens,
          cacheWriteTokens: entry.usage.cacheWriteTokens,
          costUsd: entry.costUsd.toFixed(6),
          latencyMs: entry.latencyMs,
          status: entry.status,
          error: entry.error ? entry.error.slice(0, 1000) : null,
        })
        .returning({ id: aiUsage.id });
      return row?.id ?? null;
    } catch (error) {
      // Accounting must never break the feature it accounts for.
      this.logger.error(`Could not record AI usage: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The workspace's monthly ceiling in USD. Without billing, null means
   * unlimited (a budget of 0) and an unset budget uses AI_MONTHLY_BUDGET_USD.
   * With billing on, AI is paid for in the owner's credits and the budget is
   * only an optional extra cap the workspace sets itself: unset = none,
   * 0 = AI off for this workspace.
   */
  budgetFor(ctx: Pick<WorkspaceContext, "settings">, billingEnabled = false): Budget {
    const own = ctx.settings.aiMonthlyBudgetUsd;
    if (billingEnabled) {
      if (own === null || own === undefined) return { limitUsd: null, source: "default" };
      const cap = Number(own);
      return { limitUsd: Number.isFinite(cap) && cap >= 0 ? cap : null, source: "workspace" };
    }
    const source = own === null || own === undefined ? "default" : "workspace";
    const limit = source === "workspace" ? Number(own) : env.AI_MONTHLY_BUDGET_USD;
    return {
      limitUsd: Number.isFinite(limit) && limit > 0 ? limit : null,
      source,
    };
  }

  /** Month boundaries as instants, in the workspace's timezone. */
  private monthWindow(timezone: string, month: string) {
    const from = `${month}-01`;
    const to = addMonths(from, 1);
    return {
      from: sql`(${from}::timestamp at time zone ${timezone})`,
      to: sql`(${to}::timestamp at time zone ${timezone})`,
      firstDay: from,
      lastDay: endOfMonth(from),
    };
  }

  async spentThisMonth(ctx: Pick<WorkspaceContext, "workspaceId" | "timezone">): Promise<number> {
    const window = this.monthWindow(ctx.timezone, monthKey(today(ctx.timezone)));
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, ctx.workspaceId), gte(aiUsage.createdAt, window.from), lt(aiUsage.createdAt, window.to)));
    return money(row?.total);
  }

  async report(ctx: WorkspaceContext, month = monthKey(today(ctx.timezone))): Promise<AiUsageReportView> {
    const window = this.monthWindow(ctx.timezone, month);
    const where = and(eq(aiUsage.workspaceId, ctx.workspaceId), gte(aiUsage.createdAt, window.from), lt(aiUsage.createdAt, window.to));
    const sums = {
      calls: sql<number>`count(*)::int`,
      costUsd: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
    };
    const [totals, byFeature, byModel, byStatus, daily, recent] = await Promise.all([
      db
        .select({
          ...sums,
          cacheReadTokens: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::int`,
          cacheWriteTokens: sql<number>`coalesce(sum(${aiUsage.cacheWriteTokens}), 0)::int`,
          avgLatencyMs: sql<string | null>`avg(${aiUsage.latencyMs}) filter (where ${aiUsage.status} not in ('budget', 'credits', 'disabled'))`,
        })
        .from(aiUsage)
        .where(where),
      db
        .select({ feature: aiUsage.feature, ...sums })
        .from(aiUsage)
        .where(where)
        .groupBy(aiUsage.feature)
        .orderBy(desc(sql`sum(${aiUsage.costUsd})`)),
      db
        .select({ provider: aiUsage.provider, model: aiUsage.model, ...sums })
        .from(aiUsage)
        .where(where)
        .groupBy(aiUsage.provider, aiUsage.model)
        .orderBy(desc(sql`sum(${aiUsage.costUsd})`)),
      db.select({ status: aiUsage.status, calls: sql<number>`count(*)::int` }).from(aiUsage).where(where).groupBy(aiUsage.status),
      db
        .select({
          date: sql<string>`to_char(${aiUsage.createdAt} at time zone ${ctx.timezone}, 'YYYY-MM-DD')`,
          calls: sql<number>`count(*)::int`,
          costUsd: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`,
        })
        .from(aiUsage)
        .where(where)
        .groupBy(sql`1`),
      db.select().from(aiUsage).where(where).orderBy(desc(aiUsage.createdAt)).limit(20),
    ]);

    const statusCounts = Object.fromEntries(byStatus.map((row) => [row.status, row.calls])) as Record<string, number>;
    const total = totals[0];
    const blocked = (statusCounts.budget ?? 0) + (statusCounts.credits ?? 0) + (statusCounts.disabled ?? 0);
    const dailyMap = new Map(daily.map((row) => [row.date, row]));
    const budget = this.budgetFor(ctx, (await loadBillingConfig()).enabled);
    const spent = month === monthKey(today(ctx.timezone)) ? await this.spentThisMonth(ctx) : money(total?.costUsd);

    return {
      month,
      totals: {
        calls: total?.calls ?? 0,
        providerCalls: (total?.calls ?? 0) - blocked,
        ok: statusCounts.ok ?? 0,
        errors: statusCounts.error ?? 0,
        refusals: statusCounts.refusal ?? 0,
        blocked,
        inputTokens: total?.inputTokens ?? 0,
        outputTokens: total?.outputTokens ?? 0,
        cacheReadTokens: total?.cacheReadTokens ?? 0,
        cacheWriteTokens: total?.cacheWriteTokens ?? 0,
        costUsd: money(total?.costUsd),
        avgLatencyMs: total?.avgLatencyMs === null || total?.avgLatencyMs === undefined ? null : Math.round(Number(total.avgLatencyMs)),
      },
      byFeature: byFeature.map((row) => ({
        feature: row.feature,
        calls: row.calls,
        costUsd: money(row.costUsd),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      })),
      byModel: byModel.map((row) => ({
        provider: row.provider,
        model: row.model,
        calls: row.calls,
        costUsd: money(row.costUsd),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      })),
      byStatus: statusCounts,
      daily: eachDay(window.firstDay, window.lastDay).map((date) => {
        const row = dailyMap.get(date);
        return { date, calls: row?.calls ?? 0, costUsd: money(row?.costUsd) };
      }),
      budget: {
        ...budget,
        spentUsd: spent,
        remainingUsd: budget.limitUsd === null ? null : Math.max(0, money(budget.limitUsd - spent)),
        percentUsed: budget.limitUsd === null ? null : budget.limitUsd === 0 ? 100 : Math.round((spent / budget.limitUsd) * 1000) / 10,
      },
      recent: recent.map((row) => ({
        id: row.id,
        feature: row.feature,
        provider: row.provider,
        model: row.model,
        status: row.status,
        costUsd: money(row.costUsd),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        latencyMs: row.latencyMs,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
