import { convertMinor, type Day, DEFAULT_REMINDER_OFFSETS, maxDay, nextDueOnOrAfter, type Schedule } from "@financeos/core";
import { eq } from "drizzle-orm";
import { contextFor, type WorkspaceContext } from "../../common/context.js";
import { db, type Executor } from "../../db/index.js";
import { type commitmentOccurrences, type commitments, type goals, type subscriptions, workspaces } from "../../db/schema/index.js";
import type { FxService } from "../ledger/fx.service.js";

export type CommitmentRow = typeof commitments.$inferSelect;
export type OccurrenceRow = typeof commitmentOccurrences.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;

/** Runs `work` in the caller's transaction, or opens one. */
export function runIn<T>(exec: Executor | undefined, work: (tx: Executor) => Promise<T>): Promise<T> {
  return exec ? work(exec) : db.transaction((tx) => work(tx));
}

export function scheduleOf(row: Pick<CommitmentRow, "frequency" | "intervalCount" | "intervalUnit" | "startDate" | "endDate">): Schedule {
  return {
    frequency: row.frequency,
    intervalCount: row.intervalCount,
    intervalUnit: row.intervalUnit,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

/**
 * The first due date from `today` on. A one-off is due on its date even when
 * that has passed (it is then overdue), a recurring schedule does not
 * resurrect periods before today.
 */
export function firstDueDate(schedule: Schedule, today: Day): Day | null {
  if (schedule.frequency === "once") {
    return schedule.endDate && schedule.startDate > schedule.endDate ? null : schedule.startDate;
  }
  return nextDueOnOrAfter(schedule, maxDay(schedule.startDate, today));
}

/** Per-commitment offsets override the workspace defaults. */
export function reminderOffsetsFor(ctx: Pick<WorkspaceContext, "settings">, row: { reminderOffsets: number[] | null }): number[] {
  if (row.reminderOffsets?.length) return row.reminderOffsets;
  if (ctx.settings.reminderOffsets?.length) return ctx.settings.reminderOffsets;
  return DEFAULT_REMINDER_OFFSETS;
}

/** A context for jobs and event handlers acting on a workspace's behalf. */
export async function systemContext(workspaceId: string, exec: Executor = db): Promise<WorkspaceContext | null> {
  const [workspace] = await exec.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return workspace ? contextFor(workspace, { userId: null, actorType: "system" }) : null;
}

/**
 * Converts amounts to the workspace base currency, caching one rate lookup
 * per currency and day. Future dates use the latest known rate. Returns null
 * when no rate exists, so callers report the amount instead of dropping it.
 */
export class BaseConverter {
  private readonly rates = new Map<string, Promise<string | null>>();

  constructor(
    private readonly fx: FxService,
    private readonly ctx: Pick<WorkspaceContext, "baseCurrency" | "workspaceId">,
    private readonly today: Day,
    private readonly exec: Executor = db,
  ) {}

  get currency() {
    return this.ctx.baseCurrency;
  }

  async convert(amount: number, currency: string, date: Day = this.today): Promise<number | null> {
    if (currency.toUpperCase() === this.ctx.baseCurrency) return amount;
    const on = date > this.today ? this.today : date;
    const key = `${currency.toUpperCase()}|${on}`;
    let rate = this.rates.get(key);
    if (!rate) {
      rate = this.fx.rate(currency, this.ctx.baseCurrency, on, this.ctx.workspaceId, this.exec);
      this.rates.set(key, rate);
    }
    const value = await rate;
    return value ? convertMinor(amount, currency, this.ctx.baseCurrency, value) : null;
  }
}

type QueryValue = string | number | boolean | string[] | null | undefined;

export function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return search.toString();
}

/** Web app paths the UI links to. */
export const links = {
  commitment: (id: string) => `/commitments?focus=${id}`,
  subscription: (id: string) => `/subscriptions/${id}`,
  budget: (id: string) => `/budgets/${id}`,
  goal: (id: string) => `/goals/${id}`,
  /** The transactions page showing one transaction (it has no per-record route). */
  transaction: (id: string) => `/transactions?${queryString({ period: "all_time", ids: id })}`,
  /** The transactions page showing these transactions. */
  payments: (ids: string[]) => (ids.length ? `/transactions?${queryString({ period: "all_time", ids: ids.slice(0, 100) })}` : null),
  transactions: (params: Record<string, QueryValue>) => `/transactions?${queryString(params)}`,
};

/** Adds up base-currency amounts, keeping what could not be converted apart. */
export class Totals {
  total = 0;
  readonly unconverted = new Map<string, number>();

  add(base: number | null, amount: number, currency: string) {
    if (base === null) this.unconverted.set(currency, (this.unconverted.get(currency) ?? 0) + amount);
    else this.total += base;
  }

  unconvertedList() {
    return [...this.unconverted.entries()].map(([currency, amount]) => ({ currency, amount }));
  }
}
