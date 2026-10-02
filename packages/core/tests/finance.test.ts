import { describe, expect, it } from "vitest";
import {
  annualized,
  budgetMetrics,
  cashFlowStatement,
  computeEntries,
  computeNetWorth,
  deriveSubscriptionStatus,
  detectPriceChange,
  dueDatesBetween,
  dueReminderOffset,
  followingDueDate,
  goalProgress,
  incomeStatement,
  investmentMetrics,
  LedgerError,
  liabilityOutstanding,
  monthlyEquivalent,
  nextDueOnOrAfter,
  pnlEffect,
  projectMetrics,
  receivableState,
  renewalAlerts,
} from "../src/index.ts";

describe("ledger entries", () => {
  const base = { accountId: "a", accountCurrency: "BDT", accountAmount: 50_000, baseAmount: 50_000, date: "2026-09-26" };

  it("posts an expense as money out of one account", () => {
    expect(computeEntries({ ...base, type: "expense", direction: "out" })).toEqual([
      { accountId: "a", amount: -50_000, currency: "BDT", baseAmount: -50_000, date: "2026-09-26" },
    ]);
  });

  it("posts income as money in", () => {
    expect(computeEntries({ ...base, type: "income", direction: "in" })[0]?.amount).toBe(50_000);
  });

  it("posts a transfer as two legs that net to zero in base currency", () => {
    const entries = computeEntries({
      ...base,
      type: "transfer",
      direction: "out",
      toAccountId: "b",
      toAccountCurrency: "BDT",
      toAccountAmount: 50_000,
    });
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, e) => sum + e.baseAmount, 0)).toBe(0);
    expect(entries[1]).toMatchObject({ accountId: "b", amount: 50_000 });
  });

  it("posts a cross-currency transfer with each leg in its own currency", () => {
    const entries = computeEntries({
      type: "transfer",
      direction: "out",
      accountId: "wise-usd",
      accountCurrency: "USD",
      accountAmount: 10_000,
      baseAmount: 1_220_000,
      toAccountId: "brac-bdt",
      toAccountCurrency: "BDT",
      toAccountAmount: 1_215_000,
      date: "2026-09-26",
    });
    expect(entries[0]).toMatchObject({ amount: -10_000, currency: "USD" });
    expect(entries[1]).toMatchObject({ amount: 1_215_000, currency: "BDT" });
  });

  it("rejects impossible transactions", () => {
    expect(() => computeEntries({ ...base, type: "expense", direction: "in" })).toThrow(LedgerError);
    expect(() => computeEntries({ ...base, type: "transfer", direction: "out" })).toThrow(/destination/);
    expect(() => computeEntries({ ...base, type: "transfer", direction: "out", toAccountId: "a", toAccountCurrency: "BDT" })).toThrow(/two different/);
    expect(() => computeEntries({ ...base, type: "expense", direction: "out", accountAmount: -5 })).toThrow(/positive/);
    expect(() => computeEntries({ ...base, type: "expense", direction: "out", accountAmount: 10.5 })).toThrow();
  });
});

describe("income statement", () => {
  it("never counts transfers, investments, loans or equity as income or spending", () => {
    const statement = incomeStatement([
      { type: "income", direction: "in", amount: 200_000 },
      { type: "expense", direction: "out", amount: 50_000 },
      { type: "refund", direction: "in", amount: 5_000 },
      { type: "transfer", direction: "out", amount: 100_000 },
      { type: "investment", direction: "out", amount: 30_000 },
      { type: "asset_purchase", direction: "out", amount: 80_000 },
      { type: "loan", direction: "in", amount: 70_000 },
      { type: "debt_payment", direction: "out", amount: 10_000 },
      { type: "equity", direction: "in", amount: 1_000_000 },
      { type: "adjustment", direction: "in", amount: 999 },
    ]);
    expect(statement).toEqual({ income: 200_000, expenses: 45_000, net: 155_000, rate: 77.5 });
  });

  it("nets a refund to a customer against revenue", () => {
    expect(pnlEffect("refund", "out", 1_000)).toEqual({ income: -1_000, expense: 0 });
    expect(incomeStatement([]).rate).toBeNull();
  });
});

describe("cash flow", () => {
  it("reconciles opening to closing through every movement", () => {
    const flow = cashFlowStatement(100_000, [
      { type: "income", direction: "in", amount: 200_000 },
      { type: "expense", direction: "out", amount: -60_000 },
      { type: "debt_payment", direction: "out", amount: -15_000 },
      { type: "transfer", direction: "out", amount: -40_000 },
      { type: "transfer", direction: "out", amount: 40_000 },
      { type: "transfer", direction: "out", amount: -25_000 },
      { type: "loan", direction: "in", amount: 50_000 },
    ]);
    expect(flow.income).toBe(200_000);
    expect(flow.expenses).toBe(60_000);
    expect(flow.debtPayments).toBe(15_000);
    expect(flow.transfersIn - flow.transfersOut).toBe(-25_000);
    expect(flow.closing).toBe(100_000 + 200_000 - 60_000 - 15_000 - 25_000 + 50_000);
  });
});

describe("schedules", () => {
  it("returns to the anchor day after short months", () => {
    const schedule = { frequency: "monthly" as const, startDate: "2026-01-31" };
    expect(dueDatesBetween(schedule, "2026-01-01", "2026-05-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("finds the next renewal of a yearly plan", () => {
    const schedule = { frequency: "yearly" as const, startDate: "2026-09-26" };
    expect(nextDueOnOrAfter(schedule, "2026-09-27")).toBe("2027-09-26");
    expect(followingDueDate(schedule, "2027-09-26")).toBe("2028-09-26");
  });

  it("stops at the end date and supports custom intervals", () => {
    expect(nextDueOnOrAfter({ frequency: "monthly", startDate: "2026-01-10", endDate: "2026-03-01" }, "2026-03-05")).toBeNull();
    expect(dueDatesBetween({ frequency: "custom", intervalCount: 2, intervalUnit: "week", startDate: "2026-09-01" }, "2026-09-01", "2026-09-30")).toEqual([
      "2026-09-01",
      "2026-09-15",
      "2026-09-29",
    ]);
    expect(nextDueOnOrAfter({ frequency: "once", startDate: "2026-10-01" }, "2026-10-02")).toBeNull();
  });

  it("annualizes and converts to monthly equivalents", () => {
    expect(annualized(18_000, { frequency: "yearly" })).toBe(18_000);
    expect(monthlyEquivalent(18_000, { frequency: "yearly" })).toBe(1_500);
    expect(annualized(2_000, { frequency: "monthly" })).toBe(24_000);
    expect(annualized(10_000, { frequency: "quarterly" })).toBe(40_000);
  });
});

describe("subscription alerts", () => {
  it("fires each reminder offset once, catching up after a gap", () => {
    // Default: two days before, the day before, and on the day.
    expect(dueReminderOffset(3)).toBeNull();
    expect(dueReminderOffset(2)).toBe(2);
    expect(dueReminderOffset(1)).toBe(1);
    expect(dueReminderOffset(0)).toBe(0);
    expect(dueReminderOffset(30)).toBeNull();
    expect(dueReminderOffset(29, [30, 7])).toBe(30);
    expect(dueReminderOffset(5, [30, 7])).toBe(7);
    expect(dueReminderOffset(45, [45, 7])).toBe(45);
  });

  it("says manual renewal is needed when auto-renew is off", () => {
    const alerts = renewalAlerts({ name: "Figma", amountLabel: "$180", autoRenew: false, dueDate: "2027-10-10", expiryDate: "2027-10-10" }, "2027-10-08");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "renewal", offset: 2, stage: "soon" });
    expect(alerts[0]?.body).toContain("Manual renewal required");
  });

  it("warns about a cancellation deadline separately from the renewal", () => {
    const alerts = renewalAlerts(
      { name: "Figma", amountLabel: "$180", autoRenew: true, dueDate: "2027-10-04", cancellationDeadline: "2027-10-03" },
      "2027-10-02",
    );
    expect(alerts.map((a) => a.kind).sort()).toEqual(["cancellation_deadline", "renewal"]);
    expect(alerts.find((a) => a.kind === "cancellation_deadline")?.title).toContain("tomorrow");
  });

  it("flags a renewal that passed without a recorded payment", () => {
    const [alert] = renewalAlerts({ name: "Figma", amountLabel: "$180", autoRenew: true, dueDate: "2027-10-10", unpaid: true }, "2027-10-11");
    expect(alert).toMatchObject({ kind: "unconfirmed", stage: "overdue" });
    expect(alert?.body).toContain("yesterday");
  });

  it("derives time-driven status and detects price increases", () => {
    const facts = {
      name: "Claude",
      status: "active" as const,
      autoRenew: true,
      nextRenewalDate: "2027-09-26",
      expiryDate: "2027-09-26",
      cancellationDeadline: null,
    };
    expect(deriveSubscriptionStatus(facts, "2027-09-20")).toBe("renewal_due");
    expect(deriveSubscriptionStatus(facts, "2027-01-01")).toBe("active");
    expect(deriveSubscriptionStatus({ ...facts, autoRenew: false, nextRenewalDate: null }, "2027-09-27")).toBe("expired");
    expect(detectPriceChange(18_000, 22_000)).toMatchObject({ percent: 22.2, direction: "increase", difference: 4_000 });
    expect(detectPriceChange(18_000, 18_000)).toBeNull();
  });
});

describe("net worth", () => {
  it("is assets minus liabilities and reports what it could not value", () => {
    const result = computeNetWorth({
      asOf: "2026-09-26",
      accounts: [
        { id: "bank", name: "BRAC Bank", baseBalance: 50_000_000, currency: "BDT", isLiability: false },
        { id: "card", name: "Card", baseBalance: -2_000_000, currency: "BDT", isLiability: true },
        { id: "eur", name: "Euro account", baseBalance: null, currency: "EUR", isLiability: false },
      ],
      holdings: [
        { id: "car", name: "Car", kind: "asset", baseValue: 250_000_000, currency: "BDT", valuedAt: "2025-01-01" },
        { id: "fdr", name: "FDR", kind: "investment", baseValue: 100_000_000, currency: "BDT", valuedAt: "2026-09-01" },
        { id: "rcv", name: "Loan to Rahim", kind: "receivable", baseValue: 5_000_000, currency: "BDT" },
      ],
      liabilities: [{ id: "car-loan", name: "Car loan", baseOutstanding: 120_000_000, currency: "BDT" }],
    });
    expect(result.assets.total).toBe(50_000_000 + 250_000_000 + 100_000_000 + 5_000_000);
    expect(result.liabilities.total).toBe(2_000_000 + 120_000_000);
    expect(result.netWorth).toBe(283_000_000);
    expect(result.complete).toBe(false);
    expect(result.warnings.map((w) => w.code).sort()).toEqual(["missing_rate", "stale_valuation"]);
  });
});

describe("budgets, goals, investments, debts, projects", () => {
  it("measures a running budget and projects its pace", () => {
    const metrics = budgetMetrics(3_000_000, 2_500_000, { from: "2026-09-01", to: "2026-09-30" }, "2026-09-15");
    expect(metrics).toMatchObject({ remaining: 500_000, utilization: 83.3, status: "warning", daysLeft: 15, projected: 5_000_000 });
    expect(budgetMetrics(1_000, 1_500, { from: "2026-08-01", to: "2026-08-31" }, "2026-09-15").status).toBe("over");
  });

  it("works out what a goal needs each month", () => {
    const progress = goalProgress({ target: 500_000_000, current: 90_000_000, targetDate: "2028-09-26", monthlyPlan: 15_000_000, today: "2026-09-26" });
    expect(progress.progress).toBe(18);
    expect(progress.monthsLeft).toBe(24);
    expect(progress.requiredMonthly).toBe(17_083_334);
    expect(progress.onTrack).toBe(false);
  });

  it("separates realized from unrealized investment gains", () => {
    const metrics = investmentMetrics({
      openingCostBasis: 100_000,
      flows: [
        { direction: "out", amount: 50_000 },
        { direction: "in", amount: 40_000, costBasis: 30_000 },
      ],
      currentValue: 150_000,
    });
    expect(metrics).toEqual({
      contributed: 150_000,
      withdrawn: 40_000,
      costBasis: 120_000,
      currentValue: 150_000,
      realizedGain: 10_000,
      unrealizedGain: 30_000,
      roi: 26.7,
    });
  });

  it("tracks liabilities and receivables from their flows", () => {
    expect(
      liabilityOutstanding(1_000_000, [
        { type: "debt_payment", direction: "out", amount: 200_000 },
        { type: "loan", direction: "in", amount: 50_000 },
      ]),
    ).toEqual({ outstanding: 850_000, paid: 200_000, borrowed: 50_000 });
    expect(receivableState({ amount: 300_000, paid: 100_000, dueDate: "2026-09-01", today: "2026-09-26" })).toEqual({
      state: "overdue",
      remaining: 200_000,
      daysOverdue: 25,
    });
    expect(receivableState({ amount: 300_000, paid: 300_000, today: "2026-09-26" }).state).toBe("paid");
  });

  it("computes project economics without inventing a runway", () => {
    const metrics = projectMetrics({
      revenue: 500_000,
      cost: 1_200_000,
      capitalInvested: 2_000_000,
      budget: 3_000_000,
      monthlyNet: [300_000, 200_000, 100_000],
      monthlyCost: [400_000, 400_000, 400_000],
      receivables: 0,
      payables: 0,
      recurringMonthly: 30_000,
    });
    expect(metrics).toMatchObject({ netContribution: -700_000, monthlyBurn: 400_000, netBurn: 200_000, budgetUsed: 40, runwayMonths: 4.5 });
    expect(
      projectMetrics({
        ...{ revenue: 0, cost: 0, capitalInvested: 0, budget: null, monthlyNet: [], monthlyCost: [], receivables: 0, payables: 0, recurringMonthly: 0 },
      }).runwayMonths,
    ).toBeNull();
  });
});

describe("goal projection", () => {
  it("clamps a projected completion to the end of a short month", () => {
    const progress = goalProgress({ target: 200, current: 100, monthlyPlan: 100, today: "2026-01-31" });
    expect(progress.projectedCompletion).toBe("2026-02-28");
  });
});
