import { addDays, addMonths, addYears, dueDatesBetween } from "@expensewise/core";
import { and, asc, count, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayFor } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import {
  auditLogs,
  categories,
  commitmentOccurrences,
  commitments,
  domainEvents,
  inboxItems,
  liabilities,
  notifications,
  subscriptions as subscriptionTable,
  transactions as transactionTable,
} from "../../src/db/schema/index.js";
import { SchedulerService } from "../../src/modules/jobs/scheduler.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { PlanningCalendarService } from "../../src/modules/planning/calendar.service.js";
import { CommitmentsService } from "../../src/modules/planning/commitments.service.js";
import { OccurrencesService } from "../../src/modules/planning/occurrences.service.js";
import { REMINDERS_JOB } from "../../src/modules/planning/planning.jobs.js";
import { RemindersService } from "../../src/modules/planning/reminders.service.js";
import { SubscriptionsService } from "../../src/modules/planning/subscriptions.service.js";
import { EventsService } from "../../src/modules/system/events.service.js";
import { JobsService } from "../../src/modules/system/jobs.service.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let transactions: TransactionsService;
let accounts: AccountsService;
let commitmentsService: CommitmentsService;
let occurrences: OccurrencesService;
let subscriptions: SubscriptionsService;
let calendar: PlanningCalendarService;
let reminders: RemindersService;
let user: TestUser;
let T: string;
let bkash: string;
let card: string;
let aiCategory: string;
let rentCategory: string;
let salaryCategory: string;

beforeAll(async () => {
  transactions = await service(TransactionsService);
  accounts = await service(AccountsService);
  commitmentsService = await service(CommitmentsService);
  occurrences = await service(OccurrencesService);
  subscriptions = await service(SubscriptionsService);
  calendar = await service(PlanningCalendarService);
  reminders = await service(RemindersService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Nadia Karim");
  T = todayFor(user.personal);
  bkash = (
    await accounts.create(user.personal, { name: "bKash", kind: "mobile_wallet", currency: "BDT", openingBalance: 50_000_000, openingDate: "2025-01-01" })
  ).id;
  card = (await accounts.create(user.personal, { name: "USD Card", kind: "card", currency: "USD", openingBalance: 0, openingDate: "2025-01-01" })).id;
  const cats = await db.select().from(categories).where(eq(categories.workspaceId, user.personal.workspaceId));
  aiCategory = cats.find((c) => c.name === "AI & APIs")?.id as string;
  rentCategory = cats.find((c) => c.name === "Rent")?.id as string;
  salaryCategory = cats.find((c) => c.name === "Salary")?.id as string;
});

const transactionCount = async () =>
  (await db.select({ value: count() }).from(transactionTable).where(eq(transactionTable.workspaceId, user.personal.workspaceId)))[0]?.value ?? 0;

const occurrencesOf = (commitmentId: string) =>
  db.select().from(commitmentOccurrences).where(eq(commitmentOccurrences.commitmentId, commitmentId)).orderBy(asc(commitmentOccurrences.dueDate));

const scheduledOf = async (commitmentId: string) => (await occurrencesOf(commitmentId)).find((o) => o.status === "scheduled");

const monthly = (overrides: Record<string, unknown> = {}) => ({
  provider: "Netflix",
  planName: "Standard",
  amount: 2_000,
  currency: "USD",
  billingCycle: "monthly" as const,
  startDate: addMonths(T, -1),
  nextRenewalDate: T,
  accountId: card,
  categoryId: aiCategory,
  ...overrides,
});

/** A longer reminder list than the default, to exercise early reminders and once-per-offset dedupe. */
const LONG_REMINDERS = [30, 14, 7, 3, 1, 0];

describe("subscriptions", () => {
  it("links the purchase of an annual plan instead of recording it twice", async () => {
    const { transaction: purchase } = await transactions.create(user.personal, {
      type: "expense",
      accountId: card,
      amount: 20_000,
      currency: "USD",
      date: T,
      merchant: "Anthropic",
      categoryId: aiCategory,
    });
    const before = await transactionCount();
    const { subscription, commitment } = await subscriptions.create(
      user.personal,
      {
        provider: "Anthropic",
        planName: "Claude Pro",
        amount: 20_000,
        currency: "USD",
        billingCycle: "yearly",
        purchaseDate: T,
        startDate: T,
        expiryDate: addYears(T, 1),
        nextRenewalDate: addYears(T, 1),
        accountId: card,
        categoryId: aiCategory,
      },
      { purchaseTransactionId: purchase.id },
    );

    expect(await transactionCount()).toBe(before);
    expect(commitment).toMatchObject({
      kind: "subscription",
      name: "Anthropic Claude Pro",
      frequency: "yearly",
      nextDueDate: addYears(T, 1),
      autoPay: true,
      startDate: T,
    });
    const rows = await occurrencesOf(commitment.id);
    expect(rows.map((o) => [o.dueDate, o.status, o.transactionId])).toEqual([
      [T, "paid", purchase.id],
      [addYears(T, 1), "scheduled", null],
    ]);

    const detail = await subscriptions.detail(user.personal, subscription.id);
    expect(detail).toMatchObject({
      name: "Anthropic Claude Pro",
      billingCycle: "yearly",
      nextRenewalDate: addYears(T, 1),
      baseAmount: 2_440_000,
      annualCost: 20_000,
      monthlyEquivalent: 1_667,
    });
    expect(detail.renewals.map((r) => r.status)).toEqual(["scheduled", "paid"]);
    expect(detail.renewals[1]?.transaction).toMatchObject({ id: purchase.id, createdByPayment: false });
    expect(detail.stats).toMatchObject({ paidCount: 1, totalPaid: 20_000, totalPaidBase: 2_440_000 });

    await expect(
      subscriptions.create(
        user.personal,
        { provider: "Anthropic", amount: 20_000, currency: "USD", billingCycle: "yearly", startDate: T, nextRenewalDate: addYears(T, 1) },
        { purchaseTransactionId: purchase.id },
      ),
    ).rejects.toMatchObject({ status: 409, code: "transaction_already_linked" });
  });

  it("records the purchase once when asked to", async () => {
    const before = await transactionCount();
    const { commitment } = await subscriptions.create(user.personal, {
      provider: "Figma",
      amount: 18_000,
      currency: "USD",
      billingCycle: "yearly",
      startDate: T,
      nextRenewalDate: addYears(T, 1),
      accountId: card,
      recordPurchase: { date: T },
    });
    expect(await transactionCount()).toBe(before + 1);
    const [paid] = await occurrencesOf(commitment.id);
    const [created] = await db
      .select()
      .from(transactionTable)
      .where(eq(transactionTable.id, paid?.transactionId as string));
    expect(created).toMatchObject({ type: "expense", amount: 18_000, currency: "USD", merchant: "Figma", date: T });
    expect(created?.metadata).toMatchObject({ origin: "subscription_purchase", commitmentId: commitment.id });
  });

  it("records a renewal as exactly one expense and moves the renewal forward", async () => {
    const { subscription, commitment } = await subscriptions.create(user.personal, monthly({ expiryDate: T }));
    const due = await scheduledOf(commitment.id);
    expect(due?.dueDate).toBe(T);
    const before = await transactionCount();

    const result = await occurrences.markPaid(user.personal, due?.id as string, { paidOn: T });
    expect(await transactionCount()).toBe(before + 1);
    expect(result.created).toBe(true);
    expect(result.transaction).toMatchObject({
      type: "expense",
      amount: 2_000,
      currency: "USD",
      accountId: card,
      source: "recurring",
      merchant: "Netflix",
      categoryId: aiCategory,
    });
    expect(result.transaction.metadata).toMatchObject({ origin: "commitment_payment", commitmentId: commitment.id, occurrenceId: due?.id });
    expect(result.occurrence).toMatchObject({ status: "paid", paidOn: T, paidAmount: 2_000, transactionId: result.transaction.id });
    expect(result.commitment.nextDueDate).toBe(addMonths(T, 1));
    expect(result.nextOccurrence).toMatchObject({ dueDate: addMonths(T, 1), status: "scheduled", amount: 2_000 });
    expect(result.subscription).toMatchObject({ status: "renewed", expiryDate: addMonths(T, 1) });
    expect(result.priceChange).toBeNull();

    const events = await db.select({ type: domainEvents.type }).from(domainEvents).where(eq(domainEvents.workspaceId, user.personal.workspaceId));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["commitment.paid", "subscription.renewed"]));
    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, due?.id as string));
    expect(audit.map((a) => a.action)).toContain("commitment.paid");

    const detail = await subscriptions.detail(user.personal, subscription.id);
    expect(detail.renewals.map((r) => [r.dueDate, r.status])).toEqual([
      [addMonths(T, 1), "scheduled"],
      [T, "paid"],
    ]);
    expect(detail.renewals[1]?.transaction).toMatchObject({ id: result.transaction.id, createdByPayment: true, accountName: "USD Card" });

    await expect(occurrences.markPaid(user.personal, due?.id as string, { paidOn: T })).rejects.toMatchObject({ status: 409, code: "already_paid" });
    expect(await transactionCount()).toBe(before + 1);
  });

  it("offers an existing matching expense instead of creating a duplicate", async () => {
    const { transaction: existing } = await transactions.create(user.personal, {
      type: "expense",
      accountId: card,
      amount: 2_000,
      currency: "USD",
      date: T,
      merchant: "Netflix",
    });
    const { commitment } = await subscriptions.create(user.personal, monthly());
    const due = (await scheduledOf(commitment.id))?.id as string;

    const conflict = await occurrences.markPaid(user.personal, due, { paidOn: T }).catch((error) => error);
    expect(conflict).toMatchObject({ status: 409, code: "possible_duplicate" });
    expect(conflict.details.candidates[0]).toMatchObject({ id: existing.id, amount: 2_000, accountName: "USD Card" });
    expect(conflict.details.candidates[0].score).toBeGreaterThanOrEqual(0.7);
    const matches = await occurrences.candidates(user.personal, due, { paidOn: T });
    expect(matches.candidates.map((c) => c.id)).toEqual([existing.id]);

    const before = await transactionCount();
    const linked = await occurrences.markPaid(user.personal, due, { paidOn: T, existingTransactionId: existing.id });
    expect(linked).toMatchObject({ created: false, transaction: { id: existing.id }, occurrence: { status: "paid", transactionId: existing.id } });
    expect(await transactionCount()).toBe(before);

    // Already settling one payment, it is neither offered nor linkable again.
    const next = (await scheduledOf(commitment.id))?.id as string;
    await expect(occurrences.markPaid(user.personal, next, { paidOn: T, existingTransactionId: existing.id })).rejects.toMatchObject({
      code: "transaction_already_linked",
    });
    expect((await occurrences.candidates(user.personal, next, { paidOn: T })).candidates).toHaveLength(0);

    // "Create new anyway" is an explicit choice.
    const { transaction: spotify } = await transactions.create(user.personal, {
      type: "expense",
      accountId: card,
      amount: 1_100,
      currency: "USD",
      date: T,
      merchant: "Spotify",
    });
    const { commitment: music } = await subscriptions.create(user.personal, monthly({ provider: "Spotify", planName: null, amount: 1_100 }));
    const musicDue = (await scheduledOf(music.id))?.id as string;
    await expect(occurrences.markPaid(user.personal, musicDue, { paidOn: addDays(T, 1) })).rejects.toMatchObject({ code: "possible_duplicate" });
    const forced = await occurrences.markPaid(user.personal, musicDue, { paidOn: addDays(T, 1), force: true });
    expect(forced.created).toBe(true);
    expect(forced.transaction.id).not.toBe(spotify.id);
  });

  it("flags a price change without changing future renewals unless asked", async () => {
    const { subscription, commitment } = await subscriptions.create(user.personal, monthly({ recordPurchase: { date: addMonths(T, -1) } }));
    const [purchase] = await occurrencesOf(commitment.id);
    const first = await occurrences.markPaid(user.personal, (await scheduledOf(commitment.id))?.id as string, { paidOn: T, amount: 2_400 });

    expect(first.priceChange).toMatchObject({ previous: 2_000, current: 2_400, difference: 400, percent: 20, direction: "increase" });
    expect(first.amountUpdated).toBe(false);
    const [item] = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.workspaceId, user.personal.workspaceId), eq(inboxItems.kind, "price_change")));
    expect(item).toMatchObject({ id: first.inboxItemId, status: "open", entityId: commitment.id, dedupeKey: `price_change:${first.occurrence.id}` });
    expect(item?.data).toMatchObject({
      previousAmount: 2_000,
      newAmount: 2_400,
      percentChange: 20,
      subscriptionId: subscription.id,
      transactionIds: [purchase?.transactionId, first.transaction.id],
    });
    expect((await commitmentsService.get(user.personal, commitment.id)).amount).toBe(2_000);
    expect(first.nextOccurrence?.amount).toBe(2_000);

    const second = await occurrences.markPaid(user.personal, first.nextOccurrence?.id as string, {
      paidOn: addMonths(T, 1),
      amount: 2_600,
      updateFutureAmount: true,
    });
    expect(second.priceChange).toMatchObject({ previous: 2_400, current: 2_600 });
    expect(second.amountUpdated).toBe(true);
    expect((await commitmentsService.get(user.personal, commitment.id)).amount).toBe(2_600);
    expect(second.nextOccurrence).toMatchObject({ dueDate: addMonths(T, 2), amount: 2_600 });
    const items = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.workspaceId, user.personal.workspaceId), eq(inboxItems.kind, "price_change")));
    expect(items).toHaveLength(2);

    const detail = await subscriptions.detail(user.personal, subscription.id);
    expect(detail.priceChanges.map((p) => [p.previous, p.current])).toEqual([
      [2_400, 2_600],
      [2_000, 2_400],
    ]);
  });

  it("cancels, keeps the history and only sends the access-ends notice", async () => {
    const { subscription, commitment } = await subscriptions.create(
      user.personal,
      monthly({ nextRenewalDate: addDays(T, 20), startDate: addDays(T, -10), expiryDate: addDays(T, 20), reminderOffsets: LONG_REMINDERS }),
    );
    const cancelled = await subscriptions.cancel(user.personal, subscription.id, { reason: "Too expensive" });
    expect(cancelled).toMatchObject({
      status: "cancellation_pending",
      derivedStatus: "cancellation_pending",
      commitmentStatus: "ended",
      nextRenewalDate: null,
      expiryDate: addDays(T, 20),
    });
    expect((await occurrencesOf(commitment.id)).map((o) => o.status)).toEqual(["cancelled"]);

    const scan = await reminders.scan(user.personal, T);
    const sent = await db.select().from(notifications).where(eq(notifications.entityId, subscription.id));
    expect(scan.notifications).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "expiry", dedupeKey: `expiry:${subscription.id}:${addDays(T, 20)}:30` });
    expect(sent[0]?.body).toContain("was cancelled");

    await reminders.scan(user.personal, addDays(T, 21));
    expect((await subscriptions.get(user.personal, subscription.id)).status).toBe("expired");
    await expect(subscriptions.cancel(user.personal, subscription.id)).rejects.toMatchObject({ code: "already_cancelled" });

    const reactivated = await subscriptions.resume(user.personal, subscription.id);
    expect(reactivated.commitmentStatus).toBe("active");
    expect(reactivated.nextRenewalDate).not.toBeNull();
  });

  it("pauses and resumes, and lists with filters", async () => {
    const netflix = await subscriptions.create(user.personal, monthly({ nextRenewalDate: addDays(T, 5), startDate: addDays(T, -26) }));
    const claude = await subscriptions.create(user.personal, {
      provider: "Anthropic",
      planName: "Claude Max",
      amount: 20_000,
      currency: "USD",
      billingCycle: "yearly",
      startDate: T,
      nextRenewalDate: addDays(T, 40),
      accountId: card,
      categoryId: aiCategory,
      autoRenew: false,
    });
    const paused = await subscriptions.pause(user.personal, netflix.subscription.id);
    expect(paused).toMatchObject({ status: "paused", commitmentStatus: "paused", nextRenewalDate: null });
    const upcoming = await calendar.upcoming(user.personal, {});
    expect(upcoming.items.find((i) => i.commitmentId === netflix.commitment.id)).toBeUndefined();
    const resumed = await subscriptions.resume(user.personal, netflix.subscription.id);
    expect(resumed).toMatchObject({ commitmentStatus: "active", nextRenewalDate: addDays(T, 5), derivedStatus: "renewal_due" });

    expect((await subscriptions.list(user.personal, { q: "claude" })).items.map((s) => s.id)).toEqual([claude.subscription.id]);
    expect((await subscriptions.list(user.personal, { billingCycle: ["yearly"] })).items.map((s) => s.id)).toEqual([claude.subscription.id]);
    expect((await subscriptions.list(user.personal, { autoRenew: false })).items.map((s) => s.id)).toEqual([claude.subscription.id]);
    expect((await subscriptions.list(user.personal, { renewingIn: addDays(T, 40).slice(0, 7) })).items.map((s) => s.id)).toContain(claude.subscription.id);
    expect((await subscriptions.list(user.personal, { status: ["renewal_due"] })).items.map((s) => s.id)).toEqual([netflix.subscription.id]);
    expect((await subscriptions.list(user.personal, { minAmount: 1_000_000 })).items.map((s) => s.id)).toEqual([claude.subscription.id]);
    const sorted = await subscriptions.list(user.personal, { sort: "amount_desc" });
    expect(sorted.items.map((s) => s.id)).toEqual([claude.subscription.id, netflix.subscription.id]);

    // The commitment routes keep the subscription's status in step.
    await commitmentsService.pause(user.personal, claude.commitment.id);
    expect((await subscriptions.get(user.personal, claude.subscription.id)).status).toBe("paused");
    await commitmentsService.resume(user.personal, claude.commitment.id);
    expect((await subscriptions.get(user.personal, claude.subscription.id)).status).toBe("active");
    await commitmentsService.end(user.personal, claude.commitment.id);
    expect((await subscriptions.get(user.personal, claude.subscription.id)).status).toBe("cancelled");
  });

  it("keeps the scheduled renewal when an edit resends unchanged schedule fields", async () => {
    const form = monthly({ startDate: addDays(T, -10), nextRenewalDate: addDays(T, 25) });
    const { subscription, commitment } = await subscriptions.create(user.personal, form);
    const before = await scheduledOf(commitment.id);
    // What the edit form sends: every field, only the notes changed.
    await subscriptions.update(user.personal, subscription.id, { ...form, intervalCount: 1, intervalUnit: null, notes: "Family plan" });
    const after = await scheduledOf(commitment.id);
    expect(after?.id).toBe(before?.id);
    expect((await subscriptions.get(user.personal, subscription.id)).notes).toBe("Family plan");

    await subscriptions.update(user.personal, subscription.id, { ...form, nextRenewalDate: addDays(T, 26) });
    const moved = await scheduledOf(commitment.id);
    expect(moved?.dueDate).toBe(addDays(T, 26));
    expect(moved?.id).not.toBe(before?.id);
  });

  it("reports analytics in the base currency and lists what it cannot convert", async () => {
    await subscriptions.create(user.personal, monthly({ nextRenewalDate: addDays(T, 5), startDate: addDays(T, -26) }));
    await subscriptions.create(user.personal, {
      provider: "Anthropic",
      amount: 20_000,
      currency: "USD",
      billingCycle: "yearly",
      startDate: T,
      nextRenewalDate: addDays(T, 40),
      accountId: card,
    });
    await subscriptions.create(user.personal, {
      provider: "Nikkei",
      amount: 5_000,
      currency: "JPY",
      billingCycle: "monthly",
      startDate: T,
      nextRenewalDate: addDays(T, 3),
    });
    const cancelled = await subscriptions.create(user.personal, {
      provider: "Old",
      amount: 500,
      currency: "USD",
      billingCycle: "monthly",
      startDate: T,
      nextRenewalDate: addDays(T, 2),
    });
    await subscriptions.cancel(user.personal, cancelled.subscription.id, { effectiveDate: T });

    const analytics = await subscriptions.analytics(user.personal);
    expect(analytics).toMatchObject({ baseCurrency: "BDT", totalCount: 4, activeCount: 3 });
    // Netflix $20/month = 244,000 poisha; Anthropic $200/year = 2,440,000, or $16.67/month = 203,374.
    expect(analytics.monthlyTotal).toBe(244_000 + 203_374);
    expect(analytics.annualTotal).toBe(244_000 * 12 + 2_440_000);
    expect(analytics.annualCommitments).toMatchObject({ count: 1, total: 2_440_000 });
    expect(analytics.upcoming30.items.map((i) => i.name).sort()).toEqual(["Netflix Standard", "Nikkei"]);
    expect(analytics.upcoming30.unconverted).toEqual([{ currency: "JPY", amount: 5_000 }]);
    expect(analytics.unconverted).toEqual([expect.objectContaining({ name: "Nikkei", currency: "JPY", amount: 5_000, annualCost: 60_000 })]);
    expect(analytics.byBillingCycle.map((g) => [g.billingCycle, g.count])).toEqual([
      ["monthly", 2],
      ["yearly", 1],
    ]);
    expect(analytics.byStatus.cancelled).toBe(1);
  });
});

describe("commitments and payments", () => {
  it("computes the schedule, materialises the next occurrence and reschedules on edit", async () => {
    const rent = await commitmentsService.create(user.personal, {
      kind: "rent",
      name: "Flat rent",
      payee: "Landlord",
      amount: 2_500_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: addMonths(T, -3),
      accountId: bkash,
      categoryId: rentCategory,
    });
    const expected = dueDatesBetween({ frequency: "monthly", startDate: addMonths(T, -3) }, T, addMonths(T, 2))[0];
    expect(rent.nextDueDate).toBe(expected);
    expect((await occurrencesOf(rent.id)).map((o) => [o.dueDate, o.status])).toEqual([[expected, "scheduled"]]);

    await commitmentsService.update(user.personal, rent.id, { amount: 2_700_000 });
    expect((await scheduledOf(rent.id))?.amount).toBe(2_700_000);
    const moved = await commitmentsService.update(user.personal, rent.id, { nextDueDate: addDays(T, 3) });
    expect(moved.nextDueDate).toBe(addDays(T, 3));
    expect((await occurrencesOf(rent.id)).map((o) => o.dueDate)).toEqual([addDays(T, 3)]);

    await expect(
      commitmentsService.create(user.personal, {
        kind: "rent",
        name: "Bad",
        amount: 1,
        currency: "BDT",
        frequency: "monthly",
        startDate: T,
        categoryId: salaryCategory,
      }),
    ).rejects.toMatchObject({ code: "category_kind_mismatch" });

    expect(await commitmentsService.remove(user.personal, rent.id)).toEqual({ deleted: true, ended: false });
    expect(await db.select().from(commitments).where(eq(commitments.id, rent.id))).toHaveLength(0);
  });

  it("pays loan installments as debt payments and salary as income", async () => {
    const [loan] = await db
      .insert(liabilities)
      .values({
        workspaceId: user.personal.workspaceId,
        kind: "loan",
        name: "Car loan",
        principal: 100_000_000,
        currency: "BDT",
        openingOutstanding: 100_000_000,
      })
      .returning();
    const installment = await commitmentsService.create(user.personal, {
      kind: "loan_payment",
      name: "Car loan installment",
      amount: 1_500_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: T,
      accountId: bkash,
      liabilityId: loan?.id,
    });
    const paid = await occurrences.payNext(user.personal, installment.id, { paidOn: T });
    expect(paid.transaction).toMatchObject({ type: "debt_payment", direction: "out", liabilityId: loan?.id, categoryId: null, amount: 1_500_000 });

    const salary = await commitmentsService.create(user.personal, {
      kind: "salary",
      direction: "in",
      name: "Salary",
      payee: "Acme Ltd",
      amount: 12_000_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: T,
      accountId: bkash,
      categoryId: salaryCategory,
    });
    const received = await occurrences.payNext(user.personal, salary.id, { paidOn: T });
    expect(received.transaction).toMatchObject({ type: "income", direction: "in", categoryId: salaryCategory, merchant: "Acme Ltd" });
    expect(received.commitment.nextDueDate).toBe(addMonths(T, 1));

    // A one-off ends once paid, and is owed again if the payment is undone.
    const once = await commitmentsService.create(user.personal, {
      kind: "tax",
      name: "Tax return",
      amount: 500_000,
      currency: "BDT",
      frequency: "once",
      startDate: addDays(T, 10),
      accountId: bkash,
    });
    const settled = await occurrences.payNext(user.personal, once.id, { paidOn: T });
    expect(settled.commitment).toMatchObject({ status: "ended", nextDueDate: null });
    const undone = await occurrences.undo(user.personal, settled.occurrence.id);
    expect(undone.commitment).toMatchObject({ status: "active", nextDueDate: addDays(T, 10) });
  });

  it("reverts the occurrence when its payment is voided or undone", async () => {
    const rent = await commitmentsService.create(user.personal, {
      kind: "rent",
      name: "Rent",
      amount: 2_500_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: T,
      accountId: bkash,
    });
    const due = (await scheduledOf(rent.id))?.id as string;
    const paid = await occurrences.markPaid(user.personal, due, { paidOn: T });
    expect((await commitmentsService.get(user.personal, rent.id)).nextDueDate).toBe(addMonths(T, 1));

    await transactions.void(user.personal, paid.transaction.id, "Entered by mistake");
    await (await service(EventsService)).dispatchPending();
    const [reverted] = await db.select().from(commitmentOccurrences).where(eq(commitmentOccurrences.id, due));
    expect(reverted).toMatchObject({ status: "scheduled", transactionId: null, paidOn: null, paidAmount: null });
    expect((await commitmentsService.get(user.personal, rent.id)).nextDueDate).toBe(T);
    const audit = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, due));
    expect(audit.map((a) => a.action)).toContain("commitment.payment_reverted");

    // Undo voids a transaction the payment created...
    const again = await occurrences.markPaid(user.personal, due, { paidOn: T });
    const undone = await occurrences.undo(user.personal, due, { reason: "Wrong account" });
    expect(undone).toMatchObject({ voidedTransactionId: again.transaction.id, unlinkedTransactionId: null, occurrence: { status: "scheduled" } });
    expect((await transactions.get(user.personal, again.transaction.id)).status).toBe("void");
    await (await service(EventsService)).dispatchPending();

    // ...but only unlinks one that already existed.
    const { transaction: manual } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 2_500_000,
      currency: "BDT",
      date: T,
      merchant: "Landlord",
    });
    await occurrences.markPaid(user.personal, due, { paidOn: T, existingTransactionId: manual.id });
    const unlinked = await occurrences.undo(user.personal, due);
    expect(unlinked).toMatchObject({ voidedTransactionId: null, unlinkedTransactionId: manual.id });
    expect((await transactions.get(user.personal, manual.id)).status).toBe("posted");

    const skipped = await occurrences.skip(user.personal, due, { note: "Paid in cash to caretaker" });
    expect(skipped.occurrence.status).toBe("skipped");
    expect(skipped.commitment.nextDueDate).toBe(addMonths(T, 1));
  });
});

describe("upcoming, calendar and annual view", () => {
  it("groups due dates by day with overdue, projected and unconvertible items", async () => {
    const rent = await commitmentsService.create(user.personal, {
      kind: "rent",
      name: "Rent",
      amount: 2_500_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: addDays(T, 5),
      accountId: bkash,
      categoryId: rentCategory,
    });
    const cleaner = await commitmentsService.create(user.personal, {
      kind: "custom",
      name: "Cleaner",
      amount: 100_000,
      currency: "BDT",
      frequency: "weekly",
      startDate: addDays(T, 1),
      accountId: bkash,
    });
    const internet = await commitmentsService.create(user.personal, {
      kind: "utility",
      name: "Internet",
      amount: 150_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: addDays(T, -3),
      nextDueDate: addDays(T, -3),
      accountId: bkash,
    });
    const claude = await subscriptions.create(user.personal, {
      provider: "Anthropic",
      amount: 20_000,
      currency: "USD",
      billingCycle: "yearly",
      startDate: T,
      nextRenewalDate: addDays(T, 10),
      accountId: card,
    });
    const jpy = await subscriptions.create(user.personal, {
      provider: "Nikkei",
      amount: 1_000,
      currency: "JPY",
      billingCycle: "monthly",
      startDate: T,
      nextRenewalDate: addDays(T, 2),
    });

    const upcoming = await calendar.upcoming(user.personal, {});
    const of = (id: string) => upcoming.items.filter((i) => i.commitmentId === id);
    expect(of(cleaner.id).map((i) => [i.date, i.status])).toEqual(
      dueDatesBetween({ frequency: "weekly", startDate: addDays(T, 1) }, T, addDays(T, 30)).map((date, index) => [
        date,
        index === 0 ? "scheduled" : "projected",
      ]),
    );
    expect(of(internet.id)[0]).toMatchObject({ status: "overdue", daysUntil: -3, date: addDays(T, -3) });
    expect(of(rent.id).map((i) => i.date)).toEqual([addDays(T, 5)]);
    expect(of(claude.commitment.id)[0]).toMatchObject({
      baseAmount: 2_440_000,
      subscriptionId: claude.subscription.id,
      href: `/subscriptions/${claude.subscription.id}`,
    });
    expect(of(jpy.commitment.id)[0]).toMatchObject({ baseAmount: null, currency: "JPY" });
    expect(upcoming.totals.unconverted).toEqual([expect.objectContaining({ currency: "JPY", amount: 1_000, direction: "out" })]);
    expect(upcoming.totals.overdueCount).toBe(1);
    expect(upcoming.groups.map((g) => g.date)).toEqual([...new Set(upcoming.items.map((i) => i.date))].sort());
    const convertible = upcoming.items.filter((i) => i.baseAmount !== null).reduce((sum, i) => sum + (i.baseAmount ?? 0), 0);
    expect(upcoming.totals.out).toBe(convertible);

    const rentCalendar = await calendar.calendar(user.personal, { from: T, to: addDays(T, 70), kind: ["rent"] });
    expect(rentCalendar.items.map((i) => i.date)).toEqual(dueDatesBetween({ frequency: "monthly", startDate: addDays(T, 5) }, T, addDays(T, 70)));
    await occurrences.payNext(user.personal, cleaner.id, { paidOn: addDays(T, 1) });
    const cleanerCalendar = await calendar.calendar(user.personal, { from: T, to: addDays(T, 14), kind: ["custom"] });
    expect(cleanerCalendar.items.map((i) => i.status)).toEqual(["paid", "scheduled"]);
    expect(cleanerCalendar.totals).toMatchObject({ paidOut: 100_000, out: 100_000 });

    const year = Number(T.slice(0, 4));
    const annual = await calendar.annual(user.personal, { year });
    const rentItem = annual.items.find((i) => i.commitmentId === rent.id);
    const rentDates = dueDatesBetween({ frequency: "monthly", startDate: addDays(T, 5) }, `${year}-01-01`, `${year}-12-31`);
    expect(rentItem).toMatchObject({
      annualized: 30_000_000,
      occurrencesInYear: rentDates.length,
      inYear: 2_500_000 * rentDates.length,
      monthlyEquivalent: 2_500_000,
    });
    expect(annual.byKind.find((k) => k.kind === "rent")).toMatchObject({ annualized: 30_000_000, count: 1 });
    expect(annual.byCategory.find((c) => c.categoryId === rentCategory)).toMatchObject({ categoryName: "Rent", annualized: 30_000_000 });
    expect(annual.unconverted).toEqual([expect.objectContaining({ commitmentId: jpy.commitment.id, currency: "JPY", annualized: 12_000 })]);
    expect(annual.totals.out.annualized).toBe(annual.byKind.reduce((sum, k) => sum + k.annualized, 0));
  });
});

describe("reminders", () => {
  const sentFor = (entityId: string) => db.select().from(notifications).where(eq(notifications.entityId, entityId)).orderBy(asc(notifications.createdAt));

  it("sends each reminder once per offset, with auto-renew and manual wording", async () => {
    const auto = await subscriptions.create(user.personal, {
      provider: "Anthropic",
      amount: 20_000,
      currency: "USD",
      billingCycle: "yearly",
      startDate: T,
      nextRenewalDate: addDays(T, 30),
      accountId: card,
      reminderOffsets: LONG_REMINDERS,
    });
    const manual = await subscriptions.create(user.personal, {
      provider: "Namecheap",
      planName: "Domain",
      amount: 1_500,
      currency: "USD",
      billingCycle: "yearly",
      startDate: T,
      nextRenewalDate: addDays(T, 7),
      expiryDate: addDays(T, 7),
      autoRenew: false,
      reminderOffsets: LONG_REMINDERS,
    });
    const deadline = await subscriptions.create(user.personal, {
      provider: "Gym",
      amount: 300_000,
      currency: "BDT",
      billingCycle: "monthly",
      startDate: T,
      nextRenewalDate: addDays(T, 10),
      cancellationDeadline: addDays(T, 3),
      reminderOffsets: LONG_REMINDERS,
    });

    const first = await reminders.scan(user.personal, T);
    const second = await reminders.scan(user.personal, T);
    expect(first.notifications).toBe(4);
    expect(second.notifications).toBe(0);

    const autoOccurrence = (await scheduledOf(auto.commitment.id))?.id;
    const [autoFirst] = await sentFor(auto.subscription.id);
    expect(autoFirst).toMatchObject({
      kind: "renewal",
      title: "Anthropic renews in 30 days",
      dedupeKey: `renewal:${autoOccurrence}:renewal:30`,
      link: `/subscriptions/${auto.subscription.id}`,
    });
    expect(autoFirst?.body).toContain("Expected renewal payment");

    const [manualFirst] = await sentFor(manual.subscription.id);
    expect(manualFirst?.body).toContain("Manual renewal required");

    const deadlineAlerts = await sentFor(deadline.subscription.id);
    expect(deadlineAlerts.map((n) => n.kind).sort()).toEqual(["cancellation_deadline", "renewal"]);
    expect(deadlineAlerts.find((n) => n.kind === "cancellation_deadline")).toMatchObject({
      title: "Cancellation deadline for Gym is in 3 days",
      severity: "critical",
    });

    for (const day of [23, 23, 29, 30, 30]) await reminders.scan(user.personal, addDays(T, day));
    const autoAll = await sentFor(auto.subscription.id);
    expect(autoAll.map((n) => n.dedupeKey.split(":").pop())).toEqual(["30", "7", "1", "0"]);
    expect(autoAll.map((n) => n.title)).toEqual([
      "Anthropic renews in 30 days",
      "Anthropic renews in 7 days",
      "Anthropic renewal is tomorrow",
      "Anthropic renewal is due today",
    ]);
    expect((await subscriptions.get(user.personal, auto.subscription.id)).status).toBe("renewal_due");
  });

  it("by default reminds two days before, the day before and on the day", async () => {
    const sub = await subscriptions.create(user.personal, monthly({ nextRenewalDate: addDays(T, 10), startDate: T }));
    for (let day = 0; day <= 10; day++) await reminders.scan(user.personal, addDays(T, day));
    const sent = (await sentFor(sub.subscription.id)).filter((n) => n.kind === "renewal");
    expect(sent.map((n) => n.title)).toEqual([
      "Netflix Standard renews in 2 days",
      "Netflix Standard renewal is tomorrow",
      "Netflix Standard renewal is due today",
    ]);
  });

  it("flags a payment that was due and never recorded, once", async () => {
    const internet = await commitmentsService.create(user.personal, {
      kind: "utility",
      name: "Internet",
      amount: 150_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: addDays(T, -2),
      nextDueDate: addDays(T, -2),
      accountId: bkash,
    });
    await reminders.scan(user.personal, T);
    await reminders.scan(user.personal, T);
    const sent = await sentFor(internet.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "unconfirmed", title: "Internet payment not recorded", link: `/commitments?focus=${internet.id}` });
    const items = await db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.workspaceId, user.personal.workspaceId), eq(inboxItems.kind, "renewal")));
    expect(items).toHaveLength(1);
    expect(items[0]?.data).toMatchObject({ commitmentId: internet.id, daysOverdue: 2 });

    await occurrences.payNext(user.personal, internet.id, { paidOn: T });
    const [resolved] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, items[0]?.id as string));
    expect(resolved?.status).toBe("resolved");
  });

  it("runs as a job fanned out per workspace by the scheduler", async () => {
    const rent = await commitmentsService.create(user.personal, {
      kind: "rent",
      name: "Rent",
      amount: 2_500_000,
      currency: "BDT",
      frequency: "monthly",
      startDate: addDays(T, 1),
      accountId: bkash,
    });
    const scheduler = await service(SchedulerService);
    const jobs = await service(JobsService);
    expect(scheduler.list().map((t) => t.name)).toEqual(expect.arrayContaining(["planning.reminders", "planning.budget_alerts"]));
    expect(jobs.registeredTypes()).toEqual(expect.arrayContaining([REMINDERS_JOB, "planning.budget_alerts"]));

    await scheduler.runTask(REMINDERS_JOB);
    await scheduler.runTask(REMINDERS_JOB);
    const queued = await db.execute<{ total: number }>(sql`select count(*)::int as total from job where type = ${REMINDERS_JOB}`);
    expect(queued.rows[0]?.total).toBe(2); // one per workspace, deduped within the hour
    await jobs.runDue(10);
    await scheduler.runTask(REMINDERS_JOB);
    await jobs.runDue(10);
    const sent = await db.select().from(notifications).where(like(notifications.dedupeKey, "renewal:%"));
    expect(sent.filter((n) => n.entityId === rent.id)).toHaveLength(1);
    expect(sent[0]?.title).toBe("Rent is due tomorrow");
  });
});

describe("workspace isolation", () => {
  it("keeps commitments, occurrences and subscriptions inside their workspace", async () => {
    const other = await createUser("Someone Else");
    const { subscription, commitment } = await subscriptions.create(user.personal, monthly());
    const due = (await scheduledOf(commitment.id))?.id as string;

    await expect(commitmentsService.detail(other.personal, commitment.id)).rejects.toThrow(/not found/);
    await expect(subscriptions.detail(other.personal, subscription.id)).rejects.toThrow(/not found/);
    await expect(subscriptions.detail(user.business, subscription.id)).rejects.toThrow(/not found/);
    await expect(occurrences.markPaid(other.personal, due, { paidOn: T, accountId: null })).rejects.toThrow(/not found/);
    await expect(occurrences.undo(other.personal, due)).rejects.toThrow(/not found/);
    await expect(subscriptions.cancel(other.personal, subscription.id)).rejects.toThrow(/not found/);
    await expect(
      commitmentsService.create(other.personal, {
        kind: "rent",
        name: "Rent",
        amount: 1,
        currency: "BDT",
        frequency: "monthly",
        startDate: T,
        accountId: bkash,
      }),
    ).rejects.toThrow(/not found in this workspace/);
    const { transaction } = await transactions.create(user.personal, { type: "expense", accountId: card, amount: 2_000, currency: "USD", date: T });
    const { commitment: theirs } = await subscriptions.create(other.personal, {
      provider: "X",
      amount: 2_000,
      currency: "USD",
      billingCycle: "monthly",
      startDate: T,
      nextRenewalDate: T,
    });
    const theirDue = (await scheduledOf(theirs.id))?.id as string;
    await expect(occurrences.markPaid(other.personal, theirDue, { paidOn: T, existingTransactionId: transaction.id })).rejects.toThrow(/not found/);
    await expect(
      subscriptions.create(other.personal, monthly({ accountId: null, categoryId: null }), { purchaseTransactionId: transaction.id }),
    ).rejects.toThrow(/not found/);

    expect((await commitmentsService.list(other.personal, {})).items.map((c) => c.id)).toEqual([theirs.id]);
    expect((await subscriptions.list(other.personal, {})).items).toHaveLength(1);
    expect((await calendar.upcoming(other.personal, {})).items.every((i) => i.commitmentId === theirs.id)).toBe(true);
    const leaked = await db.select().from(subscriptionTable).where(eq(subscriptionTable.workspaceId, other.personal.workspaceId));
    expect(leaked).toHaveLength(1);
  });
});
