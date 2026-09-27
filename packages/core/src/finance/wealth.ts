import { addMonths, type Day, diffDays } from "../dates.ts";
import { monthsBetween } from "./budgets.ts";

export type GoalProgress = {
  target: number;
  current: number;
  remaining: number;
  progress: number;
  /** Per month from now to the deadline to finish on time. */
  requiredMonthly: number | null;
  monthsLeft: number | null;
  /** At the planned monthly contribution, when the goal would be reached. */
  onTrack: boolean | null;
  projectedCompletion: Day | null;
};

export function goalProgress(input: { target: number; current: number; targetDate?: Day | null; monthlyPlan?: number | null; today: Day }): GoalProgress {
  const remaining = Math.max(0, input.target - input.current);
  const progress = input.target > 0 ? Math.min(100, Math.round((input.current / input.target) * 1000) / 10) : 0;
  const monthsLeft = input.targetDate ? Math.max(0, monthsBetween(input.today, input.targetDate)) : null;
  const requiredMonthly = remaining === 0 ? 0 : monthsLeft === null ? null : monthsLeft === 0 ? remaining : Math.ceil(remaining / monthsLeft);
  let projectedCompletion: Day | null = null;
  if (remaining === 0) projectedCompletion = input.today;
  else if (input.monthlyPlan && input.monthlyPlan > 0) {
    // addMonths clamps to the month's end: 31 Jan + 1 month is 28 Feb, not 3 Mar.
    projectedCompletion = addMonths(input.today, Math.ceil(remaining / input.monthlyPlan));
  }
  const onTrack = remaining === 0 ? true : requiredMonthly === null || !input.monthlyPlan ? null : input.monthlyPlan >= requiredMonthly;
  return { target: input.target, current: input.current, remaining, progress, requiredMonthly, monthsLeft, onTrack, projectedCompletion };
}

export type InvestmentFlow = {
  direction: "in" | "out";
  /** Positive, in the investment's currency. */
  amount: number;
  /** For withdrawals: the cost basis that left with them. */
  costBasis?: number | null;
};

export type InvestmentMetrics = {
  /** Everything put in: opening cost basis plus contributions. */
  contributed: number;
  withdrawn: number;
  /** Cost basis still invested. */
  costBasis: number;
  currentValue: number | null;
  realizedGain: number;
  unrealizedGain: number | null;
  /** Total return over everything contributed, percent. */
  roi: number | null;
};

/**
 * Contributions are `investment` out of an account (money into the holding);
 * withdrawals are `investment` in. Realized gain is proceeds over the cost
 * basis released; unrealized is current value over remaining cost basis.
 */
export function investmentMetrics(input: { openingCostBasis: number; flows: InvestmentFlow[]; currentValue: number | null }): InvestmentMetrics {
  let contributed = input.openingCostBasis;
  let withdrawn = 0;
  let released = 0;
  let realizedGain = 0;
  for (const flow of input.flows) {
    if (flow.direction === "out") {
      contributed += flow.amount;
    } else {
      withdrawn += flow.amount;
      // Without a stated cost basis, treat a withdrawal as returning capital.
      const basis = flow.costBasis ?? flow.amount;
      released += basis;
      realizedGain += flow.amount - basis;
    }
  }
  const costBasis = Math.max(0, contributed - released);
  const unrealizedGain = input.currentValue === null ? null : input.currentValue - costBasis;
  const roi = input.currentValue === null || contributed === 0 ? null : Math.round(((input.currentValue + withdrawn - contributed) / contributed) * 1000) / 10;
  return { contributed, withdrawn, costBasis, currentValue: input.currentValue, realizedGain, unrealizedGain, roi };
}

export type DebtFlow = {
  type: "loan" | "debt_payment" | "expense";
  direction: "in" | "out";
  amount: number;
};

/** A liability's outstanding balance from what was owed when added and what moved since. */
export function liabilityOutstanding(openingOutstanding: number, flows: DebtFlow[]): { outstanding: number; paid: number; borrowed: number } {
  let paid = 0;
  let borrowed = 0;
  for (const flow of flows) {
    if (flow.type === "loan" && flow.direction === "in") borrowed += flow.amount;
    else if (flow.direction === "out") paid += flow.amount;
  }
  return { outstanding: openingOutstanding + borrowed - paid, paid, borrowed };
}

export type ReceivableState = "pending" | "partially_paid" | "paid" | "overdue" | "cancelled";

export function receivableState(input: { amount: number; paid: number; dueDate?: Day | null; cancelled?: boolean; today: Day }): {
  state: ReceivableState;
  remaining: number;
  daysOverdue: number;
} {
  const remaining = Math.max(0, input.amount - input.paid);
  if (input.cancelled) return { state: "cancelled", remaining, daysOverdue: 0 };
  if (remaining === 0) return { state: "paid", remaining: 0, daysOverdue: 0 };
  if (input.dueDate && input.dueDate < input.today) {
    return { state: "overdue", remaining, daysOverdue: diffDays(input.dueDate, input.today) };
  }
  return { state: input.paid > 0 ? "partially_paid" : "pending", remaining, daysOverdue: 0 };
}

export type ProjectMetricsInput = {
  revenue: number;
  /** Expense net of refunds, all categories. */
  cost: number;
  /** Cost broken down by category group, for the profile. */
  costByGroup?: Record<string, number>;
  capitalInvested: number;
  budget: number | null;
  /** Monthly net cost (cost − revenue) for recent full months, oldest first. */
  monthlyNet: number[];
  monthlyCost: number[];
  receivables: number;
  payables: number;
  /** Monthly recurring commitments attributed to the project. */
  recurringMonthly: number;
};

export type ProjectMetrics = {
  revenue: number;
  cost: number;
  netContribution: number;
  margin: number | null;
  /** Average monthly cost over the recent months (actual). */
  monthlyBurn: number;
  /** Average monthly net burn (cost − revenue), positive when losing money. */
  netBurn: number;
  budgetUsed: number | null;
  budgetRemaining: number | null;
  /** Months until the budget runs out at the current burn (estimate). */
  runwayMonths: number | null;
  capitalInvested: number;
  receivables: number;
  payables: number;
  recurringMonthly: number;
};

function average(values: number[]): number {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

export function projectMetrics(input: ProjectMetricsInput): ProjectMetrics {
  const netContribution = input.revenue - input.cost;
  const monthlyBurn = average(input.monthlyCost);
  const netBurn = average(input.monthlyNet);
  const budgetUsed = input.budget ? Math.round((input.cost / input.budget) * 1000) / 10 : null;
  const budgetRemaining = input.budget !== null ? input.budget - input.cost : null;
  const runwayMonths = budgetRemaining !== null && monthlyBurn > 0 ? Math.max(0, Math.round((budgetRemaining / monthlyBurn) * 10) / 10) : null;
  return {
    revenue: input.revenue,
    cost: input.cost,
    netContribution,
    margin: input.revenue > 0 ? Math.round((netContribution / input.revenue) * 1000) / 10 : null,
    monthlyBurn,
    netBurn,
    budgetUsed,
    budgetRemaining,
    runwayMonths,
    capitalInvested: input.capitalInvested,
    receivables: input.receivables,
    payables: input.payables,
    recurringMonthly: input.recurringMonthly,
  };
}
