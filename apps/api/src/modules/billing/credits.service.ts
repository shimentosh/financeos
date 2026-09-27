import type { CreditKind, CreditSummary } from "@expensewise/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, type Executor } from "../../db/index.js";
import { creditTransactions } from "../../db/schema/index.js";
import { loadBillingConfig } from "./billing-config.js";
import { EntitlementsService, type ResolvedPlan } from "./entitlements.service.js";
import { calendarMonthUtc, monthlyWindow } from "./periods.js";

/** Credits for one AI call: 1 credit per 1/creditsPerUsd of model cost, rounded up, at least 1. */
export function creditsFor(costUsd: number, creditsPerUsd: number): number {
  const exact = Math.round(Math.max(0, costUsd) * creditsPerUsd * 1_000_000) / 1_000_000;
  return Math.max(1, Math.ceil(exact));
}

/**
 * AI credits. Each user (the owner of the workspaces that used them) has the
 * plan's monthly allowance and a balance of bought or granted credits that
 * never expires. Usage comes out of the allowance first, then the balance.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger("Credits");

  constructor(@Inject(EntitlementsService) private readonly entitlements: EntitlementsService) {}

  async billingEnabled(): Promise<boolean> {
    return (await loadBillingConfig()).enabled;
  }

  /** The allowance period containing `now`: month-long windows from the plan's start, else the UTC calendar month. */
  period(resolved: ResolvedPlan, now = new Date()): { start: Date; end: Date } {
    const row = resolved.row;
    const onPaidPeriod =
      resolved.plan !== "free" && resolved.plan !== "unlimited" && row?.currentPeriodStart && (!row.currentPeriodEnd || row.currentPeriodEnd > now);
    if (onPaidPeriod && row?.currentPeriodStart) return monthlyWindow(row.currentPeriodStart, now);
    return calendarMonthUtc(now);
  }

  async summary(userId: string, preresolved?: ResolvedPlan, now = new Date()): Promise<CreditSummary> {
    const resolved = preresolved ?? (await this.entitlements.resolve(userId, now));
    const { start, end } = this.period(resolved, now);
    const [[used], [balance]] = await Promise.all([
      db
        .select({ total: sql<string>`coalesce(sum(${creditTransactions.credits}), 0)` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.userId, userId),
            eq(creditTransactions.source, "allowance"),
            gte(creditTransactions.createdAt, start),
            lt(creditTransactions.createdAt, end),
          ),
        ),
      db
        .select({ total: sql<string>`coalesce(sum(${creditTransactions.credits}), 0)` })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.source, "balance"))),
    ]);
    const allowance = resolved.limits.aiCreditsPerMonth;
    // Allowance rows are usage (negative); an admin adjustment on the allowance counts back.
    const usedThisPeriod = Math.max(0, -Number(used?.total ?? 0));
    return {
      allowance,
      usedThisPeriod,
      remainingAllowance: Math.max(0, allowance - usedThisPeriod),
      balance: Number(balance?.total ?? 0),
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    };
  }

  /** Whether the workspace's owner has any credit left. Always true with billing off. */
  async canSpend(workspaceId: string): Promise<boolean> {
    const resolved = await this.entitlements.resolveWorkspace(workspaceId);
    if (!resolved.billingEnabled || !resolved.userId) return true;
    const summary = await this.summary(resolved.userId, resolved);
    return summary.remainingAllowance + summary.balance > 0;
  }

  /** The owner's credits for the AI status of a workspace; null when not billed. */
  async statusFor(workspaceId: string) {
    const resolved = await this.entitlements.resolveWorkspace(workspaceId);
    if (!resolved.billingEnabled || !resolved.userId) return null;
    const summary = await this.summary(resolved.userId, resolved);
    return {
      allowance: summary.allowance,
      remainingAllowance: summary.remainingAllowance,
      balance: summary.balance,
      remaining: summary.remainingAllowance + Math.max(0, summary.balance),
      periodEnd: summary.periodEnd,
    };
  }

  /**
   * Takes the credits for one recorded AI call from the owner's allowance,
   * then their balance (two rows when it spans both). Never throws: a
   * bookkeeping failure must not break the feature it accounts for.
   */
  async charge(input: { workspaceId: string; usageId: string | null; costUsd: number }): Promise<number> {
    try {
      const config = await loadBillingConfig();
      if (!config.enabled) return 0;
      const resolved = await this.entitlements.resolveWorkspace(input.workspaceId);
      if (!resolved.billingEnabled || !resolved.userId) return 0;
      const userId = resolved.userId;
      const credits = creditsFor(input.costUsd, config.creditsPerUsd);
      const summary = await this.summary(userId, resolved);
      const fromAllowance = Math.min(credits, summary.remainingAllowance);
      const fromBalance = credits - fromAllowance;
      const cost = Math.max(0, input.costUsd);
      const shareOf = (part: number) => ((cost * part) / credits).toFixed(6);
      const base = { userId, workspaceId: input.workspaceId, kind: "usage" as const, aiUsageId: input.usageId };
      const rows = [
        ...(fromAllowance > 0 ? [{ ...base, source: "allowance" as const, credits: -fromAllowance, costUsd: shareOf(fromAllowance) }] : []),
        ...(fromBalance > 0 ? [{ ...base, source: "balance" as const, credits: -fromBalance, costUsd: shareOf(fromBalance) }] : []),
      ];
      if (rows.length) await db.insert(creditTransactions).values(rows);
      return credits;
    } catch (error) {
      this.logger.error(`Could not charge AI credits: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /**
   * Adds (or with a negative number, removes) balance credits. One grant per
   * payment: a second grant for the same payment is ignored, so webhooks and
   * callbacks can repeat safely. Returns whether a row was written.
   */
  async grant(
    input: { userId: string; credits: number; kind: Exclude<CreditKind, "usage">; paymentId?: string | null; note?: string | null; createdBy?: string | null },
    exec: Executor = db,
  ): Promise<boolean> {
    const inserted = await exec
      .insert(creditTransactions)
      .values({
        userId: input.userId,
        kind: input.kind,
        source: "balance",
        credits: input.credits,
        paymentId: input.paymentId ?? null,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: creditTransactions.id });
    return inserted.length > 0;
  }
}
