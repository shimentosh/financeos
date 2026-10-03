import { addDays, addMonths, investmentMetrics, startOfMonth } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayFor } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { auditLogs, categories, domainEvents, inboxItems, jobs, notifications, receivables as receivableTable } from "../../src/db/schema/index.js";
import { SchedulerService } from "../../src/modules/jobs/scheduler.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { FxService } from "../../src/modules/ledger/fx.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { JobsService } from "../../src/modules/system/jobs.service.js";
import { AssetsService } from "../../src/modules/wealth/assets.service.js";
import { InvestmentsService } from "../../src/modules/wealth/investments.service.js";
import { LiabilitiesService } from "../../src/modules/wealth/liabilities.service.js";
import { NetWorthService } from "../../src/modules/wealth/net-worth.service.js";
import { ReceivablesService } from "../../src/modules/wealth/receivables.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let transactions: TransactionsService;
let accounts: AccountsService;
let assets: AssetsService;
let investments: InvestmentsService;
let liabilities: LiabilitiesService;
let receivables: ReceivablesService;
let netWorth: NetWorthService;
let fx: FxService;
let user: TestUser;
let bkash: string;
let today: string;
let monthStart: string;

beforeAll(async () => {
  transactions = await service(TransactionsService);
  accounts = await service(AccountsService);
  assets = await service(AssetsService);
  investments = await service(InvestmentsService);
  liabilities = await service(LiabilitiesService);
  receivables = await service(ReceivablesService);
  netWorth = await service(NetWorthService);
  fx = await service(FxService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Ayesha Rahman");
  today = todayFor(user.personal);
  monthStart = startOfMonth(today);
  bkash = (
    await accounts.create(user.personal, {
      name: "bKash",
      kind: "mobile_wallet",
      currency: "BDT",
      openingBalance: 5_000_000,
      openingDate: addMonths(monthStart, -3),
    })
  ).id;
});

const balanceOf = async (ctx: TestUser["personal"], id: string) => (await accounts.list(ctx)).find((a) => a.id === id)?.balance;
const categoryId = async (workspaceId: string, name: string) =>
  (
    await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), eq(categories.name, name)))
  )[0]?.id as string;

describe("assets", () => {
  it("records a purchase that moves money but is not an expense, then values and sells it", async () => {
    const asset = await assets.create(user.personal, {
      name: "MacBook Pro",
      kind: "electronics",
      purchasePrice: 2_000_000,
      currency: "BDT",
      purchaseDate: addDays(today, -10),
      currentValue: 1_800_000,
      valuedAt: addDays(today, -10),
      paidFromAccountId: bkash,
    });
    expect(asset.transactions).toHaveLength(1);
    expect(asset.transactions[0]).toMatchObject({ type: "asset_purchase", direction: "out", amount: 2_000_000 });
    expect(asset).toMatchObject({ gain: -200_000, gainPercent: -10, baseCurrentValue: 1_800_000 });
    expect(await balanceOf(user.personal, bkash)).toBe(3_000_000);
    const listed = await transactions.list(user.personal, {});
    expect(listed.totals).toMatchObject({ expense: 0, income: 0, moneyOut: 2_000_000 });

    await assets.addValuation(user.personal, asset.id, { value: 1_700_000, date: today });
    // An older valuation joins the history without replacing the latest.
    await assets.addValuation(user.personal, asset.id, { value: 1_900_000, date: addDays(today, -5) });
    const valued = await assets.detail(user.personal, asset.id);
    expect(valued).toMatchObject({ currentValue: 1_700_000, valuedAt: today });
    expect(valued.valuations.map((v) => v.value)).toEqual([1_700_000, 1_900_000, 1_800_000]);
    await expect(assets.addValuation(user.personal, asset.id, { value: 1, date: addDays(today, 1) })).rejects.toThrow(/future/);

    const list = await assets.list(user.personal);
    expect(list.totals).toMatchObject({ currency: "BDT", count: 1, currentValue: 1_700_000, purchasePrice: 2_000_000, gain: -300_000 });

    const sold = await assets.sell(user.personal, asset.id, { date: today, amount: 1_500_000, proceedsAccountId: bkash });
    expect(sold.realizedGain).toBe(-500_000);
    expect(sold.asset).toMatchObject({ status: "sold", soldOn: today, soldAmount: 1_500_000 });
    const proceeds = await transactions.get(user.personal, sold.proceedsTransactionId as string);
    expect(proceeds).toMatchObject({ type: "adjustment", direction: "in", amount: 1_500_000, costBasis: 2_000_000, assetId: asset.id });
    expect(await balanceOf(user.personal, bkash)).toBe(4_500_000);
    expect((await transactions.list(user.personal, {})).totals).toMatchObject({ income: 0, expense: 0 });
    expect((await assets.list(user.personal)).items).toHaveLength(0);
    expect((await assets.list(user.personal, { status: "all" })).totals.realizedGain).toBe(-500_000);
    await expect(assets.sell(user.personal, asset.id, { date: today, amount: 1 })).rejects.toThrow(/already sold/);

    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, asset.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["asset.created", "asset.valued", "asset.sold"]));
  });

  it("lists assets that cannot be converted separately and refuses to delete one with money moved", async () => {
    await assets.create(user.personal, { name: "Camera", kind: "electronics", currency: "JPY", currentValue: 150_000 });
    const land = await assets.create(user.personal, {
      name: "Land",
      kind: "land",
      currency: "BDT",
      purchasePrice: 1_000_000,
      currentValue: 1_500_000,
      paidFromAccountId: bkash,
    });
    const list = await assets.list(user.personal);
    expect(list.unconvertible).toEqual([expect.objectContaining({ name: "Camera", currency: "JPY" })]);
    expect(list.totals.currentValue).toBe(1_500_000);

    await expect(assets.remove(user.personal, land.id)).rejects.toThrow(/linked transaction/);
    const removed = await assets.remove(user.personal, land.id, { voidLinked: true });
    expect(removed.voidedTransactionIds).toHaveLength(1);
    expect(await balanceOf(user.personal, bkash)).toBe(5_000_000);
  });
});

describe("investments", () => {
  it("keeps contributions and withdrawals out of spending and matches the core metrics", async () => {
    const fund = await investments.create(user.personal, { name: "DSE Portfolio", kind: "stock", currency: "BDT", openedOn: addDays(today, -60) });
    await investments.recordFlow(user.personal, fund.id, { direction: "out", amount: 1_000_000, accountId: bkash, date: addDays(today, -60) });
    await investments.recordFlow(user.personal, fund.id, { direction: "out", amount: 500_000, accountId: bkash, date: addDays(today, -30) });
    await expect(
      investments.recordFlow(user.personal, fund.id, { direction: "in", amount: 600_000, costBasis: 2_000_000, accountId: bkash, date: addDays(today, -10) }),
    ).rejects.toThrow(/more than what is still invested/);
    await investments.recordFlow(user.personal, fund.id, { direction: "in", amount: 600_000, costBasis: 400_000, accountId: bkash, date: addDays(today, -10) });
    const { investment } = await investments.addValuation(user.personal, fund.id, { value: 1_300_000, date: today });
    expect(investment.currentValue).toBe(1_300_000);

    const expected = investmentMetrics({
      openingCostBasis: 0,
      flows: [
        { direction: "out", amount: 1_000_000 },
        { direction: "out", amount: 500_000 },
        { direction: "in", amount: 600_000, costBasis: 400_000 },
      ],
      currentValue: 1_300_000,
    });
    const detail = await investments.detail(user.personal, fund.id);
    expect(detail.metrics).toEqual(expected);
    expect(detail.metrics).toMatchObject({
      contributed: 1_500_000,
      withdrawn: 600_000,
      costBasis: 1_100_000,
      realizedGain: 200_000,
      unrealizedGain: 200_000,
      roi: 26.7,
    });
    expect(detail.flows).toHaveLength(3);
    expect(detail).toMatchObject({ valueSource: "valuation", value: 1_300_000, valuationOutdated: false });

    const list = await investments.list(user.personal);
    expect(list.byKind).toEqual([expect.objectContaining({ kind: "stock", contributed: 1_500_000, value: 1_300_000, realizedGain: 200_000, roi: 26.7 })]);
    expect(list.totals).toMatchObject({ currency: "BDT", count: 1, valuedCount: 1, unrealizedGain: 200_000 });

    expect((await transactions.list(user.personal, {})).totals).toMatchObject({ income: 0, expense: 0 });
    expect(await balanceOf(user.personal, bkash)).toBe(5_000_000 - 1_500_000 + 600_000);
  });
});

describe("liabilities", () => {
  it("records borrowing once and splits a payment into principal and an interest expense", async () => {
    const loan = await liabilities.create(user.personal, {
      kind: "loan",
      name: "Car loan",
      counterpartyName: "City Bank",
      principal: 1_000_000,
      currency: "BDT",
      openingOutstanding: 1_000_000,
      startDate: addDays(today, -30),
      dueDate: addDays(today, 365),
      receivedIntoAccountId: bkash,
    });
    expect(loan).toMatchObject({ outstanding: 1_000_000, borrowed: 1_000_000, openingOutstanding: 0, status: "active", counterparty: "City Bank" });
    expect(loan.counterpartyId).toBeTruthy();
    expect(await balanceOf(user.personal, bkash)).toBe(6_000_000);

    const paid = await liabilities.pay(user.personal, loan.id, { amount: 150_000, interest: 20_000, accountId: bkash, date: today });
    expect(paid).toMatchObject({ principal: 130_000, interest: 20_000 });
    expect(paid.liability).toMatchObject({ outstanding: 870_000, paid: 130_000, interestPaid: 20_000 });
    const principalTx = await transactions.get(user.personal, paid.principalTransactionId as string);
    const interestTx = await transactions.get(user.personal, paid.interestTransactionId as string);
    expect(principalTx).toMatchObject({ type: "debt_payment", direction: "out", amount: 130_000, liabilityId: loan.id });
    expect(interestTx).toMatchObject({
      type: "expense",
      amount: 20_000,
      liabilityId: null,
      categoryId: await categoryId(user.personal.workspaceId, "Interest"),
    });
    expect(interestTx.metadata).toMatchObject({ liabilityId: loan.id, interest: true });
    expect((await transactions.list(user.personal, {})).totals.expense).toBe(20_000);
    expect(await balanceOf(user.personal, bkash)).toBe(6_000_000 - 150_000);

    await expect(liabilities.pay(user.personal, loan.id, { amount: 900_000, accountId: bkash, date: today })).rejects.toThrow(/more than the outstanding/);
    const settled = await liabilities.pay(user.personal, loan.id, { amount: 870_000, accountId: bkash, date: today });
    expect(settled.liability).toMatchObject({ outstanding: 0, status: "paid_off", storedStatus: "paid_off" });
  });

  it("creates the Interest category once in a workspace that has none", async () => {
    const ctx = user.business;
    expect(await categoryId(ctx.workspaceId, "Interest")).toBeUndefined();
    const bank = (
      await accounts.create(ctx, { name: "Company bank", kind: "bank", currency: "BDT", openingBalance: 1_000_000, openingDate: addMonths(monthStart, -1) })
    ).id;
    const debt = await liabilities.create(ctx, {
      kind: "business_debt",
      name: "Supplier credit",
      principal: 500_000,
      currency: "BDT",
      openingOutstanding: 500_000,
    });
    await liabilities.pay(ctx, debt.id, { amount: 110_000, interest: 10_000, accountId: bank, date: today });
    await liabilities.pay(ctx, debt.id, { amount: 105_000, interest: 5_000, accountId: bank, date: today });
    const interest = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ctx.workspaceId), eq(categories.name, "Interest")));
    expect(interest).toHaveLength(1);
    expect((await liabilities.detail(ctx, debt.id)).outstanding).toBe(300_000);
  });

  it("computes overdue status, groups by kind and shows payables paid as expenses", async () => {
    const shopping = await categoryId(user.personal.workspaceId, "Shopping");
    await liabilities.create(user.personal, {
      kind: "personal_debt",
      name: "Borrowed from Karim",
      counterpartyName: "Karim",
      principal: 200_000,
      currency: "BDT",
      openingOutstanding: 200_000,
      dueDate: addDays(today, -3),
    });
    const bill = await liabilities.create(user.personal, {
      kind: "payable",
      name: "Furniture order",
      counterpartyName: "Hatil",
      principal: 300_000,
      currency: "BDT",
      openingOutstanding: 300_000,
      categoryId: shopping,
      dueDate: addDays(today, 10),
    });
    const list = await liabilities.list(user.personal);
    expect(list.groups.map((g) => g.kind).sort()).toEqual(["payable", "personal_debt"]);
    expect(list.totals).toMatchObject({ outstanding: 500_000, overdueCount: 1, overdueOutstanding: 200_000 });
    expect(list.items.find((i) => i.kind === "personal_debt")).toMatchObject({ status: "overdue", daysOverdue: 3 });

    const { principalTransactionId } = await liabilities.pay(user.personal, bill.id, { amount: 100_000, accountId: bkash, date: today });
    expect(await transactions.get(user.personal, principalTransactionId as string)).toMatchObject({
      type: "expense",
      categoryId: shopping,
      liabilityId: bill.id,
    });
    const payables = await liabilities.payables(user.personal);
    expect(payables.items.find((p) => p.id === bill.id)).toMatchObject({
      amount: 300_000,
      paid: 100_000,
      remaining: 200_000,
      categoryName: "Shopping",
      counterparty: "Hatil",
      status: "active",
    });
    expect(payables.totals).toMatchObject({ remaining: 400_000, overdue: 200_000, overdueCount: 1, dueNext30Days: 200_000 });
    expect((await liabilities.payables(user.personal, { overdue: "true" })).items).toHaveLength(1);
  });

  it("creates an installment commitment when a schedule is given, atomically", async () => {
    const loan = await liabilities.create(user.personal, {
      kind: "loan",
      name: "Home loan",
      counterpartyName: "BRAC Bank",
      principal: 1_000_000,
      currency: "BDT",
      openingOutstanding: 1_000_000,
      receivedIntoAccountId: bkash,
      schedule: { amount: 50_000, frequency: "monthly", firstDueDate: addDays(today, 5), autoPay: false },
    });
    expect(loan.commitments).toEqual([
      expect.objectContaining({ kind: "loan_payment", amount: 50_000, frequency: "monthly", status: "active", nextDueDate: addDays(today, 5) }),
    ]);
    expect(loan.nextDueDate).toBe(addDays(today, 5));
    expect(await balanceOf(user.personal, bkash)).toBe(6_000_000);

    // The longest allowed name still makes a valid commitment name.
    const long = await liabilities.create(user.personal, {
      kind: "loan",
      name: "L".repeat(120),
      principal: 1_000,
      currency: "BDT",
      openingOutstanding: 1_000,
      schedule: { amount: 100, frequency: "monthly", firstDueDate: addDays(today, 5), autoPay: false },
    });
    expect(long.commitments[0]?.name.length).toBeLessThanOrEqual(120);
  });
});

describe("receivables", () => {
  it("moves through partial, paid and overdue states", async () => {
    const services = await categoryId(user.personal.workspaceId, "Freelance");
    const invoice = await receivables.create(user.personal, {
      counterpartyName: "Acme Ltd",
      title: "Website build",
      reference: "INV-001",
      amount: 1_000_000,
      currency: "BDT",
      issueDate: addDays(today, -20),
      dueDate: addDays(today, 10),
      categoryId: services,
    });
    expect(invoice).toMatchObject({ status: "pending", remaining: 1_000_000, agingBucket: "current" });
    const partial = await receivables.pay(user.personal, invoice.id, { amount: 400_000, accountId: bkash, date: today });
    expect(partial.transaction).toMatchObject({ type: "income", direction: "in", receivableId: invoice.id, categoryId: services });
    expect(partial.receivable).toMatchObject({ status: "partially_paid", paid: 400_000, remaining: 600_000, storedStatus: "partially_paid" });
    await expect(receivables.pay(user.personal, invoice.id, { amount: 700_000, accountId: bkash, date: today })).rejects.toThrow(/more than/);
    const done = await receivables.pay(user.personal, invoice.id, { amount: 600_000, accountId: bkash, date: today });
    expect(done.receivable).toMatchObject({ status: "paid", remaining: 0, agingBucket: null });
    expect((await transactions.list(user.personal, {})).totals.income).toBe(1_000_000);

    const late = await receivables.create(user.personal, {
      counterpartyName: "Beta Corp",
      title: "Consulting",
      amount: 500_000,
      currency: "BDT",
      issueDate: addDays(today, -80),
      dueDate: addDays(today, -45),
    });
    expect(late).toMatchObject({ status: "overdue", daysOverdue: 45, agingBucket: "31-60" });
    const list = await receivables.list(user.personal);
    expect(list.totals).toMatchObject({ outstanding: 500_000, overdueAmount: 500_000, overdueCount: 1 });
    expect(list.totals.aging).toMatchObject({ current: 0, "31-60": 500_000 });
    expect((await receivables.list(user.personal, { status: ["paid"] })).items.map((i) => i.id)).toEqual([invoice.id]);
    expect((await receivables.list(user.personal, { overdue: "true" })).items.map((i) => i.id)).toEqual([late.id]);

    const cancelled = await receivables.update(user.personal, late.id, { status: "cancelled" });
    expect(cancelled.status).toBe("cancelled");
    expect((await receivables.list(user.personal)).totals.outstanding).toBe(0);
  });

  it("records money lent as a loan out and its collection as a debt payment in", async () => {
    await expect(
      receivables.create(user.personal, {
        kind: "invoice",
        counterpartyName: "X",
        title: "X",
        amount: 1,
        currency: "BDT",
        issueDate: today,
        lentFromAccountId: bkash,
      }),
    ).rejects.toThrow(/loan receivable/);
    const lent = await receivables.create(user.personal, {
      kind: "loan",
      counterpartyName: "Rafiq",
      title: "Loan to Rafiq",
      amount: 300_000,
      currency: "BDT",
      issueDate: today,
      lentFromAccountId: bkash,
    });
    expect(lent.transactions[0]).toMatchObject({ type: "loan", direction: "out", amount: 300_000 });
    expect(lent).toMatchObject({ paid: 0, remaining: 300_000 });
    const back = await receivables.pay(user.personal, lent.id, { amount: 300_000, accountId: bkash, date: today });
    expect(back.transaction).toMatchObject({ type: "debt_payment", direction: "in" });
    expect(back.receivable.status).toBe("paid");
    expect((await transactions.list(user.personal, {})).totals).toMatchObject({ income: 0, expense: 0 });
    expect(await balanceOf(user.personal, bkash)).toBe(5_000_000);
  });

  it("raises overdue reminders once per milestone however often the job runs", async () => {
    const ws = user.personal.workspaceId;
    const due = addDays(today, -1);
    const invoice = await receivables.create(user.personal, {
      counterpartyName: "Acme Ltd",
      title: "Retainer",
      amount: 250_000,
      currency: "BDT",
      issueDate: addDays(today, -31),
      dueDate: due,
    });

    const first = await receivables.scanOverdue(ws);
    expect(first).toMatchObject({ overdue: 1, notified: 1 });
    const again = await receivables.scanOverdue(ws);
    expect(again).toMatchObject({ overdue: 1, notified: 0 });
    const count = async () => ({
      inbox: await db
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.workspaceId, ws), eq(inboxItems.kind, "receivable_overdue"))),
      notices: await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.workspaceId, ws), eq(notifications.kind, "receivable_overdue"))),
      events: await db
        .select()
        .from(domainEvents)
        .where(and(eq(domainEvents.workspaceId, ws), eq(domainEvents.type, "invoice.overdue"))),
    });
    let seen = await count();
    expect(seen.inbox).toHaveLength(1);
    expect(seen.inbox[0]).toMatchObject({ status: "open", entityId: invoice.id, dedupeKey: `receivable_overdue:${invoice.id}:1` });
    expect(seen.notices).toHaveLength(1);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.payload).toMatchObject({ receivableId: invoice.id, milestone: 1, remaining: 250_000 });
    const [stored] = await db.select().from(receivableTable).where(eq(receivableTable.id, invoice.id));
    expect(stored?.status).toBe("overdue");

    // A week later: the 7-day reminder supersedes the first, once.
    await receivables.scanOverdue(ws, addDays(due, 7));
    await receivables.scanOverdue(ws, addDays(due, 7));
    seen = await count();
    expect(seen.inbox).toHaveLength(2);
    expect(seen.inbox.find((i) => i.dedupeKey.endsWith(":1"))?.status).toBe("resolved");
    expect(seen.inbox.find((i) => i.dedupeKey.endsWith(":7"))?.status).toBe("open");
    expect(seen.notices).toHaveLength(2);
    expect(seen.events).toHaveLength(2);

    // Paid: the open reminder is resolved.
    await receivables.pay(user.personal, invoice.id, { amount: 250_000, accountId: bkash, date: today });
    seen = await count();
    expect(seen.inbox.every((i) => i.status === "resolved")).toBe(true);
  });

  it("fans the daily task out as one deduplicated job per workspace", async () => {
    await receivables.create(user.personal, {
      counterpartyName: "Acme Ltd",
      title: "Retainer",
      amount: 250_000,
      currency: "BDT",
      issueDate: addDays(today, -31),
      dueDate: addDays(today, -2),
    });
    const scheduler = await service(SchedulerService);
    const jobService = await service(JobsService);
    expect(scheduler.list().map((t) => t.name)).toContain("wealth.receivables");
    expect(jobService.registeredTypes()).toContain("wealth.receivables-overdue");
    await scheduler.runTask("wealth.receivables");
    await scheduler.runTask("wealth.receivables");
    const queued = await db.select().from(jobs).where(eq(jobs.type, "wealth.receivables-overdue"));
    expect(queued).toHaveLength(2); // personal + business workspace, not doubled
    expect(new Set(queued.map((j) => j.dedupeKey)).size).toBe(2);
    await jobService.runDue(10);
    const finished = await db.select().from(jobs).where(eq(jobs.type, "wealth.receivables-overdue"));
    expect(finished.every((j) => j.status === "succeeded")).toBe(true);
    const inbox = await db.select().from(inboxItems).where(eq(inboxItems.workspaceId, user.personal.workspaceId));
    expect(inbox).toHaveLength(1);
  });
});

describe("net worth", () => {
  it("values today and each month end from as-of data, and flags missing rates and valuations", async () => {
    const ctx = user.personal;
    const m3 = addMonths(monthStart, -3);
    const m2 = addMonths(monthStart, -2);
    const m1 = addMonths(monthStart, -1);
    const chf = (await accounts.create(ctx, { name: "Swiss account", kind: "bank", currency: "CHF", openingBalance: 50_000, openingDate: m3 })).id;

    const laptop = await assets.create(ctx, {
      name: "Laptop",
      kind: "electronics",
      purchasePrice: 1_000_000,
      currency: "BDT",
      purchaseDate: addDays(m2, 4),
      currentValue: 1_000_000,
      valuedAt: addDays(m2, 4),
      paidFromAccountId: bkash,
    });
    await assets.addValuation(ctx, laptop.id, { value: 1_200_000, date: addDays(m1, 9) });
    const fund = await investments.create(ctx, { name: "Sanchayapatra", kind: "savings_certificate", currency: "BDT", openedOn: addDays(m1, 2) });
    await investments.recordFlow(ctx, fund.id, { direction: "out", amount: 500_000, accountId: bkash, date: addDays(m1, 2) });
    const loan = await liabilities.create(ctx, {
      kind: "loan",
      name: "Bank loan",
      principal: 2_000_000,
      currency: "BDT",
      openingOutstanding: 2_000_000,
      startDate: addDays(m1, 14),
      receivedIntoAccountId: bkash,
    });
    const invoice = await receivables.create(ctx, {
      counterpartyName: "Acme",
      title: "Design work",
      amount: 400_000,
      currency: "BDT",
      issueDate: addDays(m1, 19),
    });
    await liabilities.pay(ctx, loan.id, { amount: 300_000, accountId: bkash, date: monthStart });
    await receivables.pay(ctx, invoice.id, { amount: 100_000, accountId: bkash, date: monthStart });
    await transactions.create(ctx, {
      type: "expense",
      accountId: bkash,
      amount: 50_000,
      currency: "BDT",
      date: monthStart,
      categoryId: await categoryId(ctx.workspaceId, "Groceries"),
    });

    const current = await netWorth.current(ctx);
    // bKash 5,250,000 + laptop 1,200,000 + investment at cost 500,000 + receivable 300,000 − loan 1,700,000
    expect(current.netWorth).toBe(5_550_000);
    expect(current.assets).toMatchObject({ cash: 5_250_000, assets: 1_200_000, investments: 500_000, receivables: 300_000 });
    expect(current.liabilities).toMatchObject({ debts: 1_700_000, byKind: { loan: 1_700_000 } });
    expect(current.complete).toBe(false);
    expect(current.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_rate", entityId: chf }),
        expect.objectContaining({ code: "no_valuation", entityId: fund.id }),
      ]),
    );
    expect(current.previousMonth.netWorth).toBe(5_600_000);
    expect(current.change).toBe(-50_000);

    const history = await netWorth.history(ctx, 4);
    expect(history.points.map((p) => p.netWorth)).toEqual([5_000_000, 5_000_000, 5_600_000, 5_550_000]);
    expect(history.points.map((p) => p.month)).toEqual([m3, m2, m1, monthStart].map((d) => d.slice(0, 7)));
    expect(history.points.every((p) => !p.complete)).toBe(true);
    expect(history.points[2]?.assets).toMatchObject({ cash: 5_500_000, assets: 1_200_000, investments: 500_000, receivables: 400_000 });
    expect(history.points[1]?.assets.assets).toBe(1_000_000);

    // With a CHF rate and a valuation, today is complete; last month still was not valued.
    await fx.upsert(ctx, { fromCurrency: "CHF", toCurrency: "BDT", rate: "150", date: m3 });
    await investments.addValuation(ctx, fund.id, { value: 550_000, date: today });
    const later = await netWorth.history(ctx, 2);
    expect(later.points[1]).toMatchObject({ complete: true, netWorth: 5_550_000 + 50_000 + 7_500_000 });
    expect(later.points[0]?.complete).toBe(false);
    expect(later.warnings).toEqual([]);

    const summary = await netWorth.summary(ctx);
    expect(summary).toMatchObject({ netWorth: 13_100_000, previous: 13_100_000, change: 0, complete: true, warnings: [], warningCount: 0 });
    expect(summary.assets.total).toBe(summary.netWorth + summary.liabilities.total);
    expect(summary.liabilities.total).toBe(1_700_000);
    expect(summary.trend).toHaveLength(6);
  });
});

describe("workspace isolation", () => {
  it("never shows or links another workspace's wealth records", async () => {
    const other = await createUser("Someone Else");
    const asset = await assets.create(user.personal, { name: "Bike", kind: "vehicle", currency: "BDT", currentValue: 100_000 });
    const fund = await investments.create(user.personal, { name: "Gold", kind: "gold", currency: "BDT" });
    const debt = await liabilities.create(user.personal, { kind: "loan", name: "Loan", principal: 1, currency: "BDT", openingOutstanding: 1 });
    const owed = await receivables.create(user.personal, { counterpartyName: "A", title: "A", amount: 1, currency: "BDT", issueDate: today });

    await expect(assets.detail(other.personal, asset.id)).rejects.toThrow(/not found/);
    await expect(investments.detail(other.personal, fund.id)).rejects.toThrow(/not found/);
    await expect(liabilities.detail(other.personal, debt.id)).rejects.toThrow(/not found/);
    await expect(receivables.detail(other.personal, owed.id)).rejects.toThrow(/not found/);
    await expect(receivables.pay(other.personal, owed.id, { amount: 1, accountId: bkash, date: today })).rejects.toThrow(/not found/);
    await expect(
      assets.create(other.personal, { name: "X", kind: "other", currency: "BDT", purchasePrice: 1, currentValue: 1, paidFromAccountId: bkash }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(investments.recordFlow(user.business, fund.id, { direction: "out", amount: 1, accountId: bkash, date: today })).rejects.toThrow(/not found/);

    expect((await assets.list(other.personal)).items).toHaveLength(0);
    expect((await investments.list(other.personal)).items).toHaveLength(0);
    expect((await liabilities.list(other.personal)).items).toHaveLength(0);
    expect((await receivables.list(other.personal)).items).toHaveLength(0);
    const empty = await netWorth.summary(other.personal);
    expect(empty).toMatchObject({ netWorth: 0, previous: null, change: null });
  });
});
