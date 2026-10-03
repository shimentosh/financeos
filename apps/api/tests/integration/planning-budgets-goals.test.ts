import { addDays, addMonths, startOfMonth } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayFor } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { categories, domainEvents, inboxItems, notifications, projects, transactions as transactionTable } from "../../src/db/schema/index.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { ProjectsService } from "../../src/modules/ledger/catalog.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { BudgetsService } from "../../src/modules/planning/budgets.service.js";
import { GoalsService } from "../../src/modules/planning/goals.service.js";
import { RemindersService } from "../../src/modules/planning/reminders.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let transactions: TransactionsService;
let accounts: AccountsService;
let budgets: BudgetsService;
let goals: GoalsService;
let reminders: RemindersService;
let user: TestUser;
let T: string;
let bkash: string;
let savings: string;
let food: string;
let groceries: string;
let restaurants: string;
let rent: string;
let salary: string;

beforeAll(async () => {
  transactions = await service(TransactionsService);
  accounts = await service(AccountsService);
  budgets = await service(BudgetsService);
  goals = await service(GoalsService);
  reminders = await service(RemindersService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Tanvir Hasan");
  T = todayFor(user.personal);
  bkash = (
    await accounts.create(user.personal, { name: "bKash", kind: "mobile_wallet", currency: "BDT", openingBalance: 50_000_000, openingDate: "2025-01-01" })
  ).id;
  savings = (await accounts.create(user.personal, { name: "Savings", kind: "savings", currency: "BDT", openingBalance: 0, openingDate: "2025-01-01" })).id;
  const cats = await db.select().from(categories).where(eq(categories.workspaceId, user.personal.workspaceId));
  const find = (name: string) => cats.find((c) => c.name === name)?.id as string;
  food = find("Food & Dining");
  groceries = find("Groceries");
  restaurants = find("Restaurants");
  rent = find("Rent");
  salary = find("Salary");
});

const spend = (amount: number, categoryId: string, extra: Record<string, unknown> = {}) =>
  transactions.create(user.personal, { type: "expense", accountId: bkash, amount, currency: "BDT", date: T, categoryId, ...extra });

describe("budgets", () => {
  it("measures spending across subcategories, net of refunds, posted only", async () => {
    const budget = await budgets.create(user.personal, { name: "Food", amount: 1_000_000, categoryId: food, startDate: startOfMonth(T) });
    await spend(300_000, groceries);
    await spend(200_000, restaurants);
    await transactions.create(user.personal, {
      type: "refund",
      direction: "in",
      accountId: bkash,
      amount: 50_000,
      currency: "BDT",
      date: T,
      categoryId: groceries,
    });
    await spend(999_999, rent);
    await spend(100_000, groceries, { status: "draft" });
    const { transaction: voided } = await spend(70_000, food);
    await transactions.void(user.personal, voided.id);
    await spend(40_000, food, { date: addMonths(T, -1) });

    const detail = await budgets.detail(user.personal, budget.id);
    expect(detail.metrics).toMatchObject({ budget: 1_000_000, actual: 450_000, remaining: 550_000, utilization: 45, status: "on_track" });
    expect(detail).toMatchObject({ scope: "category", categoryName: "Food & Dining", inEffect: true, currency: "BDT" });
    expect(detail.categoryIds.sort()).toEqual([food, groceries, restaurants].sort());
    expect(detail.range.from).toBe(startOfMonth(T));
    expect(detail.drilldown.query).toMatchObject({
      from: startOfMonth(T),
      categoryId: food,
      includeChildren: true,
      type: ["expense", "refund"],
      status: ["posted"],
    });
    expect(detail.drilldown.href).toContain(`/transactions?from=${startOfMonth(T)}`);
    expect(detail.history).toHaveLength(6);
    expect(detail.history.map((h) => h.actual).slice(-2)).toEqual([40_000, 450_000]);

    // The drill-down finds exactly the transactions behind the figure.
    const behind = await transactions.list(user.personal, { ...detail.drilldown.query, pageSize: 200 });
    expect(behind.totals.expense).toBe(450_000);

    const lastMonth = await budgets.list(user.personal, { date: addMonths(T, -1) });
    expect(lastMonth.items[0]?.metrics.actual).toBe(40_000);
    const withHistory = await budgets.list(user.personal, { history: 3 });
    const sparkline = withHistory.items[0] && "history" in withHistory.items[0] ? withHistory.items[0].history : [];
    expect(sparkline.map((h) => h.actual)).toEqual([0, 40_000, 450_000]);

    const everything = await budgets.create(user.personal, { name: "All spending", amount: 5_000_000, startDate: startOfMonth(T) });
    expect((await budgets.detail(user.personal, everything.id)).metrics.actual).toBe(450_000 + 999_999);
  });

  it("validates categories and keeps project budgets to business workspaces", async () => {
    await expect(budgets.create(user.personal, { name: "Salary", amount: 1, categoryId: salary, startDate: T })).rejects.toMatchObject({
      code: "category_kind_mismatch",
    });
    const personalProject = await (await service(ProjectsService)).create(user.personal, { name: "Home renovation" });
    await expect(budgets.create(user.personal, { name: "Renovation", amount: 1, projectId: personalProject.id, startDate: T })).rejects.toMatchObject({
      code: "projects_business_only",
    });
    const [ops] = await db.select().from(projects).where(eq(projects.workspaceId, user.business.workspaceId));
    const business = await budgets.create(user.business, { name: "Ops", amount: 10_000_000, projectId: ops?.id, startDate: T, period: "quarterly" });
    expect((await budgets.detail(user.business, business.id)).scope).toBe("project");
    await expect(budgets.create(user.business, { name: "Theirs", amount: 1, categoryId: food, startDate: T })).rejects.toThrow(/not found in this workspace/);

    const updated = await budgets.update(user.business, business.id, { alertThreshold: 90, active: false });
    expect(updated).toMatchObject({ alertThreshold: 90, active: false });
    expect(await budgets.remove(user.business, business.id)).toEqual({ deleted: true });
  });

  it("alerts once per threshold and period, then again when over", async () => {
    const budget = await budgets.create(user.personal, { name: "Food", amount: 1_000_000, categoryId: food, startDate: startOfMonth(T), alertThreshold: 80 });
    await spend(500_000, groceries);
    expect(await budgets.scanThresholds(user.personal, T)).toMatchObject({ alerts: 0 });

    await spend(350_000, restaurants);
    expect((await budgets.scanThresholds(user.personal, T)).alerts).toBe(1);
    expect((await budgets.scanThresholds(user.personal, T)).alerts).toBe(0);
    await spend(200_000, groceries);
    expect((await budgets.scanThresholds(user.personal, T)).alerts).toBe(1);
    expect((await budgets.scanThresholds(user.personal, T)).alerts).toBe(0);

    const warnings = () =>
      db
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.workspaceId, user.personal.workspaceId), eq(inboxItems.kind, "budget_warning")));
    // Reaching 100% supersedes the earlier warning: only the highest stays open.
    const items = await warnings();
    expect(items.map((i) => [i.severity, i.status, i.title]).sort()).toEqual([
      ["critical", "open", "Food is over budget"],
      ["warning", "resolved", "Food has used 85% of its budget"],
    ]);
    expect(items[0]?.data).toMatchObject({ budgetId: budget.id, periodFrom: startOfMonth(T) });
    const sent = await db.select().from(notifications).where(eq(notifications.entityId, budget.id));
    expect(sent).toHaveLength(2);
    const events = await db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.workspaceId, user.personal.workspaceId), eq(domainEvents.type, "budget.threshold_reached")));
    expect(events.map((e) => e.payload.threshold).sort()).toEqual([100, 80]);
    expect((await budgets.detail(user.personal, budget.id)).metrics.status).toBe("over");

    // A refund brings it back under both thresholds: nothing stays open.
    await transactions.create(user.personal, {
      type: "refund",
      direction: "in",
      accountId: bkash,
      amount: 400_000,
      currency: "BDT",
      date: T,
      categoryId: groceries,
    });
    expect(await budgets.scanThresholds(user.personal, T)).toMatchObject({ alerts: 0, resolved: 1 });
    expect((await warnings()).filter((i) => i.status === "open")).toHaveLength(0);
  });

  it("opens only the highest threshold when spending jumps straight past both", async () => {
    const budget = await budgets.create(user.personal, { name: "Eating out", amount: 100_000, categoryId: restaurants, startDate: startOfMonth(T) });
    await spend(150_000, restaurants);
    expect(await budgets.scanThresholds(user.personal, T)).toMatchObject({ alerts: 1 });
    expect((await budgets.scanThresholds(user.personal, T)).alerts).toBe(0);
    const items = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.workspaceId, user.personal.workspaceId), eq(inboxItems.entityId, budget.id)));
    expect(items.map((i) => [i.severity, i.status])).toEqual([["critical", "open"]]);
    expect(await db.select().from(notifications).where(eq(notifications.entityId, budget.id))).toHaveLength(1);
  });
});

describe("goals", () => {
  it("tracks contributions, plans by month and is achieved once", async () => {
    const created = await goals.create(user.personal, {
      kind: "emergency_fund",
      name: "Emergency fund",
      targetAmount: 10_000_000,
      currency: "BDT",
      startingAmount: 2_000_000,
      monthlyPlan: 3_000_000,
      targetDate: addMonths(T, 6),
    });
    expect(created).toMatchObject({ isSavingsPlan: true, currentSource: "contributions", progress: { current: 2_000_000, progress: 20 } });

    const first = await goals.addContribution(user.personal, created.id, { amount: 5_000_000, date: T });
    expect(first.achieved).toBe(false);
    expect(first.goal.progress).toMatchObject({ current: 7_000_000, remaining: 3_000_000, progress: 70 });

    await expect(goals.addContribution(user.personal, created.id, { amount: -8_000_000, date: T })).rejects.toMatchObject({
      code: "insufficient_goal_balance",
    });

    const before = (await db.select().from(transactionTable).where(eq(transactionTable.workspaceId, user.personal.workspaceId))).length;
    const second = await goals.addContribution(user.personal, created.id, {
      amount: 3_000_000,
      date: T,
      transfer: { fromAccountId: bkash, toAccountId: savings },
    });
    expect(second.achieved).toBe(true);
    expect(second.goal).toMatchObject({ status: "achieved", progress: { progress: 100, remaining: 0 } });
    expect(second.goal.achievedAt).not.toBeNull();
    const [transfer] = await db
      .select()
      .from(transactionTable)
      .where(eq(transactionTable.id, second.contribution.transactionId as string));
    expect(transfer).toMatchObject({ type: "transfer", accountId: bkash, toAccountId: savings, amount: 3_000_000 });
    expect((await db.select().from(transactionTable).where(eq(transactionTable.workspaceId, user.personal.workspaceId))).length).toBe(before + 1);

    await goals.addContribution(user.personal, created.id, { amount: 100_000, date: T });
    await goals.checkAchievements(user.personal);
    const achieved = await db.select().from(notifications).where(eq(notifications.entityId, created.id));
    expect(achieved).toHaveLength(1);
    expect(achieved[0]).toMatchObject({ kind: "goal_achieved", severity: "success", link: `/goals/${created.id}` });

    const detail = await goals.detail(user.personal, created.id);
    expect(detail.contributions).toHaveLength(3);
    expect(detail.monthly.at(-1)).toMatchObject({ month: T.slice(0, 7), planned: 3_000_000, actual: 8_100_000, cumulative: 10_100_000, metPlan: true });

    // Removing the transfer contribution voids the transfer too.
    const removed = await goals.removeContribution(user.personal, created.id, second.contribution.id);
    expect(removed.contributions).toHaveLength(2);
    expect((await transactions.get(user.personal, second.contribution.transactionId as string)).status).toBe("void");
    expect(await goals.remove(user.personal, created.id)).toEqual({ deleted: false, archived: true });
  });

  it("follows a linked account's balance and filters dream assets and savings plans", async () => {
    const car = await goals.create(user.personal, {
      kind: "dream_asset",
      name: "Car",
      targetAmount: 3_000_000,
      currency: "BDT",
      linkedAccountId: savings,
      targetDate: addDays(T, 400),
    });
    expect(car).toMatchObject({ currentSource: "account", linkedAccountName: "Savings", isDreamAsset: true, progress: { current: 0 } });
    await goals.create(user.personal, { kind: "travel", name: "Trip", targetAmount: 500_000, currency: "BDT", monthlyPlan: 50_000 });
    await goals.create(user.personal, { kind: "custom", name: "Laptop", targetAmount: 20_000, currency: "USD" });

    await transactions.create(user.personal, { type: "transfer", accountId: bkash, toAccountId: savings, amount: 3_000_000, currency: "BDT", date: T });
    const scan = await reminders.scan(user.personal, T);
    expect(scan.goalsAchieved).toBe(1);
    expect((await goals.detail(user.personal, car.id)).status).toBe("achieved");

    expect((await goals.list(user.personal, { kind: ["dream_asset"] })).items.map((g) => g.name)).toEqual(["Car"]);
    expect((await goals.list(user.personal, { savingsPlan: true })).items.map((g) => g.name)).toEqual(["Trip"]);
    const all = await goals.list(user.personal, {});
    expect(all.items.find((g) => g.name === "Laptop")).toMatchObject({ targetBase: 2_440_000 });
    expect(all.summary).toMatchObject({ active: 2, achieved: 1 });
  });
});

describe("workspace isolation", () => {
  it("keeps budgets and goals inside their workspace", async () => {
    const other = await createUser("Someone Else");
    const budget = await budgets.create(user.personal, { name: "Food", amount: 1_000_000, categoryId: food, startDate: T });
    const goal = await goals.create(user.personal, { kind: "savings", name: "Savings", targetAmount: 1_000_000, currency: "BDT" });

    await expect(budgets.detail(other.personal, budget.id)).rejects.toThrow(/not found/);
    await expect(budgets.update(other.personal, budget.id, { amount: 1 })).rejects.toThrow(/not found/);
    await expect(budgets.remove(user.business, budget.id)).rejects.toThrow(/not found/);
    await expect(goals.detail(other.personal, goal.id)).rejects.toThrow(/not found/);
    await expect(goals.addContribution(other.personal, goal.id, { amount: 1, date: T })).rejects.toThrow(/not found/);
    await expect(goals.create(other.personal, { kind: "savings", name: "X", targetAmount: 1, currency: "BDT", linkedAccountId: savings })).rejects.toThrow(
      /not found in this workspace/,
    );
    const theirGoal = await goals.create(other.personal, { kind: "savings", name: "Theirs", targetAmount: 1_000, currency: "BDT" });
    await expect(
      goals.addContribution(other.personal, theirGoal.id, { amount: 100, date: T, transfer: { fromAccountId: bkash, toAccountId: savings } }),
    ).rejects.toThrow(/not found in this workspace/);

    expect((await budgets.list(other.personal, {})).items).toHaveLength(0);
    expect((await goals.list(other.personal, {})).items.map((g) => g.id)).toEqual([theirGoal.id]);
  });
});
