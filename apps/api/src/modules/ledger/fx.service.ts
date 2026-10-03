import { convertMinor, type Day, invertRate } from "@financeos/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { exchangeRates } from "../../db/schema/index.js";
import { AuditService } from "../system/audit.service.js";

@Injectable()
export class FxService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  private async lookup(exec: Executor, workspaceId: string, from: string, to: string, date: Day) {
    const base = and(eq(exchangeRates.workspaceId, workspaceId), eq(exchangeRates.fromCurrency, from), eq(exchangeRates.toCurrency, to));
    const [onOrBefore] = await exec
      .select({ rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(and(base, lte(exchangeRates.date, date)))
      .orderBy(desc(exchangeRates.date))
      .limit(1);
    if (onOrBefore) return onOrBefore.rate;
    // Before the first recorded rate: the earliest one is the best evidence.
    const [after] = await exec
      .select({ rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(and(base, gt(exchangeRates.date, date)))
      .orderBy(asc(exchangeRates.date))
      .limit(1);
    return after?.rate ?? null;
  }

  /** 1 `from` = rate `to`, as of `date`. Tries the inverse pair too. */
  async rate(from: string, to: string, date: Day, workspaceId: string, exec: Executor = db): Promise<string | null> {
    const a = from.toUpperCase();
    const b = to.toUpperCase();
    if (a === b) return "1";
    const direct = await this.lookup(exec, workspaceId, a, b, date);
    if (direct) return direct;
    const inverse = await this.lookup(exec, workspaceId, b, a, date);
    return inverse ? invertRate(inverse) : null;
  }

  /** Converts or explains exactly which rate is missing. */
  async convert(amount: number, from: string, to: string, date: Day, workspaceId: string, exec: Executor = db): Promise<{ amount: number; rate: string }> {
    const rate = await this.rate(from, to, date, workspaceId, exec);
    if (!rate) {
      throw unprocessable(
        `No ${from.toUpperCase()}→${to.toUpperCase()} exchange rate for ${date}. Add one in Settings → Currency, or enter the converted amount.`,
        "missing_exchange_rate",
      );
    }
    return { amount: convertMinor(amount, from, to, rate), rate };
  }

  /** Converts when possible; null when no rate exists (for net worth warnings). */
  async tryConvert(amount: number, from: string, to: string, date: Day, workspaceId: string, exec: Executor = db): Promise<number | null> {
    const rate = await this.rate(from, to, date, workspaceId, exec);
    return rate ? convertMinor(amount, from, to, rate) : null;
  }

  list(ctx: WorkspaceContext) {
    return db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.workspaceId, ctx.workspaceId))
      .orderBy(asc(exchangeRates.fromCurrency), asc(exchangeRates.toCurrency), desc(exchangeRates.date));
  }

  async upsert(ctx: WorkspaceContext, input: { fromCurrency: string; toCurrency: string; rate: string; date: Day }) {
    if (input.fromCurrency === input.toCurrency) throw unprocessable("A rate needs two different currencies");
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(exchangeRates)
        .values({ workspaceId: ctx.workspaceId, ...input, source: "manual" })
        .onConflictDoUpdate({
          target: [exchangeRates.workspaceId, exchangeRates.fromCurrency, exchangeRates.toCurrency, exchangeRates.date],
          set: { rate: input.rate, source: "manual" },
        })
        .returning();
      await this.audit.record(tx, ctx, { action: "exchange_rate.set", entityType: "exchange_rate", entityId: row?.id, after: row });
      return row;
    });
  }

  async remove(ctx: WorkspaceContext, id: string) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(exchangeRates)
        .where(and(eq(exchangeRates.id, id), eq(exchangeRates.workspaceId, ctx.workspaceId)))
        .returning();
      if (row) await this.audit.record(tx, ctx, { action: "exchange_rate.deleted", entityType: "exchange_rate", entityId: id, before: row });
    });
  }
}
