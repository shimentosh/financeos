import { addDays, startOfMonth, today } from "@financeos/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { categories } from "../../src/db/schema/index.js";
import { AdminService } from "../../src/modules/admin/admin.service.js";
import { AnalyticsService } from "../../src/modules/analytics/analytics.service.js";
import { OverviewService } from "../../src/modules/analytics/overview.service.js";
import { ReportsService } from "../../src/modules/analytics/reports.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { CommitmentsService } from "../../src/modules/planning/commitments.service.js";
import { GoalsService } from "../../src/modules/planning/goals.service.js";
import { LiabilitiesService } from "../../src/modules/wealth/liabilities.service.js";
import { ReceivablesService } from "../../src/modules/wealth/receivables.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let analytics: AnalyticsService;
let overview: OverviewService;
let reports: ReportsService;
let transactions: TransactionsService;
let accounts: AccountsService;
let commitments: CommitmentsService;
let user: TestUser;
let bank: string;
let card: string;
let groceries: string;
let salary: string;
const day = today("Asia/Dhaka");
const monthStart = startOfMonth(day);

beforeAll(async () => {
  analytics = await service(AnalyticsService);
  overview = await service(OverviewService);
  reports = await service(ReportsService);
  transactions = await service(TransactionsService);
  accounts = await service(AccountsService);
  commitments = await service(CommitmentsService);
});
afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Analytics User");
  bank = (
    await accounts.create(user.personal, {
      name: "BRAC Bank",
      kind: "bank",
      currency: "BDT",
      openingBalance: 10_000_000,
      openingDate: addDays(monthStart, -60),
    })
  ).id;
  card = (await accounts.create(user.personal, { name: "Card", kind: "card", currency: "BDT", openingBalance: 0, openingDate: addDays(monthStart, -60) })).id;
  const cats = await db.select().from(categories).where(eq(categories.workspaceId, user.personal.workspaceId));
  groceries = cats.find((c) => c.name === "Groceries")?.id as string;
  salary = cats.find((c) => c.name === "Salary")?.id as string;
});

describe("summary and categories", () => {
  it("counts income and spending, nets refunds, rolls subcategories into parents", async () => {
    await transactions.create(user.personal, { type: "income", accountId: bank, amount: 15_000_000, currency: "BDT", date: monthStart, categoryId: salary });
    await transactions.create(user.personal, {
      type: "expense",
      accountId: bank,
      amount: 300_000,
      currency: "BDT",
      date: monthStart,
      categoryId: groceries,
      merchant: "Shwapno",
    });
    await transactions.create(user.personal, {
      type: "refund",
      direction: "in",
      accountId: bank,
      amount: 50_000,
      currency: "BDT",
      date: monthStart,
      categoryId: groceries,
    });
    const cash = (await accounts.list(user.personal)).find((a) => a.name === "Cash")?.id as string;
    await transactions.create(user.personal, { type: "transfer", accountId: bank, toAccountId: cash, amount: 1_000_000, currency: "BDT", date: monthStart });

    const range = { from: monthStart, to: day };
    const summary = await analytics.summary(user.personal, range);
    expect(summary).toMatchObject({ income: 15_000_000, expenses: 250_000, net: 14_750_000 });

    const byCategory = await analytics.byCategory(user.personal, range);
    // Groceries is a child of Food & Dining: it rolls up.
    expect(byCategory).toHaveLength(1);
    expect(byCategory[0]).toMatchObject({ name: "Food & Dining", amount: 250_000, share: 100 });
    expect(byCategory[0]?.href).toContain("type=expense,refund");
  });
});

describe("cash flow", () => {
  it("reconciles opening to closing for cash accounts and excludes internal transfers", async () => {
    await transactions.create(user.personal, { type: "income", accountId: bank, amount: 2_000_000, currency: "BDT", date: monthStart, categoryId: salary });
    await transactions.create(user.personal, { type: "expense", accountId: bank, amount: 500_000, currency: "BDT", date: monthStart });
    const cash = (await accounts.list(user.personal)).find((a) => a.name === "Cash")?.id as string;
    await transactions.create(user.personal, { type: "transfer", accountId: bank, toAccountId: cash, amount: 300_000, currency: "BDT", date: monthStart });
    // Paying the card from the bank moves cash out of the liquid set.
    await transactions.create(user.personal, { type: "transfer", accountId: bank, toAccountId: card, amount: 100_000, currency: "BDT", date: monthStart });

    const flow = await analytics.cashFlow(user.personal, { from: monthStart, to: day });
    expect(flow.statement.opening).toBe(10_000_000);
    expect(flow.statement.income).toBe(2_000_000);
    expect(flow.statement.expenses).toBe(500_000);
    expect(flow.statement.transfersOut - flow.statement.transfersIn).toBe(100_000);
    expect(flow.statement.closing).toBe(10_000_000 + 2_000_000 - 500_000 - 100_000);
    expect(flow.closingByBalances).toBe(flow.statement.closing);
  });
});

describe("forecast", () => {
  it("places scheduled commitments on their dates and labels the result an estimate", async () => {
    await commitments.create(user.personal, {
      kind: "rent",
      name: "Flat rent",
      amount: 3_500_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: addDays(day, 5),
      accountId: bank,
    });
    const forecast = await analytics.forecast(user.personal, 30);
    expect(forecast.label).toBe("estimate");
    expect(forecast.startBalance).toBe(10_000_000);
    expect(forecast.events.some((e) => e.label === "Flat rent" && e.amount === -3_500_000 && e.date === addDays(day, 5))).toBe(true);
    expect(forecast.windows.map((w) => w.days)).toEqual([30]);
    expect(forecast.days).toHaveLength(30);
  });
});

describe("overview and reports", () => {
  it("builds the dashboard read model with drill-down links", async () => {
    await transactions.create(user.personal, { type: "income", accountId: bank, amount: 1_000_000, currency: "BDT", date: monthStart, categoryId: salary });
    await transactions.create(user.personal, { type: "expense", status: "draft", accountId: bank, amount: 10_000, currency: "BDT", date: monthStart });
    const data = await overview.overview(user.personal);
    expect(data.month.income).toBe(1_000_000);
    expect(data.attention.drafts).toBe(1);
    expect(data.cash.total).toBe(11_000_000);
    expect(data.netWorth?.value).toBe(11_000_000);
    expect(data.series).toHaveLength(12);
    expect(data.business).toBeNull();
  });

  it("sums receivable payments, liability payments and goal contributions per record", async () => {
    const receivablesService = await service(ReceivablesService);
    const goalsService = await service(GoalsService);
    const liabilitiesService = await service(LiabilitiesService);
    const lent = await receivablesService.create(user.personal, {
      kind: "loan",
      counterpartyName: "Rahim",
      title: "Loan to Rahim",
      amount: 500_000,
      currency: "BDT",
      issueDate: monthStart,
      dueDate: addDays(day, 30),
    });
    await receivablesService.create(user.personal, {
      kind: "loan",
      counterpartyName: "Karim",
      title: "Loan to Karim",
      amount: 200_000,
      currency: "BDT",
      issueDate: monthStart,
      dueDate: addDays(day, 30),
    });
    await receivablesService.pay(user.personal, lent.id, { amount: 100_000, accountId: bank, date: day });
    const goalA = await goalsService.create(user.personal, { kind: "savings", name: "Trip", targetAmount: 1_000_000, currency: "BDT" });
    await goalsService.create(user.personal, { kind: "savings", name: "Laptop", targetAmount: 1_000_000, currency: "BDT" });
    await goalsService.addContribution(user.personal, goalA.id, { amount: 250_000, date: day });
    const loan = await liabilitiesService.create(user.personal, {
      kind: "personal_debt",
      name: "From brother",
      principal: 300_000,
      currency: "BDT",
      openingOutstanding: 300_000,
    });
    await liabilitiesService.pay(user.personal, loan.id, { amount: 100_000, interest: 0, accountId: bank, date: day });

    const data = await overview.overview(user.personal);
    expect(data.receivables).toMatchObject({ outstanding: 400_000 + 200_000, count: 2 });
    expect(data.payables.outstanding).toBe(200_000);
    const goals = Object.fromEntries(data.goals.map((g) => [g.name, g.current]));
    expect(goals).toEqual({ Trip: 250_000, Laptop: 0 });
  });

  it("generates a report whose template narrative restates computed figures", async () => {
    await transactions.create(user.personal, { type: "income", accountId: bank, amount: 1_000_000, currency: "BDT", date: monthStart, categoryId: salary });
    const report = await reports.generate(user.personal, { kind: "custom", from: monthStart, to: day, withNarrative: true });
    expect(report?.narrativeSource).toBe("template");
    expect(report?.narrative).toContain("৳10,000.00");
    const list = await reports.list(user.personal);
    expect(list).toHaveLength(1);
    const other = await createUser("Stranger");
    await expect(reports.get(other.personal, report?.id as string)).rejects.toThrow(/not found/);
  });
});

describe("admin", () => {
  it("summarises the instance without exposing workspace records", async () => {
    const admin = await service(AdminService);
    const data = await admin.overview();
    expect(data.users).toBeGreaterThanOrEqual(1);
    expect(data.workspaces).toBeGreaterThanOrEqual(2);
    const ws = await admin.workspaces({ page: 1, pageSize: 10 });
    expect(ws.items[0]).not.toHaveProperty("transactions_list");
    expect(Object.keys(ws.items[0] ?? {})).toEqual(expect.arrayContaining(["name", "kind", "members", "transactions"]));
  });
});
