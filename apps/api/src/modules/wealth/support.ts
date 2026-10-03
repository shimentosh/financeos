import { convertMinor, type Day, normalizeName, today } from "@financeos/core";
import { and, asc, eq } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { categories } from "../../db/schema/index.js";
import type { FxService } from "../ledger/fx.service.js";
import type { AuditService } from "../system/audit.service.js";

/**
 * Converts amounts to one currency, remembering each rate it looked up, so a
 * report that converts hundreds of amounts asks the database once per
 * currency and day. `null` means no rate exists: callers report it, never
 * count it as zero.
 */
export class RateBook {
  private readonly rates = new Map<string, Promise<string | null>>();

  constructor(
    private readonly fx: FxService,
    private readonly workspaceId: string,
    private readonly exec: Executor = db,
  ) {}

  rate(from: string, to: string, date: Day): Promise<string | null> {
    const a = from.toUpperCase();
    const b = to.toUpperCase();
    if (a === b) return Promise.resolve("1");
    const key = `${a}|${b}|${date}`;
    let pending = this.rates.get(key);
    if (!pending) {
      pending = this.fx.rate(a, b, date, this.workspaceId, this.exec);
      this.rates.set(key, pending);
    }
    return pending;
  }

  async convert(amount: number, from: string, to: string, date: Day): Promise<number | null> {
    if (from.toUpperCase() === to.toUpperCase()) return amount;
    const rate = await this.rate(from, to, date);
    return rate === null ? null : convertMinor(amount, from, to, rate);
  }
}

/** The fields of a transaction needed to restate it in another currency. */
export type MoneyRow = {
  amount: number;
  currency: string;
  baseAmount: number | null;
  baseCurrency: string | null;
  date: Day;
  costBasis?: number | null;
};

/**
 * A linked transaction's amount (and released cost basis) in the currency of
 * the holding or debt it belongs to. Uses the recorded amounts when the
 * currencies line up, otherwise the rate on the transaction date.
 */
export async function restate(row: MoneyRow, target: string, rates: RateBook): Promise<{ amount: number; costBasis: number | null } | null> {
  if (row.currency === target) return { amount: row.amount, costBasis: row.costBasis ?? null };
  let amount: number | null = null;
  if (row.baseCurrency === target && row.baseAmount !== null) amount = row.baseAmount;
  else amount = await rates.convert(row.amount, row.currency, target, row.date);
  if (amount === null) return null;
  const costBasis = row.costBasis === null || row.costBasis === undefined ? null : row.amount > 0 ? Math.round((row.costBasis * amount) / row.amount) : 0;
  return { amount, costBasis };
}

/**
 * Finds an expense or income category by name (top-level first), creating it
 * when the workspace has none. Idempotent under concurrency: the unique
 * (workspace, kind, parent, name) index resolves a race to one row.
 */
export async function ensureCategory(
  exec: Executor,
  ctx: WorkspaceContext,
  audit: AuditService,
  spec: { name: string; kind: "expense" | "income"; icon?: string; color?: string },
): Promise<string> {
  const wanted = normalizeName(spec.name);
  const rows = await exec
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, archived: categories.archived })
    .from(categories)
    .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.kind, spec.kind)))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt));
  const matches = rows.filter((row) => normalizeName(row.name) === wanted);
  const best =
    matches.find((row) => !row.archived && !row.parentId) ?? matches.find((row) => !row.archived) ?? matches.find((row) => !row.parentId) ?? matches[0];
  if (best) return best.id;

  const [created] = await exec
    .insert(categories)
    .values({ workspaceId: ctx.workspaceId, name: spec.name, kind: spec.kind, icon: spec.icon ?? null, color: spec.color ?? null, sortOrder: 999 })
    .onConflictDoNothing()
    .returning();
  if (created) {
    await audit.record(exec, ctx, { action: "category.created", entityType: "category", entityId: created.id, after: created, source: "system" });
    return created.id;
  }
  const [existing] = await exec
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.kind, spec.kind), eq(categories.name, spec.name)))
    .limit(1);
  if (!existing) throw new Error(`Could not create the ${spec.name} category`);
  return existing.id;
}

/** Payroll and similar features exist only in business workspaces. */
export function assertBusiness(ctx: WorkspaceContext) {
  if (ctx.workspaceKind !== "business") throw unprocessable("This is available in business workspaces", "business_only");
}

/** The calendar day a timestamp fell on, in the workspace's timezone. */
export function dayOf(instant: Date, timezone: string): Day {
  return today(timezone, instant);
}

/**
 * Maps one item at a time. Used wherever the executor may be an open
 * transaction: a transaction is a single connection, which must not be asked
 * to run queries concurrently.
 */
export async function mapSeries<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** Percent with one decimal, null when the whole is zero. */
export function share(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 1000) / 10 : null;
}
