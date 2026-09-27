import {
  addDays,
  annualized,
  COMMITMENT_KIND_LABELS,
  type CommitmentKind,
  type Day,
  diffDays,
  dueDatesBetween,
  maxDay,
  monthlyEquivalent,
} from "@expensewise/core";
import {
  type AnnualCommitmentsQuery,
  annualCommitmentsQuery,
  type CalendarQuery,
  calendarQuery,
  type UpcomingQuery,
  upcomingQuery,
} from "@expensewise/core/contracts/planning-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, between, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { commitmentOccurrences, commitments } from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { CommitmentsService, frequencyLabel, type JoinedCommitment } from "./commitments.service.js";
import { BaseConverter, links, type OccurrenceRow, scheduleOf, Totals } from "./planning.shared.js";

export type ScheduleItemStatus = "scheduled" | "overdue" | "projected" | "paid" | "skipped" | "cancelled";

/** One due date on the calendar: a materialised occurrence or a projected one. */
export type ScheduleItem = {
  /** occurrence id, or `${commitmentId}:${date}` for a projected date. */
  key: string;
  date: Day;
  /** overdue = scheduled, past due and not recorded; projected = from the schedule, not yet materialised. */
  status: ScheduleItemStatus;
  commitmentId: string;
  occurrenceId: string | null;
  subscriptionId: string | null;
  name: string;
  kind: CommitmentKind;
  kindLabel: string;
  direction: "in" | "out";
  amount: number;
  currency: string;
  /** Estimate in the base currency; null when no rate exists. */
  baseAmount: number | null;
  baseCurrency: string;
  autoPay: boolean;
  daysUntil: number;
  paidAmount: number | null;
  paidOn: Day | null;
  transactionId: string | null;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectId: string | null;
  projectName: string | null;
  href: string;
};

type Filters = {
  kind?: CommitmentKind[];
  direction?: "in" | "out";
  projectId?: string | null;
  categoryId?: string | null;
  accountId?: string | null;
};

function filterConditions(ctx: WorkspaceContext, filters: Filters): SQL[] {
  const where: SQL[] = [eq(commitments.workspaceId, ctx.workspaceId)];
  if (filters.kind?.length) where.push(inArray(commitments.kind, filters.kind));
  if (filters.direction) where.push(eq(commitments.direction, filters.direction));
  if (filters.projectId) where.push(eq(commitments.projectId, filters.projectId));
  if (filters.categoryId) where.push(eq(commitments.categoryId, filters.categoryId));
  if (filters.accountId) where.push(eq(commitments.accountId, filters.accountId));
  return where;
}

function summarize(items: ScheduleItem[]) {
  const out = new Totals();
  const inflow = new Totals();
  const paidOut = new Totals();
  const paidIn = new Totals();
  for (const item of items) {
    if (item.status === "skipped" || item.status === "cancelled") continue;
    const paid = item.status === "paid";
    const target = item.direction === "in" ? (paid ? paidIn : inflow) : paid ? paidOut : out;
    target.add(item.baseAmount, paid ? (item.paidAmount ?? item.amount) : item.amount, item.currency);
  }
  return {
    count: items.length,
    out: out.total,
    in: inflow.total,
    paidOut: paidOut.total,
    paidIn: paidIn.total,
    overdueCount: items.filter((item) => item.status === "overdue").length,
    unconverted: [
      ...out.unconvertedList().map((u) => ({ ...u, direction: "out" as const, paid: false })),
      ...inflow.unconvertedList().map((u) => ({ ...u, direction: "in" as const, paid: false })),
      ...paidOut.unconvertedList().map((u) => ({ ...u, direction: "out" as const, paid: true })),
      ...paidIn.unconvertedList().map((u) => ({ ...u, direction: "in" as const, paid: true })),
    ],
  };
}

function groupByDay(items: ScheduleItem[]) {
  const days = new Map<Day, ScheduleItem[]>();
  for (const item of items) {
    const list = days.get(item.date) ?? [];
    list.push(item);
    days.set(item.date, list);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayItems]) => {
      const totals = summarize(dayItems);
      return {
        date,
        items: dayItems,
        totalOut: totals.out,
        totalIn: totals.in,
        paidOut: totals.paidOut,
        paidIn: totals.paidIn,
        unconverted: totals.unconverted,
      };
    });
}

/**
 * What is coming due: the upcoming list, the calendar and the annual view.
 * Materialised occurrences (scheduled, paid, skipped) take precedence over
 * dates projected from each active commitment's schedule.
 */
@Injectable()
export class PlanningCalendarService {
  constructor(
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  private async collect(
    ctx: WorkspaceContext,
    filters: Filters,
    range: { from: Day; to: Day },
    options: { includeOverdue: boolean; includeSettled: boolean },
  ): Promise<ScheduleItem[]> {
    const today = todayFor(ctx);
    const rows = await this.commitments.joined(db, and(...filterConditions(ctx, filters)));
    if (!rows.length) return [];
    const byId = new Map<string, JoinedCommitment>(rows.map((row) => [row.commitment.id, row]));
    const occurrences = await db
      .select()
      .from(commitmentOccurrences)
      .where(
        and(
          eq(commitmentOccurrences.workspaceId, ctx.workspaceId),
          inArray(commitmentOccurrences.commitmentId, [...byId.keys()]),
          options.includeOverdue
            ? or(
                between(commitmentOccurrences.dueDate, range.from, range.to),
                and(eq(commitmentOccurrences.status, "scheduled"), lt(commitmentOccurrences.dueDate, range.from)),
              )
            : between(commitmentOccurrences.dueDate, range.from, range.to),
        ),
      );

    const converter = new BaseConverter(this.fx, ctx, today);
    const materialised = new Set(occurrences.map((o) => `${o.commitmentId}:${o.dueDate}`));
    const items: ScheduleItem[] = [];

    const item = async (row: JoinedCommitment, date: Day, occurrence: OccurrenceRow | null): Promise<ScheduleItem> => {
      const c = row.commitment;
      const status: ScheduleItemStatus = !occurrence
        ? "projected"
        : occurrence.status === "scheduled"
          ? occurrence.dueDate < today
            ? "overdue"
            : "scheduled"
          : occurrence.status;
      const amount = occurrence?.amount ?? c.amount;
      const currency = occurrence?.currency ?? c.currency;
      const valued = occurrence?.status === "paid" && occurrence.paidAmount !== null ? occurrence.paidAmount : amount;
      return {
        key: occurrence?.id ?? `${c.id}:${date}`,
        date,
        status,
        commitmentId: c.id,
        occurrenceId: occurrence?.id ?? null,
        subscriptionId: row.subscriptionId,
        name: c.name,
        kind: c.kind,
        kindLabel: COMMITMENT_KIND_LABELS[c.kind],
        direction: c.direction,
        amount,
        currency,
        baseAmount: await converter.convert(valued, currency, date),
        baseCurrency: ctx.baseCurrency,
        autoPay: c.autoPay,
        daysUntil: diffDays(today, date),
        paidAmount: occurrence?.paidAmount ?? null,
        paidOn: occurrence?.paidOn ?? null,
        transactionId: occurrence?.transactionId ?? null,
        accountId: c.accountId,
        accountName: row.accountName,
        categoryId: c.categoryId,
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        categoryColor: row.categoryColor,
        projectId: c.projectId,
        projectName: row.projectName,
        href: row.subscriptionId ? links.subscription(row.subscriptionId) : links.commitment(c.id),
      };
    };

    for (const occurrence of occurrences) {
      const row = byId.get(occurrence.commitmentId);
      if (!row) continue;
      if (occurrence.status === "scheduled") {
        // A paused or ended commitment expects nothing.
        if (row.commitment.status !== "active") continue;
      } else if (!options.includeSettled) {
        continue;
      }
      items.push(await item(row, occurrence.dueDate, occurrence));
    }

    for (const row of rows) {
      const c = row.commitment;
      if (c.status !== "active" || !c.nextDueDate) continue;
      const start = maxDay(range.from, c.nextDueDate);
      if (start > range.to) continue;
      for (const date of dueDatesBetween(scheduleOf(c), start, range.to, 1000)) {
        if (materialised.has(`${c.id}:${date}`)) continue;
        items.push(await item(row, date, null));
      }
    }

    return items.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  }

  /** The next N days (default 30), plus payments that are past due and unrecorded. */
  async upcoming(ctx: WorkspaceContext, raw: UpcomingQuery = {}) {
    const query = upcomingQuery.parse(raw);
    const today = todayFor(ctx);
    const to = addDays(today, query.days);
    const items = await this.collect(ctx, query, { from: today, to }, { includeOverdue: query.includeOverdue, includeSettled: false });
    return {
      today,
      from: today,
      to,
      days: query.days,
      baseCurrency: ctx.baseCurrency,
      totals: summarize(items),
      items,
      groups: groupByDay(items),
    };
  }

  /** Every due date between `from` and `to`, recorded or projected. */
  async calendar(ctx: WorkspaceContext, raw: CalendarQuery) {
    const query = calendarQuery.parse(raw);
    const items = await this.collect(ctx, query, { from: query.from, to: query.to }, { includeOverdue: false, includeSettled: query.includeSettled });
    return {
      from: query.from,
      to: query.to,
      today: todayFor(ctx),
      baseCurrency: ctx.baseCurrency,
      totals: summarize(items),
      items,
      days: groupByDay(items),
    };
  }

  /**
   * A year of commitments: what each costs annualized (steady state), what
   * actually falls due in the year, and the monthly equivalent, by kind and
   * by category.
   */
  async annual(ctx: WorkspaceContext, raw: AnnualCommitmentsQuery = {}) {
    const query = annualCommitmentsQuery.parse(raw);
    const today = todayFor(ctx);
    const year = query.year ?? Number(today.slice(0, 4));
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const rows = (await this.commitments.joined(db, and(...filterConditions(ctx, query), eq(commitments.status, "active")))).filter(
      (row) => row.commitment.frequency !== "once" || (row.commitment.startDate >= from && row.commitment.startDate <= to),
    );
    const converter = new BaseConverter(this.fx, ctx, today);

    type Bucket = { count: number; annualized: number; inYear: number; monthlyEquivalent: number };
    const empty = (): Bucket => ({ count: 0, annualized: 0, inYear: 0, monthlyEquivalent: 0 });
    const totals = { out: empty(), in: empty() };
    const byKind = new Map<string, Bucket & { kind: CommitmentKind; kindLabel: string; direction: "in" | "out" }>();
    const byCategory = new Map<string, Bucket & { categoryId: string | null; categoryName: string | null; direction: "in" | "out" }>();
    const unconverted: Array<{ commitmentId: string; name: string; direction: "in" | "out"; currency: string; annualized: number; inYear: number }> = [];
    const items = [];

    for (const row of rows) {
      const c = row.commitment;
      const schedule = scheduleOf(c);
      const dates = dueDatesBetween(schedule, from, to, 1000);
      const yearly = c.frequency === "once" ? c.amount : annualized(c.amount, schedule);
      const monthly = c.frequency === "once" ? Math.round(c.amount / 12) : monthlyEquivalent(c.amount, schedule);
      const inYear = c.amount * dates.length;
      const [annualizedBase, inYearBase, monthlyBase] = await Promise.all([
        converter.convert(yearly, c.currency),
        converter.convert(inYear, c.currency),
        converter.convert(monthly, c.currency),
      ]);
      items.push({
        commitmentId: c.id,
        subscriptionId: row.subscriptionId,
        name: c.name,
        kind: c.kind,
        kindLabel: COMMITMENT_KIND_LABELS[c.kind],
        direction: c.direction,
        frequency: c.frequency,
        frequencyLabel: frequencyLabel(c),
        amount: c.amount,
        currency: c.currency,
        occurrencesInYear: dates.length,
        inYear,
        inYearBase,
        annualized: yearly,
        annualizedBase,
        monthlyEquivalent: monthly,
        monthlyEquivalentBase: monthlyBase,
        categoryId: c.categoryId,
        categoryName: row.categoryName,
        projectId: c.projectId,
        projectName: row.projectName,
        href: row.subscriptionId ? links.subscription(row.subscriptionId) : links.commitment(c.id),
      });
      if (annualizedBase === null || inYearBase === null || monthlyBase === null) {
        unconverted.push({ commitmentId: c.id, name: c.name, direction: c.direction, currency: c.currency, annualized: yearly, inYear });
        continue;
      }
      const add = (bucket: Bucket) => {
        bucket.count += 1;
        bucket.annualized += annualizedBase;
        bucket.inYear += inYearBase;
        bucket.monthlyEquivalent += monthlyBase;
      };
      add(totals[c.direction]);
      const kindKey = `${c.direction}:${c.kind}`;
      const kindBucket = byKind.get(kindKey) ?? { ...empty(), kind: c.kind, kindLabel: COMMITMENT_KIND_LABELS[c.kind], direction: c.direction };
      add(kindBucket);
      byKind.set(kindKey, kindBucket);
      const categoryKey = `${c.direction}:${c.categoryId ?? "none"}`;
      const categoryBucket = byCategory.get(categoryKey) ?? { ...empty(), categoryId: c.categoryId, categoryName: row.categoryName, direction: c.direction };
      add(categoryBucket);
      byCategory.set(categoryKey, categoryBucket);
    }

    const byAnnual = <T extends Bucket>(list: T[]) => list.sort((a, b) => b.annualized - a.annualized);
    return {
      year,
      from,
      to,
      baseCurrency: ctx.baseCurrency,
      totals,
      byKind: byAnnual([...byKind.values()]),
      byCategory: byAnnual([...byCategory.values()]),
      items: items.sort((a, b) => (b.annualizedBase ?? 0) - (a.annualizedBase ?? 0)),
      unconverted,
    };
  }
}
