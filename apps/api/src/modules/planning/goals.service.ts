import {
  addMonths,
  eachMonth,
  formatMoney,
  type GoalProgress,
  goalContributionInput,
  goalInput,
  goalProgress,
  goalUpdate,
  startOfMonth,
  today as todayIn,
} from "@expensewise/core";
import { type GoalQuery, goalQuery } from "@expensewise/core/contracts/planning-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { files, financialAccounts, goalContributions, goals, transactions } from "../../db/schema/index.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { NotificationsService } from "../system/notify.service.js";
import { BaseConverter, type GoalRow, links } from "./planning.shared.js";

export type { GoalRow } from "./planning.shared.js";
export type GoalContributionRow = typeof goalContributions.$inferSelect;

const CONTRIBUTION_ORIGIN = "goal_contribution";

type Standing = {
  current: number;
  contributed: number;
  currentSource: "account" | "contributions";
  linkedAccountName: string | null;
  linkedAccountCurrency: string | null;
  /** The linked account's balance could not be converted to the goal currency. */
  accountUnconverted: boolean;
};

export type GoalView = GoalRow &
  Standing & {
    progress: GoalProgress;
    isSavingsPlan: boolean;
    isDreamAsset: boolean;
    baseCurrency: string;
    targetBase: number | null;
    currentBase: number | null;
    links: { self: string };
  };

/**
 * Goals, dream assets (kind `dream_asset`) and savings plans (a goal with a
 * monthly plan). Progress is the linked account's balance when one is set,
 * otherwise the starting amount plus contributions.
 */
@Injectable()
export class GoalsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<GoalRow> {
    const [row] = await exec
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Goal");
  }

  /** Current standing of each goal. */
  private async standings(ctx: WorkspaceContext, rows: GoalRow[], exec: Executor = db): Promise<Map<string, Standing>> {
    const result = new Map<string, Standing>();
    if (!rows.length) return result;
    const sums = await exec
      .select({ goalId: goalContributions.goalId, total: sql<string>`coalesce(sum(${goalContributions.amount}), 0)` })
      .from(goalContributions)
      .where(
        inArray(
          goalContributions.goalId,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(goalContributions.goalId);
    const contributed = new Map(sums.map((row) => [row.goalId, Number(row.total)]));
    const linkedIds = [...new Set(rows.map((row) => row.linkedAccountId).filter((id): id is string => Boolean(id)))];
    const today = todayFor(ctx);
    const balances = new Map<string, { balance: number; currency: string; name: string }>();
    if (linkedIds.length) {
      const [sumsByAccount, accountRows] = await Promise.all([
        this.accounts.balances(ctx.workspaceId, today, linkedIds, exec),
        exec
          .select()
          .from(financialAccounts)
          .where(and(eq(financialAccounts.workspaceId, ctx.workspaceId), inArray(financialAccounts.id, linkedIds))),
      ]);
      for (const account of accountRows) {
        const opening = account.openingDate <= today ? account.openingBalance : 0;
        balances.set(account.id, { balance: opening + (sumsByAccount.get(account.id)?.total ?? 0), currency: account.currency, name: account.name });
      }
    }
    for (const row of rows) {
      const fromContributions = row.startingAmount + (contributed.get(row.id) ?? 0);
      const account = row.linkedAccountId ? balances.get(row.linkedAccountId) : undefined;
      let current = fromContributions;
      let currentSource: Standing["currentSource"] = "contributions";
      let accountUnconverted = false;
      if (account) {
        const converted =
          account.currency === row.currency
            ? account.balance
            : await this.fx.tryConvert(account.balance, account.currency, row.currency, today, ctx.workspaceId, exec);
        if (converted === null) accountUnconverted = true;
        else {
          current = converted;
          currentSource = "account";
        }
      }
      result.set(row.id, {
        current,
        contributed: contributed.get(row.id) ?? 0,
        currentSource,
        linkedAccountName: account?.name ?? null,
        linkedAccountCurrency: account?.currency ?? null,
        accountUnconverted,
      });
    }
    return result;
  }

  private async views(ctx: WorkspaceContext, rows: GoalRow[]): Promise<GoalView[]> {
    const today = todayFor(ctx);
    const standings = await this.standings(ctx, rows);
    const converter = new BaseConverter(this.fx, ctx, today);
    return Promise.all(
      rows.map(async (row) => {
        const standing = standings.get(row.id) as Standing;
        return {
          ...row,
          ...standing,
          progress: goalProgress({ target: row.targetAmount, current: standing.current, targetDate: row.targetDate, monthlyPlan: row.monthlyPlan, today }),
          isSavingsPlan: row.monthlyPlan !== null && row.monthlyPlan > 0,
          isDreamAsset: row.kind === "dream_asset",
          baseCurrency: ctx.baseCurrency,
          targetBase: await converter.convert(row.targetAmount, row.currency),
          currentBase: await converter.convert(standing.current, row.currency),
          links: { self: links.goal(row.id) },
        };
      }),
    );
  }

  /** Marks an active goal achieved once it reaches its target, notifying once. */
  private async maybeAchieve(tx: Executor, ctx: WorkspaceContext, goal: GoalRow): Promise<GoalRow> {
    if (goal.status !== "active") return goal;
    const standing = (await this.standings(ctx, [goal], tx)).get(goal.id);
    if (!standing || standing.current < goal.targetAmount) return goal;
    const [achieved] = await tx
      .update(goals)
      .set({ status: "achieved", achievedAt: new Date() })
      .where(and(eq(goals.id, goal.id), eq(goals.status, "active")))
      .returning();
    if (!achieved) return goal;
    await this.audit.record(tx, ctx, {
      action: "goal.achieved",
      entityType: "goal",
      entityId: goal.id,
      before: goal,
      after: { ...achieved, current: standing.current },
    });
    await this.notifications.notify(
      {
        workspaceId: ctx.workspaceId,
        kind: "goal_achieved",
        severity: "success",
        title: `Goal reached: ${goal.name}`,
        body: `${goal.name} reached ${formatMoney(standing.current, goal.currency)} of its ${formatMoney(goal.targetAmount, goal.currency)} target.`,
        link: links.goal(goal.id),
        entityType: "goal",
        entityId: goal.id,
        dedupeKey: `goal:${goal.id}:achieved`,
      },
      tx,
    );
    return achieved;
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof goalInput>) {
    const input = goalInput.parse(raw);
    const row = await db.transaction(async (tx) => {
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.linkedAccountId], "Account");
      await assertInWorkspace(tx, files, ctx.workspaceId, [input.imageFileId], "Image");
      const [inserted] = await tx
        .insert(goals)
        .values({
          workspaceId: ctx.workspaceId,
          kind: input.kind,
          name: input.name,
          targetAmount: input.targetAmount,
          currency: input.currency,
          targetDate: input.targetDate ?? null,
          priority: input.priority,
          monthlyPlan: input.monthlyPlan ?? null,
          startingAmount: input.startingAmount,
          linkedAccountId: input.linkedAccountId ?? null,
          icon: input.icon ?? null,
          imageFileId: input.imageFileId ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      const goal = inserted as GoalRow;
      await this.audit.record(tx, ctx, { action: "goal.created", entityType: "goal", entityId: goal.id, after: goal });
      return this.maybeAchieve(tx, ctx, goal);
    });
    return this.detail(ctx, row.id);
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof goalUpdate>) {
    const changes = goalUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [changes.linkedAccountId], "Account");
      await assertInWorkspace(tx, files, ctx.workspaceId, [changes.imageFileId], "Image");
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<GoalRow>;
      if (changes.status && changes.status !== before.status) {
        defined.achievedAt = changes.status === "achieved" ? (before.achievedAt ?? new Date()) : changes.status === "active" ? null : before.achievedAt;
      }
      const [after] = await tx.update(goals).set(defined).where(eq(goals.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "goal.updated", entityType: "goal", entityId: id, before, after });
      // Reopening a goal on purpose keeps it open until the next contribution.
      if (!changes.status) await this.maybeAchieve(tx, ctx, after as GoalRow);
    });
    return this.detail(ctx, id);
  }

  /** Deleted when nothing was contributed; archived otherwise so the history stays. */
  async remove(ctx: WorkspaceContext, id: string) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const [contribution] = await tx.select({ id: goalContributions.id }).from(goalContributions).where(eq(goalContributions.goalId, id)).limit(1);
      if (contribution) {
        await tx.update(goals).set({ status: "archived" }).where(eq(goals.id, id));
        await this.audit.record(tx, ctx, { action: "goal.archived", entityType: "goal", entityId: id, before });
        return { deleted: false, archived: true };
      }
      await tx.delete(goals).where(eq(goals.id, id));
      await this.audit.record(tx, ctx, { action: "goal.deleted", entityType: "goal", entityId: id, before });
      return { deleted: true, archived: false };
    });
  }

  async list(ctx: WorkspaceContext, raw: GoalQuery = {}) {
    const query = goalQuery.parse(raw);
    const where: SQL[] = [eq(goals.workspaceId, ctx.workspaceId)];
    if (query.kind?.length) where.push(inArray(goals.kind, query.kind));
    if (query.status?.length) where.push(inArray(goals.status, query.status));
    if (query.savingsPlan === true) where.push(isNotNull(goals.monthlyPlan), sql`${goals.monthlyPlan} > 0`);
    if (query.savingsPlan === false) where.push(sql`coalesce(${goals.monthlyPlan}, 0) = 0`);
    const rows = await db
      .select()
      .from(goals)
      .where(and(...where))
      .orderBy(sql`case ${goals.status} when 'active' then 0 when 'paused' then 1 when 'achieved' then 2 else 3 end`, asc(goals.targetDate), asc(goals.name));
    const items = await this.views(ctx, rows);
    const active = items.filter((item) => item.status === "active");
    const converter = new BaseConverter(this.fx, ctx, todayFor(ctx));
    let monthlyPlanned = 0;
    for (const item of active) monthlyPlanned += item.monthlyPlan ? ((await converter.convert(item.monthlyPlan, item.currency)) ?? 0) : 0;
    return {
      items,
      total: items.length,
      baseCurrency: ctx.baseCurrency,
      summary: {
        active: active.length,
        achieved: items.filter((item) => item.status === "achieved").length,
        targetBase: active.reduce((total, item) => total + (item.targetBase ?? 0), 0),
        currentBase: active.reduce((total, item) => total + (item.currentBase ?? 0), 0),
        /** Planned monthly saving across active goals, in the base currency. */
        monthlyPlanned,
        unconverted: active
          .filter((item) => item.targetBase === null || item.currentBase === null)
          .map((item) => ({ goalId: item.id, currency: item.currency })),
      },
    };
  }

  /** The goal, its contributions (newest first) and planned vs actual by month. */
  async detail(ctx: WorkspaceContext, id: string) {
    const goal = await this.get(ctx, id);
    const [view] = await this.views(ctx, [goal]);
    const contributions = await db
      .select({
        contribution: goalContributions,
        transaction: {
          id: transactions.id,
          status: transactions.status,
          amount: transactions.amount,
          currency: transactions.currency,
          accountId: transactions.accountId,
          toAccountId: transactions.toAccountId,
        },
      })
      .from(goalContributions)
      .leftJoin(transactions, eq(transactions.id, goalContributions.transactionId))
      .where(and(eq(goalContributions.goalId, id), eq(goalContributions.workspaceId, ctx.workspaceId)))
      .orderBy(asc(goalContributions.date), asc(goalContributions.createdAt));

    const today = todayFor(ctx);
    const created = todayIn(ctx.timezone, goal.createdAt);
    const firstContribution = contributions[0]?.contribution.date;
    const start = startOfMonth(firstContribution && firstContribution < created ? firstContribution : created);
    const months = eachMonth(start < addMonths(startOfMonth(today), -23) ? addMonths(startOfMonth(today), -23) : start, today, 24);
    let running =
      goal.startingAmount +
      contributions.filter((c) => c.contribution.date < `${months[0] ?? today.slice(0, 7)}-01`).reduce((total, c) => total + c.contribution.amount, 0);
    const monthly = months.map((month) => {
      const inMonth = contributions.filter((c) => c.contribution.date.startsWith(month)).map((c) => c.contribution.amount);
      const actual = inMonth.reduce((total, amount) => total + amount, 0);
      running += actual;
      return {
        month,
        planned: goal.monthlyPlan,
        actual,
        deposits: inMonth.filter((amount) => amount > 0).reduce((total, amount) => total + amount, 0),
        withdrawals: -inMonth.filter((amount) => amount < 0).reduce((total, amount) => total + amount, 0),
        cumulative: running,
        metPlan: goal.monthlyPlan ? actual >= goal.monthlyPlan : null,
      };
    });

    return {
      ...(view as GoalView),
      contributions: contributions
        .map((row) => ({ ...row.contribution, transaction: row.transaction, transactionHref: row.transaction ? links.transaction(row.transaction.id) : null }))
        .reverse(),
      monthly,
    };
  }

  /**
   * Adds (positive) or withdraws (negative) money. With `transfer`, the money
   * also moves between two accounts as a transfer transaction.
   */
  async addContribution(ctx: WorkspaceContext, goalId: string, raw: z.input<typeof goalContributionInput>) {
    const input = goalContributionInput.parse(raw);
    const result = await db.transaction(async (tx) => {
      const goal = await this.get(ctx, goalId, tx);
      if (goal.status === "archived") throw conflict("This goal is archived", "goal_archived");
      if (input.amount < 0 && !goal.linkedAccountId) {
        const standing = (await this.standings(ctx, [goal], tx)).get(goal.id);
        if (standing && standing.current + input.amount < 0) {
          throw unprocessable(`That is more than the ${formatMoney(standing.current, goal.currency)} this goal holds`, "insufficient_goal_balance");
        }
      }
      let transactionId: string | null = null;
      if (input.transfer) {
        const { fromAccountId, toAccountId } = input.transfer;
        if (fromAccountId === toAccountId) throw unprocessable("Choose two different accounts", "same_account");
        await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [fromAccountId, toAccountId], "Account");
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "transfer",
            accountId: fromAccountId,
            toAccountId,
            amount: Math.abs(input.amount),
            currency: goal.currency,
            date: input.date,
            description: `${input.amount > 0 ? "Saving for" : "Withdrawal from"} ${goal.name}`,
            notes: input.note ?? null,
          },
          { exec: tx, metadata: { origin: CONTRIBUTION_ORIGIN, goalId } },
        );
        transactionId = transaction.id;
      }
      const [contribution] = await tx
        .insert(goalContributions)
        .values({
          workspaceId: ctx.workspaceId,
          goalId,
          amount: input.amount,
          date: input.date,
          note: input.note ?? null,
          transactionId,
          createdBy: ctx.userId,
        })
        .returning();
      await this.audit.record(tx, ctx, {
        action: input.amount > 0 ? "goal.contribution_added" : "goal.withdrawal_added",
        entityType: "goal",
        entityId: goalId,
        after: contribution,
      });
      const after = await this.maybeAchieve(tx, ctx, goal);
      return { contribution: contribution as GoalContributionRow, achieved: after.status === "achieved" && goal.status !== "achieved" };
    });
    return { ...result, goal: await this.detail(ctx, goalId) };
  }

  /** Removes a contribution; a transfer it created is voided with it. */
  async removeContribution(ctx: WorkspaceContext, goalId: string, contributionId: string) {
    await db.transaction(async (tx) => {
      await this.get(ctx, goalId, tx);
      const [before] = await tx
        .select()
        .from(goalContributions)
        .where(and(eq(goalContributions.id, contributionId), eq(goalContributions.goalId, goalId), eq(goalContributions.workspaceId, ctx.workspaceId)))
        .limit(1);
      const contribution = assertFound(before, "Contribution");
      await tx.delete(goalContributions).where(eq(goalContributions.id, contributionId));
      if (contribution.transactionId) {
        const transaction = await this.transactions.get(ctx, contribution.transactionId, tx);
        if (transaction.metadata?.origin === CONTRIBUTION_ORIGIN && transaction.status !== "void") {
          await this.transactions.void(ctx, transaction.id, "Goal contribution removed", { exec: tx });
        }
      }
      await this.audit.record(tx, ctx, { action: "goal.contribution_removed", entityType: "goal", entityId: goalId, before: contribution });
    });
    return this.detail(ctx, goalId);
  }

  /** For the hourly scan: goals whose linked account reached the target. */
  async checkAchievements(ctx: WorkspaceContext): Promise<number> {
    const rows = await db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, ctx.workspaceId), eq(goals.status, "active")))
      .orderBy(desc(goals.createdAt));
    let achieved = 0;
    for (const goal of rows) {
      const after = await db.transaction((tx) => this.maybeAchieve(tx, ctx, goal));
      if (after.status === "achieved") achieved += 1;
    }
    return achieved;
  }
}
