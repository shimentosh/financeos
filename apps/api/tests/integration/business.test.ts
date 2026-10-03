import { addDays, addMonths, monthKey, projectMetrics, startOfMonth } from "@expensewise/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayFor, type WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { auditLogs, categories, files } from "../../src/db/schema/index.js";
import { nextPayDate, PayrollService } from "../../src/modules/business/payroll.service.js";
import { ProjectFinanceService } from "../../src/modules/business/project-finance.service.js";
import { RevenueService } from "../../src/modules/business/revenue.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { ProjectsService } from "../../src/modules/ledger/catalog.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { CommitmentsService } from "../../src/modules/planning/commitments.service.js";
import { ReceivablesService } from "../../src/modules/wealth/receivables.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let transactions: TransactionsService;
let accounts: AccountsService;
let projectsService: ProjectsService;
let finance: ProjectFinanceService;
let revenue: RevenueService;
let payroll: PayrollService;
let receivables: ReceivablesService;
let user: TestUser;
let ctx: WorkspaceContext;
let bank: string;
let app: string;
let today: string;
let monthStart: string;
let m1: string;
let m2: string;
let m3: string;

const category = async (name: string) =>
  (
    await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.name, name)))
  )[0]?.id as string;

beforeAll(async () => {
  transactions = await service(TransactionsService);
  accounts = await service(AccountsService);
  projectsService = await service(ProjectsService);
  finance = await service(ProjectFinanceService);
  revenue = await service(RevenueService);
  payroll = await service(PayrollService);
  receivables = await service(ReceivablesService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Tahmid Chowdhury");
  ctx = user.business;
  today = todayFor(ctx);
  monthStart = startOfMonth(today);
  m1 = addMonths(monthStart, -1);
  m2 = addMonths(monthStart, -2);
  m3 = addMonths(monthStart, -3);
  bank = (await accounts.create(ctx, { name: "Company bank", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: m3 })).id;
  app = (await projectsService.create(ctx, { name: "Mobile App", budgetAmount: 10_000_000, startDate: m3 })).id;
});

/** Three months of a project: capital in, costs by category, revenue, and refunds both ways. */
async function seedProject() {
  const post = (input: Parameters<TransactionsService["create"]>[1]) => transactions.create(ctx, input);
  await post({
    type: "equity",
    direction: "in",
    accountId: bank,
    amount: 5_000_000,
    currency: "BDT",
    date: m3,
    projectId: app,
    description: "Founder capital",
  });
  await post({
    type: "expense",
    accountId: bank,
    amount: 300_000,
    currency: "BDT",
    date: addDays(m3, 2),
    projectId: app,
    categoryId: await category("Hosting"),
    merchant: "DigitalOcean",
  });
  await post({
    type: "expense",
    accountId: bank,
    amount: 1_000_000,
    currency: "BDT",
    date: addDays(m2, 3),
    projectId: app,
    categoryId: await category("Development"),
    merchant: "DevShop",
  });
  await post({
    type: "expense",
    accountId: bank,
    amount: 200_000,
    currency: "BDT",
    date: addDays(m1, 3),
    projectId: app,
    categoryId: await category("AI & APIs"),
    merchant: "OpenAI",
  });
  await post({
    type: "expense",
    accountId: bank,
    amount: 100_000,
    currency: "BDT",
    date: addDays(m1, 3),
    projectId: app,
    categoryId: await category("Marketing"),
    merchant: "Meta Ads",
  });
  await post({
    type: "refund",
    direction: "in",
    accountId: bank,
    amount: 50_000,
    currency: "BDT",
    date: addDays(m1, 4),
    projectId: app,
    categoryId: await category("Hosting"),
    merchant: "DigitalOcean",
  });
  await post({
    type: "income",
    accountId: bank,
    amount: 2_000_000,
    currency: "BDT",
    date: addDays(m1, 5),
    projectId: app,
    categoryId: await category("Services"),
    merchant: "Acme Ltd",
  });
  await post({
    type: "refund",
    direction: "out",
    accountId: bank,
    amount: 200_000,
    currency: "BDT",
    date: addDays(m1, 6),
    projectId: app,
    merchant: "Acme Ltd",
  });
  // Not the project's: no project, and an unconfirmed draft.
  await post({ type: "expense", accountId: bank, amount: 999, currency: "BDT", date: addDays(m1, 6), merchant: "Stationery" });
  await post({ type: "expense", status: "draft", accountId: bank, amount: 777, currency: "BDT", date: addDays(m1, 6), projectId: app });
}

describe("project finance", () => {
  it("builds the profile from posted transactions, refunds netted, with drill-downs that add up", async () => {
    await seedProject();
    await receivables.create(ctx, {
      counterpartyName: "Acme Ltd",
      title: "Phase 2",
      amount: 500_000,
      currency: "BDT",
      issueDate: today,
      dueDate: addDays(today, 30),
      projectId: app,
    });
    const profile = await finance.profile(ctx, app);

    expect(profile.range).toEqual({ from: null, to: today });
    expect(profile.actual.revenue.amount).toBe(1_800_000);
    expect(profile.actual.cost.amount).toBe(1_550_000);
    expect(profile.actual.netContribution.amount).toBe(250_000);
    expect(profile.actual.capitalInvested.amount).toBe(5_000_000);
    expect(profile.actual.margin).toBe(13.9);

    const expected = projectMetrics({
      revenue: 1_800_000,
      cost: 1_550_000,
      capitalInvested: 5_000_000,
      budget: 10_000_000,
      monthlyCost: [300_000, 1_000_000, 250_000],
      monthlyNet: [300_000, 1_000_000, 250_000 - 1_800_000],
      receivables: 500_000,
      payables: 0,
      recurringMonthly: 0,
    });
    expect(profile.actual.burn.months).toEqual([m3, m2, m1].map(monthKey));
    expect(profile.actual.burn.monthlyBurn.amount).toBe(expected.monthlyBurn);
    expect(profile.actual.burn.netBurn.amount).toBe(expected.netBurn);
    expect(profile.actual.budget).toMatchObject({ amount: 10_000_000, utilization: expected.budgetUsed, remaining: 8_450_000 });
    expect(profile.estimated.runwayMonths).toBe(expected.runwayMonths);
    expect(profile.estimated.runwayMonths).not.toBeNull();
    expect(profile.actual.receivables).toMatchObject({ outstanding: 500_000, count: 1, overdue: 0 });

    const groups = Object.fromEntries(profile.actual.costByGroup.map((g) => [g.group, g.amount]));
    expect(groups).toEqual({ development: 1_000_000, ai_api: 200_000, hosting: 250_000, marketing: 100_000 });
    expect(profile.actual.topVendors[0]).toMatchObject({ name: "DevShop", amount: 1_000_000 });
    const lastMonth = profile.actual.monthly.find((m) => m.month === monthKey(m1));
    expect(lastMonth).toMatchObject({ revenue: 1_800_000, cost: 250_000, net: 1_550_000 });
    expect(profile.actual.monthly).toHaveLength(12);

    // Every figure opens the transactions behind it.
    const revenueList = await transactions.list(ctx, profile.actual.revenue.drill.query);
    expect(revenueList.totals.income).toBe(1_800_000);
    const costList = await transactions.list(ctx, profile.actual.cost.drill.query);
    expect(costList.totals.expense).toBe(1_550_000);
    const hosting = profile.actual.costByCategory.find((c) => c.name === "Hosting");
    expect((await transactions.list(ctx, hosting?.drill.query ?? {})).totals.expense).toBe(250_000);
    const capitalList = await transactions.list(ctx, profile.actual.capitalInvested.drill.query);
    expect(capitalList.items.map((t) => t.amount)).toEqual([5_000_000]);
  });

  it("gives no runway without a budget and compares projects in the overview", async () => {
    await seedProject();
    const side = (await projectsService.create(ctx, { name: "Side project" })).id;
    await transactions.create(ctx, {
      type: "expense",
      accountId: bank,
      amount: 40_000,
      currency: "BDT",
      date: addDays(m1, 1),
      projectId: side,
      categoryId: await category("Software"),
    });
    const profile = await finance.profile(ctx, side);
    expect(profile.actual.budget).toBeNull();
    expect(profile.estimated).toMatchObject({ runwayMonths: null, runwayBasis: null, runwayUnavailableReason: "No budget is set for this project." });
    expect(profile.actual.costByGroup).toEqual([expect.objectContaining({ group: "operating", amount: 40_000 })]);

    const ranged = await finance.profile(ctx, app, { from: m1, to: addDays(m1, 4) });
    expect(ranged.actual.cost.amount).toBe(250_000);
    expect(ranged.actual.revenue.amount).toBe(0);
    // Budget use is lifetime whatever the range.
    expect(ranged.actual.budget?.remaining).toBe(8_450_000);

    const overview = await finance.overview(ctx);
    const row = overview.projects.find((p) => p.project.id === app);
    expect(row?.actual).toMatchObject({ netContribution: 250_000, receivablesOutstanding: 0 });
    expect(row?.actual.revenue.amount).toBe(1_800_000);
    expect(row?.actual.cost.amount).toBe(1_550_000);
    expect(row?.estimated.runwayMonths).toBe((await finance.profile(ctx, app)).estimated.runwayMonths);
    expect(overview.projects.map((p) => p.project.name)).toEqual(expect.arrayContaining(["Mobile App", "Side project", "General Operations"]));
    expect(overview.unassigned.cost.amount).toBe(999);
    expect(overview.totals.cost).toBe(1_590_000);
  });
});

describe("revenue analytics", () => {
  it("breaks revenue down by month, project, source, customer and category", async () => {
    await seedProject();
    const result = await revenue.analytics(ctx);
    expect(result.totals).toMatchObject({ revenue: 1_800_000, gross: 2_000_000, refunds: 200_000, previous: 0, change: 1_800_000, changePercent: null });
    expect(result.byMonth).toHaveLength(12);
    expect(result.byMonth.find((m) => m.month === monthKey(m1))?.amount).toBe(1_800_000);
    expect(result.byProject).toEqual([expect.objectContaining({ projectId: app, name: "Mobile App", amount: 1_800_000, share: 100 })]);
    expect(result.byCustomer[0]).toMatchObject({ name: "Acme Ltd", amount: 1_800_000 });
    expect(result.bySource).toEqual([expect.objectContaining({ source: "manual", label: "Entered by hand", amount: 1_800_000 })]);
    expect(result.byCategory.find((c) => c.name === "Services")?.amount).toBe(2_000_000);
    expect(result.expectedRecurring).toMatchObject({ label: "expected", monthly: 0, items: [] });
    expect((await transactions.list(ctx, result.totals.drill.query)).totals.income).toBe(1_800_000);

    // Expected recurring income is reported apart from actual revenue.
    const commitments = await service(CommitmentsService);
    await commitments.create(ctx, {
      kind: "income",
      direction: "in",
      name: "Support retainer",
      amount: 1_200_000,
      currency: "BDT",
      frequency: "yearly",
      startDate: addDays(today, 3),
      projectId: app,
    });
    const withExpected = await revenue.analytics(ctx);
    expect(withExpected.expectedRecurring).toMatchObject({ label: "expected", monthly: 100_000, annualized: 1_200_000 });
    expect(withExpected.totals.revenue).toBe(1_800_000);
    expect((await finance.profile(ctx, app)).estimated.expectedRecurringRevenue.amount).toBe(100_000);
  });
});

describe("payroll", () => {
  it("drafts a run, posts one expense per employee to their project, and un-posts it", async () => {
    const period = monthKey(today);
    const rahim = await payroll.createEmployee(ctx, {
      name: "Rahim Uddin",
      title: "Engineer",
      salary: 8_000_000,
      currency: "BDT",
      payDay: 25,
      defaultProjectId: app,
      accountId: bank,
    });
    const karim = await payroll.createEmployee(ctx, { name: "Karim Ahmed", salary: 6_000_000, currency: "BDT", accountId: bank });
    const nadia = await payroll.createEmployee(ctx, { name: "Nadia Islam", salary: 3_000_000, currency: "BDT" });
    await payroll.createEmployee(ctx, { name: "Former Staff", salary: 1_000_000, currency: "BDT", accountId: bank, startDate: m3, endDate: addDays(m3, 10) });
    const paused = await payroll.createEmployee(ctx, { name: "On Leave", salary: 1_000_000, currency: "BDT", accountId: bank });
    await payroll.updateEmployee(ctx, paused.id, { status: "inactive" });
    expect(rahim.counterpartyId).toBeTruthy();

    const run = await payroll.createRun(ctx, { period, payDate: today });
    expect(run.items.map((i) => i.employeeName)).toEqual(["Karim Ahmed", "Nadia Islam", "Rahim Uddin"]);
    expect(run).toMatchObject({ status: "draft", currency: "BDT", totals: { net: 17_000_000 } });
    await expect(payroll.createRun(ctx, { period, payDate: today })).rejects.toThrow(/already a payroll run/);

    const karimItem = run.items.find((i) => i.employeeId === karim.id);
    const nadiaItem = run.items.find((i) => i.employeeId === nadia.id);
    await expect(payroll.updateItem(ctx, run.id, karimItem?.id as string, { deductions: 7_000_000 })).rejects.toThrow(/Deductions/);
    const edited = await payroll.updateItem(ctx, run.id, karimItem?.id as string, { deductions: 500_000 });
    expect(edited.items.find((i) => i.employeeId === karim.id)).toMatchObject({ gross: 6_000_000, deductions: 500_000, net: 5_500_000 });
    expect(edited.totals.net).toBe(16_500_000);

    await expect(payroll.post(ctx, run.id)).rejects.toThrow(/Choose the account to pay Nadia Islam/);
    await payroll.updateItem(ctx, run.id, nadiaItem?.id as string, { accountId: bank });
    const posted = await payroll.post(ctx, run.id);
    expect(posted.status).toBe("posted");
    expect(posted.items.every((i) => i.transactionId && i.transactionStatus === "posted")).toBe(true);

    const payrollCategory = await category("Payroll");
    const rahimTx = await transactions.get(ctx, posted.items.find((i) => i.employeeId === rahim.id)?.transactionId as string);
    expect(rahimTx).toMatchObject({
      type: "expense",
      amount: 8_000_000,
      projectId: app,
      categoryId: payrollCategory,
      counterpartyId: rahim.counterpartyId,
      date: today,
    });
    expect(rahimTx.metadata).toMatchObject({ payrollRunId: run.id, payrollItemId: posted.items.find((i) => i.employeeId === rahim.id)?.id });
    const monthExpenses = await transactions.list(ctx, { from: monthStart, type: ["expense"], categoryId: payrollCategory });
    expect(monthExpenses.totals.expense).toBe(16_500_000);
    const profile = await finance.profile(ctx, app);
    expect(profile.actual.costByGroup).toEqual([expect.objectContaining({ group: "payroll", amount: 8_000_000 })]);

    await expect(payroll.updateItem(ctx, run.id, karimItem?.id as string, { deductions: 0 })).rejects.toThrow(/Un-post/);
    const reverted = await payroll.unpost(ctx, run.id);
    expect(reverted.status).toBe("draft");
    expect(reverted.items.every((i) => i.transactionId === null)).toBe(true);
    expect((await transactions.get(ctx, rahimTx.id)).status).toBe("void");
    expect((await transactions.list(ctx, { from: monthStart, categoryId: payrollCategory })).total).toBe(0);
    expect((await finance.profile(ctx, app)).actual.cost.amount).toBe(0);

    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, run.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["payroll_run.created", "payroll_item.updated", "payroll_run.posted", "payroll_run.unposted"]));
    expect(await payroll.removeEmployee(ctx, karim.id)).toEqual({ deactivated: true });
    expect((await payroll.listRuns(ctx))[0]).toMatchObject({ period, itemCount: 3 });
  });

  it("pays one employee for one month with proof, never twice, and the run skips them", async () => {
    const proof = async () => {
      const [row] = await db
        .insert(files)
        .values({
          workspaceId: ctx.workspaceId,
          storageKey: `test/${crypto.randomUUID()}`,
          filename: "bkash.png",
          contentType: "image/png",
          size: 10,
          sha256: crypto.randomUUID(),
        })
        .returning();
      return row?.id as string;
    };
    const rahim = await payroll.createEmployee(ctx, { name: "Rahim Uddin", salary: 5_000_000, currency: "BDT", accountId: bank, defaultProjectId: app });
    const karim = await payroll.createEmployee(ctx, { name: "Karim Ahmed", salary: 4_000_000, currency: "BDT", accountId: bank, defaultProjectId: app });
    const period = monthKey(m1);

    // Proof is required.
    await expect(payroll.payEmployee(ctx, rahim.id, { period, paidOn: m1, attachmentFileIds: [] })).rejects.toThrow();

    const detail = await payroll.payEmployee(ctx, rahim.id, { period, paidOn: addDays(m1, 2), attachmentFileIds: [await proof()] });
    const month = detail.months.find((m) => m.period === period);
    expect(month).toMatchObject({ status: "paid", amount: 5_000_000, paidOn: addDays(m1, 2) });
    const paid = await transactions.get(ctx, month?.transactionId as string);
    expect(paid).toMatchObject({ type: "expense", amount: 5_000_000, projectId: app, categoryId: await category("Payroll") });
    expect(paid.attachmentFileId).toBeTruthy();

    await expect(payroll.payEmployee(ctx, rahim.id, { period, paidOn: m1, attachmentFileIds: [await proof()] })).rejects.toMatchObject({
      code: "already_paid",
    });

    // The month's run already has Rahim paid; posting pays only Karim.
    const run = (await payroll.listRuns(ctx)).find((r) => r.period === period);
    const runId = run?.id as string;
    const withKarim = await payroll.runDetail(ctx, runId);
    expect(withKarim.items.map((i) => i.employeeId)).toEqual([rahim.id]);
    await expect(payroll.deleteRun(ctx, runId)).rejects.toMatchObject({ code: "run_has_payments" });
    await payroll.payEmployee(ctx, karim.id, { period, paidOn: m1, amount: 3_500_000, attachmentFileIds: [await proof()] });
    const posted = await payroll.post(ctx, runId);
    const salaryTx = (await transactions.list(ctx, { type: ["expense"], categoryId: await category("Payroll") })).items.filter(
      (t) => t.status !== "void",
    );
    expect(salaryTx.map((t) => t.amount).sort()).toEqual([3_500_000, 5_000_000]);
    expect(posted.status).toBe("posted");

    // Un-posting the run keeps the payments made one by one.
    await payroll.unpost(ctx, runId);
    expect((await payroll.employeeDetail(ctx, rahim.id)).months.find((m) => m.period === period)?.status).toBe("paid");

    // Undoing a payment voids the expense and the month is unpaid again.
    const undone = await payroll.unpayEmployee(ctx, rahim.id, { period });
    expect(undone.months.find((m) => m.period === period)?.status).toBe("unpaid");
    expect((await transactions.get(ctx, month?.transactionId as string)).status).toBe("void");
  });

  it("is only available in business workspaces", async () => {
    await expect(payroll.listRuns(user.personal)).rejects.toThrow(/available in business workspaces/);
    await expect(payroll.createEmployee(user.personal, { name: "X", salary: 1, currency: "BDT" })).rejects.toThrow(/available in business workspaces/);
  });

  it("creates a monthly payroll commitment on the pay day when asked", async () => {
    const employee = await payroll.createEmployee(ctx, {
      name: "Sadia Khan",
      salary: 5_000_000,
      currency: "BDT",
      payDay: 28,
      startDate: today,
      accountId: bank,
      defaultProjectId: app,
      createSalaryCommitment: true,
    });
    expect(employee.commitments).toEqual([expect.objectContaining({ kind: "payroll", amount: 5_000_000, status: "active" })]);
    expect(employee.commitments[0]?.nextDueDate).toBe(nextPayDate(today, 28));
    // The commitment is attributed to the employee's project as a recurring cost (estimated).
    const profile = await finance.profile(ctx, app);
    expect(profile.estimated.recurringMonthlyCost).toMatchObject({ amount: 5_000_000 });
    expect(profile.estimated.recurringMonthlyCost.items).toEqual([expect.objectContaining({ kind: "payroll", baseMonthly: 5_000_000 })]);
    expect(profile.actual.cost.amount).toBe(0);
  });
});

describe("workspace isolation", () => {
  it("keeps projects, employees and runs inside their workspace", async () => {
    const other = await createUser("Someone Else");
    const employee = await payroll.createEmployee(ctx, { name: "Rahim Uddin", salary: 1_000_000, currency: "BDT", accountId: bank });
    const run = await payroll.createRun(ctx, { period: monthKey(today), payDate: today });

    await expect(finance.profile(other.business, app)).rejects.toThrow(/not found/);
    await expect(payroll.employeeDetail(other.business, employee.id)).rejects.toThrow(/not found/);
    await expect(payroll.runDetail(other.business, run.id)).rejects.toThrow(/not found/);
    await expect(payroll.post(other.business, run.id)).rejects.toThrow(/not found/);
    await expect(payroll.createEmployee(other.business, { name: "Y", salary: 1, currency: "BDT", accountId: bank })).rejects.toThrow(
      /not found in this workspace/,
    );
    await expect(
      payroll.updateItem(ctx, run.id, run.items[0]?.id as string, { projectId: (await projectsService.list(other.business))[0]?.id }),
    ).rejects.toThrow(/not found in this workspace/);
    expect((await payroll.listEmployees(other.business)).items).toHaveLength(0);
    expect((await finance.overview(other.business)).projects.map((p) => p.project.id)).not.toContain(app);
    expect((await revenue.analytics(other.business)).totals.revenue).toBe(0);
  });
});
