import {
  type Anomaly,
  addDays,
  addMonths,
  type Day,
  detectLargeTransaction,
  detectRecurring,
  detectRevenueDrop,
  detectSpikes,
  endOfMonth,
  formatMoney,
  monthKey,
  nameSimilarity,
  normalizeName,
  type RecurringCandidate,
  type SeriesPoint,
  startOfMonth,
  today,
} from "@financeos/core";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { contextFor, todayFor, type WorkspaceContext } from "../../../common/context.js";
import { db } from "../../../db/index.js";
import { categories, commitmentOccurrences, commitments, counterparties, projects, transactions, workspaces } from "../../../db/schema/index.js";
import { SchedulerService } from "../../jobs/scheduler.service.js";
import { FxService } from "../../ledger/fx.service.js";
import { TransactionsService } from "../../ledger/transactions.service.js";
import { JobsService } from "../../system/jobs.service.js";
import { InboxService } from "../../system/notify.service.js";

/** ৳2,000: below this a category "spike" is pocket change. */
const MIN_SPIKE_BDT = 200_000;
/** Months of history behind a spike (at least three are needed). */
const SPIKE_HISTORY_MONTHS = 6;
const MAX_EVIDENCE_IDS = 50;

type ExpenseRow = {
  id: string;
  date: Day;
  amount: number;
  currency: string;
  baseAmount: number | null;
  merchant: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  categoryId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown>;
  counterpartyKind: string | null;
  /** Settles a commitment occurrence (a tracked subscription, rent, a loan installment). */
  scheduled: boolean;
};

/**
 * Money that is already planned or is not a charge from a merchant: payroll
 * runs, payments linked to a commitment, and payments to employees. None of
 * these is a subscription waiting to be discovered.
 */
export function isScheduledOrPayroll(row: Pick<ExpenseRow, "metadata" | "counterpartyKind" | "scheduled">): boolean {
  const meta = row.metadata ?? {};
  return row.scheduled || Boolean(meta.payrollRunId) || Boolean(meta.commitmentId) || row.counterpartyKind === "employee";
}

/** A fee or charge line (a processor fee, a bank charge): small by nature, never an "unusually large payment". */
export function isFee(row: Pick<ExpenseRow, "metadata">, categoryName: string | null): boolean {
  const meta = row.metadata ?? {};
  return Boolean(meta.fee) || meta.origin === "fee" || (categoryName !== null && /\b(fees?|charges?)\b/i.test(categoryName));
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

const CADENCE_LABELS: Record<RecurringCandidate["cadence"], string> = {
  weekly: "weekly",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

/**
 * Daily detection over the ledger: recurring charges nobody tracks yet, and
 * anomalies (category and project spikes, unusually large payments, a revenue
 * drop, possible duplicates). Every number comes from the database and every
 * finding carries the transactions behind it; titles and bodies are
 * deterministic text, never model prose.
 */
@Injectable()
export class DetectionService implements OnModuleInit {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  onModuleInit() {
    this.jobs.register("ai.recurring", async (payload) => {
      const ctx = await this.workspaceContext(String(payload.workspaceId));
      return ctx ? this.recurring(ctx) : { skipped: "workspace gone" };
    });
    this.jobs.register("ai.anomalies", async (payload) => {
      const ctx = await this.workspaceContext(String(payload.workspaceId));
      return ctx ? this.anomalies(ctx) : { skipped: "workspace gone" };
    });
    const fanOut = (type: "ai.recurring" | "ai.anomalies") => async () => {
      const day = today("UTC");
      for (const workspaceId of await this.scheduler.workspaceIds()) {
        await this.jobs.enqueue(type, { workspaceId }, { workspaceId, dedupeKey: `${type}:${workspaceId}:${day}` });
      }
    };
    this.scheduler.register("ai.recurring", "0 3 * * *", "Find recurring charges that are not tracked yet", fanOut("ai.recurring"));
    this.scheduler.register("ai.anomalies", "0 4 * * *", "Flag spending spikes, large payments, revenue drops and duplicates", fanOut("ai.anomalies"));
  }

  private async workspaceContext(workspaceId: string): Promise<WorkspaceContext | null> {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    return workspace ? contextFor(workspace, { userId: null, actorType: "system" }) : null;
  }

  private postedExpenses(ctx: WorkspaceContext, from: Day, to: Day, type: "expense" | "income" = "expense"): Promise<ExpenseRow[]> {
    return db
      .select({
        id: transactions.id,
        date: transactions.date,
        amount: transactions.amount,
        currency: transactions.currency,
        baseAmount: transactions.baseAmount,
        merchant: transactions.merchant,
        counterpartyId: transactions.counterpartyId,
        counterpartyName: counterparties.name,
        categoryId: transactions.categoryId,
        projectId: transactions.projectId,
        metadata: transactions.metadata,
        counterpartyKind: counterparties.kind,
        scheduled: sql<boolean>`exists (select 1 from ${commitmentOccurrences} o where o.transaction_id = ${transactions.id})`,
      })
      .from(transactions)
      .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          eq(transactions.status, "posted"),
          eq(transactions.type, type),
          gte(transactions.date, from),
          lte(transactions.date, to),
        ),
      )
      .orderBy(asc(transactions.date));
  }

  // ---------------------------------------------------------- recurring

  /** Charges that repeat on a cadence and are not yet a subscription or commitment. */
  async recurring(ctx: WorkspaceContext) {
    const day = todayFor(ctx);
    // Payroll, commitment payments and salaries are planned money, not discoveries.
    const rows = (await this.postedExpenses(ctx, addMonths(day, -13), day)).filter((row) => !isScheduledOrPayroll(row));
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Per currency: a USD subscription and a taka bill are separate patterns.
    const candidates: RecurringCandidate[] = [];
    for (const currency of new Set(rows.map((row) => row.currency))) {
      const inputs = rows
        .filter((row) => row.currency === currency)
        .map((row) => ({
          id: row.id,
          date: row.date,
          amount: row.amount,
          merchant: row.counterpartyName ?? row.merchant ?? "",
        }))
        .filter((row) => row.merchant);
      candidates.push(...detectRecurring(inputs, day));
    }
    if (!candidates.length) return { candidates: 0, upserted: 0, skippedCovered: 0 };

    const active = await db
      .select({
        id: commitments.id,
        name: commitments.name,
        payee: commitments.payee,
        counterpartyId: commitments.counterpartyId,
      })
      .from(commitments)
      .where(and(eq(commitments.workspaceId, ctx.workspaceId), eq(commitments.status, "active")));
    let upserted = 0;
    let skippedCovered = 0;
    for (const candidate of candidates) {
      const evidence = candidate.transactionIds.map((id) => byId.get(id)).filter((row): row is ExpenseRow => Boolean(row));
      const currency = evidence[0]?.currency ?? ctx.baseCurrency;
      const counterpartyIds = new Set(evidence.map((row) => row.counterpartyId).filter(Boolean));
      const covered = active.some(
        (c) =>
          (c.counterpartyId && counterpartyIds.has(c.counterpartyId)) ||
          nameSimilarity(candidate.merchant, c.name) >= 0.8 ||
          (c.payee ? nameSimilarity(candidate.merchant, c.payee) >= 0.8 : false),
      );
      if (covered) {
        skippedCovered++;
        continue;
      }
      const onlyCounterparty = counterpartyIds.size === 1 ? ([...counterpartyIds][0] as string) : null;
      const money = (minor: number) => formatMoney(minor, currency);
      await this.inbox.upsert({
        workspaceId: ctx.workspaceId,
        kind: "recurring_candidate",
        severity: "info",
        title: `Recurring ${CADENCE_LABELS[candidate.cadence]} payment to ${candidate.merchant}`,
        body: `${candidate.occurrences} payments of about ${money(candidate.typicalAmount)}${candidate.variableAmount ? " (the amount varies)" : ""}, the last on ${candidate.lastDate}. Next expected around ${candidate.nextExpected}. Track it to get reminders before it renews.`,
        data: {
          merchant: candidate.merchant,
          counterpartyId: onlyCounterparty ?? undefined,
          cadence: candidate.cadence,
          amount: candidate.typicalAmount,
          currency,
          lastAmount: candidate.lastAmount,
          variableAmount: candidate.variableAmount,
          lastDate: candidate.lastDate,
          nextExpected: candidate.nextExpected,
          occurrences: candidate.occurrences,
          score: candidate.confidence,
          transactionIds: candidate.transactionIds.slice(-MAX_EVIDENCE_IDS),
          // Drill-downs name their period: the transactions list defaults to this month.
          href: onlyCounterparty
            ? `/transactions?counterpartyId=${onlyCounterparty}&from=${evidence[0]?.date ?? candidate.lastDate}&to=${candidate.lastDate}`
            : `/transactions?ids=${candidate.transactionIds.slice(-MAX_EVIDENCE_IDS).join(",")}&period=all_time`,
        },
        entityType: onlyCounterparty ? "counterparty" : undefined,
        entityId: onlyCounterparty ?? undefined,
        dedupeKey: `recurring:${candidate.key}`,
      });
      upserted++;
    }
    return { candidates: candidates.length, upserted, skippedCovered };
  }

  // ---------------------------------------------------------- anomalies

  /** Spending spikes, unusually large payments, revenue drops and possible duplicates. */
  async anomalies(ctx: WorkspaceContext) {
    const day = todayFor(ctx);
    const base = ctx.baseCurrency;
    const money = (minor: number) => formatMoney(minor, base);
    const thisMonth = startOfMonth(day);
    const lastMonthStart = startOfMonth(addDays(thisMonth, -1));
    const historyStart = addMonths(lastMonthStart, -SPIKE_HISTORY_MONTHS);
    const expenses = (await this.postedExpenses(ctx, addMonths(thisMonth, -13), day)).filter((row) => row.baseAmount !== null);

    const [first] = await db
      .select({ date: sql<string | null>`min(${transactions.date})` })
      .from(transactions)
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.status, "posted")));
    const firstMonth = first?.date ? monthKey(first.date) : monthKey(day);

    // Complete months with data, oldest first: the history behind every average.
    const months: string[] = [];
    for (let m = historyStart; m < thisMonth; m = addMonths(m, 1)) if (monthKey(m) >= firstMonth) months.push(monthKey(m));
    const lastMonth = monthKey(lastMonthStart);
    const priorMonths = months.filter((m) => m !== lastMonth);

    const totalsByMonth = new Map<string, number>();
    for (const row of expenses) totalsByMonth.set(monthKey(row.date), (totalsByMonth.get(monthKey(row.date)) ?? 0) + (row.baseAmount ?? 0));
    const averageMonthly = months.length ? months.reduce((sum, m) => sum + (totalsByMonth.get(m) ?? 0), 0) / months.length : 0;
    const floor = base === "BDT" ? MIN_SPIKE_BDT : ((await this.fx.tryConvert(MIN_SPIKE_BDT, "BDT", base, day, ctx.workspaceId)) ?? MIN_SPIKE_BDT);
    const minAbsolute = Math.max(Math.round(averageMonthly * 0.05), floor);

    const found: Array<{
      anomaly: Anomaly;
      dedupeKey: string;
      data: Record<string, unknown>;
      entityType?: string;
      entityId?: string;
    }> = [];
    const inRange = (row: ExpenseRow, from: Day, to: Day) => row.date >= from && row.date <= to;

    const spikes = (
      groupOf: (row: ExpenseRow) => string | null,
      labelOf: (key: string) => string,
      kind: "category_spike" | "project_cost_spike",
      filterParam: "categoryId" | "projectId",
    ) => {
      const groups = new Map<string, ExpenseRow[]>();
      for (const row of expenses) {
        const key = groupOf(row);
        if (!key) continue;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
      }
      const sumFor = (rows: ExpenseRow[], month: string) =>
        rows.filter((row) => monthKey(row.date) === month).reduce((sum, row) => sum + (row.baseAmount ?? 0), 0);

      // The last complete month against the months before it.
      if (priorMonths.length >= 3) {
        const points: SeriesPoint[] = [...groups.entries()].map(([key, rows]) => ({
          key,
          label: labelOf(key),
          history: priorMonths.map((m) => sumFor(rows, m)),
          current: sumFor(rows, lastMonth),
          transactionIds: rows.filter((row) => monthKey(row.date) === lastMonth).map((row) => row.id),
        }));
        for (const anomaly of detectSpikes(points, {
          minAbsolute,
          kind,
          format: money,
          period: `in ${monthLabel(lastMonth)}`,
        })) {
          const from = lastMonthStart;
          const to = endOfMonth(lastMonthStart);
          found.push({
            anomaly,
            dedupeKey: `anomaly:${kind}:${anomaly.key}:${lastMonth}`,
            data: {
              [filterParam]: anomaly.key,
              period: { from, to },
              href: `/transactions?${filterParam}=${anomaly.key}&from=${from}&to=${to}`,
            },
            entityType: filterParam === "categoryId" ? "category" : "project",
            entityId: anomaly.key,
          });
        }
      }
      // This month so far, once it already exceeds the monthly average.
      if (kind === "category_spike" && months.length >= 3) {
        const points: SeriesPoint[] = [];
        for (const [key, rows] of groups) {
          const history = months.map((m) => sumFor(rows, m));
          const mean = history.reduce((a, b) => a + b, 0) / history.length;
          const current = rows.filter((row) => inRange(row, thisMonth, day)).reduce((sum, row) => sum + (row.baseAmount ?? 0), 0);
          if (current <= mean) continue;
          points.push({
            key,
            label: labelOf(key),
            history,
            current,
            transactionIds: rows.filter((row) => inRange(row, thisMonth, day)).map((row) => row.id),
          });
        }
        const month = monthKey(thisMonth);
        for (const anomaly of detectSpikes(points, {
          minAbsolute,
          kind,
          format: money,
          period: `so far in ${monthLabel(month)}`,
        })) {
          found.push({
            anomaly,
            dedupeKey: `anomaly:${kind}_mtd:${anomaly.key}:${month}`,
            data: {
              [filterParam]: anomaly.key,
              period: { from: thisMonth, to: day },
              href: `/transactions?${filterParam}=${anomaly.key}&from=${thisMonth}&to=${day}`,
            },
            entityType: "category",
            entityId: anomaly.key,
          });
        }
      }
    };

    const names = await this.names(ctx);
    spikes(
      (row) => row.categoryId,
      (key) => names.categories.get(key) ?? "Uncategorised",
      "category_spike",
      "categoryId",
    );

    // Unusually large payments posted in the last week, against the merchant's own history.
    const recent = expenses.filter((row) => row.date >= addDays(day, -7));
    const last90 = expenses.filter((row) => row.date >= addDays(day, -90));
    for (const row of recent) {
      // Fees are small by nature; a ৳6 fee against a usual ৳2 is not news.
      if (isFee(row, row.categoryId ? (names.categories.get(row.categoryId) ?? null) : null)) continue;
      const merchantKey = row.counterpartyId ?? (row.merchant ? normalizeName(row.merchant) : null);
      const history = merchantKey
        ? expenses
            .filter(
              (other) =>
                other.id !== row.id &&
                other.date <= row.date &&
                (other.counterpartyId ?? (other.merchant ? normalizeName(other.merchant) : null)) === merchantKey,
            )
            .map((other) => other.baseAmount ?? 0)
        : [];
      const anomaly = detectLargeTransaction(
        {
          id: row.id,
          amount: row.baseAmount ?? 0,
          merchant: row.counterpartyName ?? row.merchant ?? "an unnamed payee",
          date: row.date,
        },
        history,
        last90.filter((other) => other.id !== row.id).map((other) => other.baseAmount ?? 0),
        money,
        // Only an increase worth a person's attention: the same floor as a spending spike.
        { minExcess: minAbsolute },
      );
      if (anomaly)
        found.push({
          anomaly,
          dedupeKey: `anomaly:large:${row.id}`,
          data: { href: `/transactions?ids=${row.id}&period=all_time` },
          entityType: "transaction",
          entityId: row.id,
        });
    }

    if (ctx.workspaceKind === "business") {
      // Revenue: the last complete month against the three before it.
      const income = (await this.postedExpenses(ctx, addMonths(lastMonthStart, -3), endOfMonth(lastMonthStart), "income")).filter(
        (row) => row.baseAmount !== null,
      );
      const revenueMonths = months.slice(-4);
      if (revenueMonths.length === 4) {
        const monthly = revenueMonths.map((m) => ({
          month: m,
          amount: income.filter((row) => monthKey(row.date) === m).reduce((sum, row) => sum + (row.baseAmount ?? 0), 0),
        }));
        const drop = detectRevenueDrop(monthly, money);
        if (drop) {
          const from = `${drop.key}-01`;
          const to = endOfMonth(from);
          drop.transactionIds = income.filter((row) => monthKey(row.date) === drop.key).map((row) => row.id);
          found.push({
            anomaly: drop,
            dedupeKey: `anomaly:revenue_drop:${drop.key}`,
            data: {
              period: { from, to },
              href: `/transactions?type=income&from=${from}&to=${to}`,
            },
          });
        }
      }
      spikes(
        (row) => row.projectId,
        (key) => names.projects.get(key) ?? "A project",
        "project_cost_spike",
        "projectId",
      );
    }

    for (const item of found) {
      const a = item.anomaly;
      await this.inbox.upsert({
        workspaceId: ctx.workspaceId,
        kind: "anomaly",
        severity: a.severity,
        title: a.title,
        body: a.body,
        data: {
          ...item.data,
          metric: a.kind,
          expected: a.expected,
          actual: a.actual,
          percentChange: a.percent ?? undefined,
          currency: base,
          transactionIds: a.transactionIds.slice(0, MAX_EVIDENCE_IDS),
        },
        entityType: item.entityType,
        entityId: item.entityId,
        dedupeKey: item.dedupeKey,
      });
    }

    const duplicates = await this.duplicates(ctx);
    return {
      flagged: found.length,
      byKind: this.countBy(found.map((f) => f.anomaly.kind)),
      duplicates,
    };
  }

  private countBy(values: string[]) {
    const out: Record<string, number> = {};
    for (const value of values) out[value] = (out[value] ?? 0) + 1;
    return out;
  }

  private async names(ctx: WorkspaceContext) {
    const [categoryRows, projectRows] = await Promise.all([
      db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.workspaceId, ctx.workspaceId)),
      db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.workspaceId, ctx.workspaceId)),
    ]);
    return {
      categories: new Map(categoryRows.map((row) => [row.id, row.name])),
      projects: new Map(projectRows.map((row) => [row.id, row.name])),
    };
  }

  /** Transactions recorded in the last three days that look like one already in the books. */
  private async duplicates(ctx: WorkspaceContext): Promise<number> {
    const recent = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          inArray(transactions.status, ["posted", "pending"]),
          ne(transactions.type, "transfer"),
          isNotNull(transactions.accountId),
          gte(transactions.createdAt, new Date(Date.now() - 3 * 86_400_000)),
        ),
      )
      .limit(200);
    let flagged = 0;
    const seen = new Set<string>();
    for (const row of recent) {
      const matches = (await this.transactions.findDuplicates(ctx, row)).filter(
        (match) => (match.exact || match.score >= 0.85) && (match.transaction.status === "posted" || match.transaction.status === "pending"),
      );
      for (const match of matches.slice(0, 3)) {
        const [older, newer] = [match.transaction, row].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) as [typeof row, typeof row];
        const key = `duplicate:${older.id}:${newer.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const amount = formatMoney(newer.amount, newer.currency);
        await this.inbox.upsert({
          workspaceId: ctx.workspaceId,
          kind: "duplicate",
          severity: match.exact ? "warning" : "info",
          title: `Possible duplicate: ${newer.merchant ?? "a payment"} ${amount} on ${newer.date}`,
          body: `${match.reasons.join(", ")}. Keep both if they are two real payments, or keep one.`,
          data: {
            transactionIds: [older.id, newer.id],
            matchTransactionId: older.id,
            score: match.score,
            reasons: match.reasons,
            amount: newer.amount,
            currency: newer.currency,
            merchant: newer.merchant ?? undefined,
            href: `/transactions?ids=${older.id},${newer.id}&period=all_time`,
          },
          entityType: "transaction",
          entityId: newer.id,
          dedupeKey: key,
        });
        flagged++;
      }
    }
    return flagged;
  }
}
