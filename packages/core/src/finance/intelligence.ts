import { addDays, type Day, diffDays, eachDay } from "../dates.ts";
import { merchantKey, nameSimilarity } from "../text.ts";

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type DuplicateSubject = {
  id?: string;
  date: Day;
  amount: number;
  currency: string;
  merchant?: string | null;
  accountId?: string | null;
  reference?: string | null;
  externalKey?: string | null;
  /** Set when the transaction settles a commitment (subscription payment). */
  occurrenceId?: string | null;
};

export type DuplicateMatch = {
  id: string;
  score: number;
  exact: boolean;
  reasons: string[];
};

/** `source:connectionId` of an external key (`source:connectionId:externalId`). */
function externalSource(key: string): string {
  const [source = "", connection = ""] = key.split(":");
  return `${source}:${connection}`;
}

/**
 * How likely two records are the same money movement. Deterministic signals
 * (the same wallet transaction id, the same external id) settle it outright;
 * otherwise amount, date, merchant and account add up to a probability.
 */
export function scoreDuplicate(a: DuplicateSubject, b: DuplicateSubject): { score: number; exact: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (a.externalKey && b.externalKey && a.externalKey === b.externalKey) {
    return { score: 1, exact: true, reasons: ["Same external record id"] };
  }
  const refA = a.reference?.trim().toLowerCase();
  const refB = b.reference?.trim().toLowerCase();
  if (refA && refB && refA.length >= 5 && refA === refB) {
    return { score: 1, exact: true, reasons: [`Same transaction ID (${a.reference})`] };
  }
  // Two different wallet/bank transaction ids are two real payments, however alike.
  if (refA && refB && refA.length >= 5 && refB.length >= 5) return { score: 0, exact: false, reasons: [] };
  // The same source and connection gave them different ids: the source says they are distinct.
  if (a.externalKey && b.externalKey && externalSource(a.externalKey) === externalSource(b.externalKey)) {
    return { score: 0, exact: false, reasons: [] };
  }

  let score = 0;
  if (a.currency === b.currency) {
    if (a.amount === b.amount) {
      score += 0.45;
      reasons.push("Same amount");
    } else if (Math.abs(a.amount - b.amount) <= Math.max(a.amount, b.amount) * 0.01) {
      score += 0.3;
      reasons.push("Amount within 1%");
    } else {
      return { score: 0, exact: false, reasons: [] };
    }
  } else {
    return { score: 0, exact: false, reasons: [] };
  }

  const days = Math.abs(diffDays(a.date, b.date));
  if (days === 0) {
    score += 0.25;
    reasons.push("Same day");
  } else if (days === 1) {
    score += 0.18;
    reasons.push("One day apart");
  } else if (days <= 3) {
    score += 0.08;
    reasons.push(`${days} days apart`);
  } else {
    score -= 0.2;
  }

  if (a.merchant && b.merchant) {
    const similarity = nameSimilarity(a.merchant, b.merchant);
    if (similarity >= 0.8) {
      score += 0.2;
      reasons.push("Same merchant");
    } else if (similarity >= 0.5) {
      score += 0.1;
      reasons.push("Similar merchant");
    }
    // Different names alone prove little: banks rewrite merchant names.
  }
  if (a.accountId && b.accountId && a.accountId === b.accountId) {
    score += 0.1;
    reasons.push("Same account");
  }
  if (a.occurrenceId || b.occurrenceId) {
    reasons.push("One is already recorded as a subscription payment");
  }
  return { score: Math.max(0, Math.min(0.99, Math.round(score * 100) / 100)), exact: false, reasons };
}

export const DUPLICATE_THRESHOLD = 0.7;

export function findDuplicates(subject: DuplicateSubject, pool: Array<DuplicateSubject & { id: string }>, threshold = DUPLICATE_THRESHOLD): DuplicateMatch[] {
  return pool
    .filter((candidate) => candidate.id !== subject.id)
    .map((candidate) => ({ id: candidate.id, ...scoreDuplicate(subject, candidate) }))
    .filter((match) => match.exact || match.score >= threshold)
    .sort((x, y) => y.score - x.score);
}

// ---------------------------------------------------------------------------
// Recurring detection
// ---------------------------------------------------------------------------

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

const CADENCES: Record<Cadence, { days: number; tolerance: number }> = {
  weekly: { days: 7, tolerance: 2 },
  monthly: { days: 30.4, tolerance: 4 },
  quarterly: { days: 91, tolerance: 8 },
  yearly: { days: 365, tolerance: 12 },
};

export type RecurringInput = {
  id: string;
  date: Day;
  amount: number;
  merchant: string;
};

export type RecurringCandidate = {
  merchant: string;
  key: string;
  cadence: Cadence;
  typicalAmount: number;
  lastAmount: number;
  variableAmount: boolean;
  lastDate: Day;
  nextExpected: Day;
  occurrences: number;
  confidence: number;
  transactionIds: string[];
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * Charges from one merchant at a steady interval. Three or more occurrences
 * (two for yearly) with most gaps on a cadence make a candidate; the amount
 * may vary (a utility bill) and is reported as variable.
 */
export function detectRecurring(transactions: RecurringInput[], today: Day): RecurringCandidate[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const tx of transactions) {
    const key = merchantKey(tx.merchant);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(tx);
    groups.set(key, group);
  }

  const candidates: RecurringCandidate[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = diffDays((sorted[i - 1] as RecurringInput).date, (sorted[i] as RecurringInput).date);
      if (gap > 0) gaps.push(gap);
    }
    if (!gaps.length) continue;

    let best: { cadence: Cadence; share: number } | null = null;
    for (const [cadence, spec] of Object.entries(CADENCES) as [Cadence, { days: number; tolerance: number }][]) {
      const onCadence = gaps.filter((gap) => Math.abs(gap - spec.days) <= spec.tolerance).length;
      const share = onCadence / gaps.length;
      if (!best || share > best.share) best = { cadence, share };
    }
    if (!best || best.share < 0.7) continue;
    const needed = best.cadence === "yearly" ? 2 : 3;
    if (sorted.length < needed) continue;

    const amounts = sorted.map((tx) => tx.amount);
    const typical = median(amounts);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const deviation = Math.sqrt(amounts.reduce((acc, value) => acc + (value - mean) ** 2, 0) / amounts.length);
    const variableAmount = mean > 0 && deviation / mean > 0.15;
    const last = sorted[sorted.length - 1] as RecurringInput;
    const spec = CADENCES[best.cadence];
    const nextExpected = addDays(last.date, Math.round(spec.days));
    // A pattern that stopped long ago is history, not a subscription.
    if (diffDays(nextExpected, today) > spec.days + spec.tolerance * 2) continue;

    const confidence = Math.min(0.99, Math.round((0.5 + best.share * 0.3 + Math.min(sorted.length, 6) * 0.03 - (variableAmount ? 0.1 : 0)) * 100) / 100);
    candidates.push({
      merchant: last.merchant,
      key,
      cadence: best.cadence,
      typicalAmount: typical,
      lastAmount: last.amount,
      variableAmount,
      lastDate: last.date,
      nextExpected,
      occurrences: sorted.length,
      confidence,
      transactionIds: sorted.map((tx) => tx.id),
    });
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

export type Anomaly = {
  kind: "category_spike" | "large_transaction" | "revenue_drop" | "project_cost_spike" | "new_merchant_large";
  key: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  expected: number;
  actual: number;
  percent: number | null;
  transactionIds: string[];
};

export type SeriesPoint = { key: string; label: string; history: number[]; current: number; transactionIds: string[] };

function stats(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length);
  return { mean, deviation };
}

/**
 * A group (category, project) spending well above its own recent pattern.
 * Needs three months of history, a meaningful relative jump and a meaningful
 * absolute one, so small categories do not raise alarms over pocket change.
 */
export function detectSpikes(
  points: SeriesPoint[],
  options: { minAbsolute: number; kind?: "category_spike" | "project_cost_spike"; format: (minor: number) => string; period: string },
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const point of points) {
    const history = point.history.filter((value) => value >= 0);
    if (history.length < 3) continue;
    const { mean, deviation } = stats(history);
    const increase = point.current - mean;
    if (mean <= 0 || increase < options.minAbsolute) continue;
    const ratio = point.current / mean;
    const z = deviation > 0 ? increase / deviation : Number.POSITIVE_INFINITY;
    if (ratio < 1.3 || z < 1.5) continue;
    const percent = Math.round((ratio - 1) * 1000) / 10;
    anomalies.push({
      kind: options.kind ?? "category_spike",
      key: point.key,
      title: `${point.label} spending is ${percent}% above normal`,
      body: `${point.label}: ${options.format(point.current)} ${options.period}, against a ${history.length}-month average of ${options.format(Math.round(mean))}.`,
      severity: ratio >= 2 ? "warning" : "info",
      expected: Math.round(mean),
      actual: point.current,
      percent,
      transactionIds: point.transactionIds,
    });
  }
  return anomalies.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
}

/**
 * A single charge far above what is normal for its merchant or for spending overall.
 * `minExcess` (minor units, base currency) keeps small absolute jumps quiet: a $6
 * fee against a usual $1.50 is 4x, but not worth anyone's attention.
 */
export function detectLargeTransaction(
  tx: { id: string; amount: number; merchant: string; date: Day },
  merchantHistory: number[],
  allExpenses: number[],
  format: (minor: number) => string,
  options: { minExcess?: number } = {},
): Anomaly | null {
  const minExcess = options.minExcess ?? 0;
  if (merchantHistory.length >= 3) {
    const typical = median(merchantHistory);
    if (typical > 0 && tx.amount >= typical * 3 && tx.amount - typical >= minExcess) {
      return {
        kind: "large_transaction",
        key: tx.id,
        title: `Unusually large payment to ${tx.merchant}`,
        body: `${format(tx.amount)} on ${tx.date}; payments to ${tx.merchant} are usually around ${format(typical)}.`,
        severity: "warning",
        expected: typical,
        actual: tx.amount,
        percent: Math.round((tx.amount / typical - 1) * 1000) / 10,
        transactionIds: [tx.id],
      };
    }
    return null;
  }
  if (allExpenses.length >= 20) {
    const sorted = [...allExpenses].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    if (p95 > 0 && tx.amount >= p95 * 2 && tx.amount - p95 >= minExcess) {
      return {
        kind: "new_merchant_large",
        key: tx.id,
        title: `Large first payment to ${tx.merchant}`,
        body: `${format(tx.amount)} is more than twice your usual largest expenses (${format(p95)}).`,
        severity: "info",
        expected: p95,
        actual: tx.amount,
        percent: null,
        transactionIds: [tx.id],
      };
    }
  }
  return null;
}

/** Revenue in the latest month far below its recent average. */
export function detectRevenueDrop(monthly: { month: string; amount: number }[], format: (minor: number) => string): Anomaly | null {
  if (monthly.length < 4) return null;
  const current = monthly[monthly.length - 1] as { month: string; amount: number };
  const history = monthly.slice(-4, -1).map((m) => m.amount);
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  if (mean <= 0 || current.amount >= mean * 0.7) return null;
  const percent = Math.round((1 - current.amount / mean) * 1000) / 10;
  return {
    kind: "revenue_drop",
    key: current.month,
    title: `Revenue down ${percent}% in ${current.month}`,
    body: `${format(current.amount)} against a 3-month average of ${format(Math.round(mean))}.`,
    severity: percent >= 50 ? "critical" : "warning",
    expected: Math.round(mean),
    actual: current.amount,
    percent: -percent,
    transactionIds: [],
  };
}

// ---------------------------------------------------------------------------
// Cash forecast
// ---------------------------------------------------------------------------

export type ForecastEvent = {
  date: Day;
  /** Signed base amount: positive in, negative out. */
  amount: number;
  label: string;
  kind: "commitment" | "receivable" | "payable" | "payroll" | "subscription" | "income";
  /** Confirmed (a due invoice, a fixed installment) or expected (a pattern). */
  certainty: "confirmed" | "expected";
  ref?: string;
};

export type ForecastDay = {
  date: Day;
  balance: number;
  low: number;
  high: number;
  inflow: number;
  outflow: number;
};

export type Forecast = {
  startBalance: number;
  days: ForecastDay[];
  endBalance: number;
  lowest: { date: Day; balance: number };
  scheduledIn: number;
  scheduledOut: number;
  discretionaryOut: number;
  events: ForecastEvent[];
  assumptions: string[];
};

/**
 * Projected balance per day: today's cash, plus scheduled inflows and
 * outflows on their dates, minus the typical day of unscheduled spending.
 * The band widens with √t by the day-to-day variability of that spending.
 * Everything here is an estimate and is labelled as one.
 */
export function forecastCash(input: {
  startBalance: number;
  today: Day;
  horizonDays: number;
  events: ForecastEvent[];
  /** Average unscheduled daily spending (positive). */
  dailyDiscretionary: number;
  /** Standard deviation of daily unscheduled spending. */
  dailyDeviation: number;
  /** Average unscheduled daily income (positive), e.g. irregular sales. */
  dailyVariableIncome?: number;
}): Forecast {
  const end = addDays(input.today, input.horizonDays);
  const byDay = new Map<Day, ForecastEvent[]>();
  for (const event of input.events) {
    if (event.date < input.today || event.date > end) continue;
    const list = byDay.get(event.date) ?? [];
    list.push(event);
    byDay.set(event.date, list);
  }

  let balance = input.startBalance;
  let scheduledIn = 0;
  let scheduledOut = 0;
  let discretionaryOut = 0;
  const days: ForecastDay[] = [];
  let lowest = { date: input.today, balance };
  eachDay(addDays(input.today, 1), end).forEach((date, index) => {
    const events = byDay.get(date) ?? [];
    let inflow = input.dailyVariableIncome ?? 0;
    let outflow = input.dailyDiscretionary;
    discretionaryOut += input.dailyDiscretionary;
    for (const event of events) {
      if (event.amount >= 0) {
        inflow += event.amount;
        scheduledIn += event.amount;
      } else {
        outflow += -event.amount;
        scheduledOut += -event.amount;
      }
    }
    balance += inflow - outflow;
    const spread = Math.round(input.dailyDeviation * Math.sqrt(index + 1) * 1.28);
    const day = {
      date,
      balance: Math.round(balance),
      low: Math.round(balance - spread),
      high: Math.round(balance + spread),
      inflow: Math.round(inflow),
      outflow: Math.round(outflow),
    };
    days.push(day);
    if (day.balance < lowest.balance) lowest = { date, balance: day.balance };
  });

  return {
    startBalance: input.startBalance,
    days,
    endBalance: Math.round(balance),
    lowest,
    scheduledIn,
    scheduledOut,
    discretionaryOut: Math.round(discretionaryOut),
    events: input.events.filter((e) => e.date >= input.today && e.date <= end).sort((a, b) => a.date.localeCompare(b.date)),
    assumptions: [
      "Starts from the current balance of cash, bank and wallet accounts.",
      "Adds scheduled commitments, receivables and payables on their due dates.",
      "Subtracts your average day of unscheduled spending over the last 90 days.",
      "The shaded band is an 80% range for that unscheduled spending, not a guarantee.",
    ],
  };
}
