import { type AccountInput, accountInput, accountUpdate, type Day, today } from "@financeos/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { financialAccounts, ledgerEntries, transactions } from "../../db/schema/index.js";
import { AuditService } from "../system/audit.service.js";
import { FxService } from "./fx.service.js";

export type AccountRow = typeof financialAccounts.$inferSelect;

export type AccountWithBalance = AccountRow & {
  balance: number;
  /** In the workspace base currency; null when no exchange rate exists. */
  baseBalance: number | null;
  /** Posted transactions touching the account. */
  entryCount: number;
  lastActivity: string | null;
};

@Injectable()
export class AccountsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<AccountRow> {
    const [row] = await exec
      .select()
      .from(financialAccounts)
      .where(and(eq(financialAccounts.id, id), eq(financialAccounts.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Account");
  }

  /** Opening balance plus every ledger entry up to `asOf`, per account. */
  async balances(workspaceId: string, asOf?: Day, accountIds?: string[], exec: Executor = db) {
    const rows = await exec
      .select({
        accountId: ledgerEntries.accountId,
        total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)`,
        entries: sql<number>`count(*)::int`,
        last: sql<string | null>`max(${ledgerEntries.date})`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.workspaceId, workspaceId),
          asOf ? lte(ledgerEntries.date, asOf) : undefined,
          accountIds?.length ? inArray(ledgerEntries.accountId, accountIds) : undefined,
        ),
      )
      .groupBy(ledgerEntries.accountId);
    return new Map(rows.map((row) => [row.accountId, { total: Number(row.total), entries: row.entries, last: row.last }]));
  }

  async list(ctx: WorkspaceContext, options: { includeArchived?: boolean; asOf?: Day } = {}): Promise<AccountWithBalance[]> {
    const accounts = await db
      .select()
      .from(financialAccounts)
      .where(and(eq(financialAccounts.workspaceId, ctx.workspaceId), options.includeArchived ? undefined : eq(financialAccounts.status, "active")))
      .orderBy(asc(financialAccounts.sortOrder), asc(financialAccounts.createdAt));
    const asOf = options.asOf ?? today(ctx.timezone);
    const sums = await this.balances(ctx.workspaceId, asOf);
    return Promise.all(
      accounts.map(async (account) => {
        const sum = sums.get(account.id);
        const opening = account.openingDate <= asOf ? account.openingBalance : 0;
        const balance = opening + (sum?.total ?? 0);
        const baseBalance =
          account.currency === ctx.baseCurrency ? balance : await this.fx.tryConvert(balance, account.currency, ctx.baseCurrency, asOf, ctx.workspaceId);
        return { ...account, balance, baseBalance, entryCount: sum?.entries ?? 0, lastActivity: sum?.last ?? null };
      }),
    );
  }

  async detail(ctx: WorkspaceContext, id: string) {
    const account = await this.get(ctx, id);
    const [withBalance] = (await this.list(ctx, { includeArchived: true })).filter((a) => a.id === id);
    // Month-end balances for the last 12 months, for the account's chart.
    const history = await db.execute<{ month: string; closing: string }>(sql`
      with months as (
        select to_char(d, 'YYYY-MM') as month, (date_trunc('month', d) + interval '1 month - 1 day')::date as month_end
        from generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month') as d
      )
      select m.month,
        (case when ${account.openingDate}::date <= m.month_end then ${account.openingBalance} else 0 end
          + coalesce((select sum(e.amount) from ${ledgerEntries} e where e.account_id = ${id} and e.date <= m.month_end), 0))::text as closing
      from months m order by m.month
    `);
    return {
      ...(withBalance ?? { ...account, balance: account.openingBalance, baseBalance: null, entryCount: 0, lastActivity: null }),
      history: history.rows.map((row) => ({ month: row.month, balance: Number(row.closing) })),
    };
  }

  async create(ctx: WorkspaceContext, raw: AccountInput) {
    const input = accountInput.parse(raw);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(financialAccounts)
        .values({
          workspaceId: ctx.workspaceId,
          ...input,
          isLiability: input.isLiability ?? input.kind === "card",
        })
        .returning();
      await this.audit.record(tx, ctx, { action: "account.created", entityType: "account", entityId: row?.id, after: row });
      return row as AccountRow;
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof accountUpdate>) {
    const input = accountUpdate.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      if (input.currency && input.currency !== before.currency) {
        const [used] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.accountId, id)).limit(1);
        if (used) throw conflict("The currency of an account with transactions cannot change", "currency_locked");
      }
      const [row] = await tx
        .update(financialAccounts)
        .set(input)
        .where(and(eq(financialAccounts.id, id), eq(financialAccounts.workspaceId, ctx.workspaceId)))
        .returning();
      await this.audit.record(tx, ctx, { action: "account.updated", entityType: "account", entityId: id, before, after: row });
      return row as AccountRow;
    });
  }

  /** Archive rather than delete when history exists: the ledger must stay whole. */
  async remove(ctx: WorkspaceContext, id: string) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const [used] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, ctx.workspaceId), sql`(${transactions.accountId} = ${id} or ${transactions.toAccountId} = ${id})`))
        .limit(1);
      if (used) {
        await tx.update(financialAccounts).set({ status: "archived" }).where(eq(financialAccounts.id, id));
        await this.audit.record(tx, ctx, { action: "account.archived", entityType: "account", entityId: id, before });
        return { archived: true };
      }
      await tx.delete(financialAccounts).where(eq(financialAccounts.id, id));
      await this.audit.record(tx, ctx, { action: "account.deleted", entityType: "account", entityId: id, before });
      return { deleted: true };
    });
  }

  /**
   * Compares the books with the statement balance. The difference is shown,
   * and optionally posted as an adjustment so the two agree from here on.
   */
  async reconcile(
    ctx: WorkspaceContext,
    id: string,
    input: { statementBalance: number; asOf: Day; adjust: boolean },
    postAdjustment: (amount: number, direction: "in" | "out") => Promise<string>,
  ) {
    const account = await this.get(ctx, id);
    const sums = await this.balances(ctx.workspaceId, input.asOf, [id]);
    const bookBalance = (account.openingDate <= input.asOf ? account.openingBalance : 0) + (sums.get(id)?.total ?? 0);
    const difference = input.statementBalance - bookBalance;
    let adjustmentId: string | null = null;
    if (input.adjust && difference !== 0) {
      adjustmentId = await postAdjustment(Math.abs(difference), difference > 0 ? "in" : "out");
    }
    const reconciled = difference === 0 || adjustmentId !== null;
    if (reconciled) {
      await db.transaction(async (tx) => {
        await tx
          .update(financialAccounts)
          .set({ lastReconciledAt: new Date(), lastReconciledBalance: input.statementBalance })
          .where(eq(financialAccounts.id, id));
        await this.audit.record(tx, ctx, {
          action: "account.reconciled",
          entityType: "account",
          entityId: id,
          after: { statementBalance: input.statementBalance, bookBalance, difference, adjustmentId, asOf: input.asOf },
        });
      });
    }
    return { bookBalance, statementBalance: input.statementBalance, difference, reconciled, adjustmentId };
  }
}
