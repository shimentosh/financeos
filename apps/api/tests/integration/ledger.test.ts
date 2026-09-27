import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { auditLogs, categories, ledgerEntries } from "../../src/db/schema/index.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { asSystem, createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let transactions: TransactionsService;
let accounts: AccountsService;
let user: TestUser;
let bkash: string;
let card: string;
let groceries: string;
let salary: string;

beforeAll(async () => {
  transactions = await service(TransactionsService);
  accounts = await service(AccountsService);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Ayesha Rahman");
  bkash = (
    await accounts.create(user.personal, { name: "bKash", kind: "mobile_wallet", currency: "BDT", openingBalance: 5_000_000, openingDate: "2026-09-01" })
  ).id;
  card = (await accounts.create(user.personal, { name: "USD Card", kind: "card", currency: "USD", openingBalance: 0, openingDate: "2026-09-01" })).id;
  const cats = await db.select().from(categories).where(eq(categories.workspaceId, user.personal.workspaceId));
  groceries = cats.find((c) => c.name === "Groceries")?.id as string;
  salary = cats.find((c) => c.name === "Salary")?.id as string;
});

const balanceOf = async (id: string) => (await accounts.list(user.personal)).find((a) => a.id === id)?.balance;

describe("posting", () => {
  it("writes one signed ledger entry per account and moves the balance", async () => {
    const { transaction } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 150_000,
      currency: "BDT",
      date: "2026-09-10",
      merchant: "Shwapno",
      categoryId: groceries,
    });
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, transaction.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ accountId: bkash, amount: -150_000, baseAmount: -150_000 });
    expect(await balanceOf(bkash)).toBe(4_850_000);
    expect(transaction.counterpartyId).toBeTruthy();
  });

  it("keeps transfers out of income and spending", async () => {
    const cash = (await accounts.list(user.personal)).find((a) => a.name === "Cash")?.id as string;
    await transactions.create(user.personal, { type: "transfer", accountId: bkash, toAccountId: cash, amount: 1_000_000, currency: "BDT", date: "2026-09-10" });
    await transactions.create(user.personal, { type: "income", accountId: bkash, amount: 20_000_000, currency: "BDT", date: "2026-09-01", categoryId: salary });
    const list = await transactions.list(user.personal, {});
    expect(list.totals).toMatchObject({ income: 20_000_000, expense: 0 });
    expect(await balanceOf(cash)).toBe(1_000_000);
    expect(await balanceOf(bkash)).toBe(5_000_000 - 1_000_000 + 20_000_000);
  });

  it("converts foreign amounts through the account currency and the base rate", async () => {
    const { transaction } = await transactions.create(user.personal, {
      type: "expense",
      accountId: card,
      amount: 2_000,
      currency: "USD",
      date: "2026-09-12",
      merchant: "Claude.ai",
    });
    expect(transaction).toMatchObject({ accountAmount: 2_000, baseAmount: 244_000, fxRate: "122.0000000000", baseCurrency: "BDT" });
    // A BDT account charged for a USD purchase records what it was charged.
    const { transaction: charged } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 2_000,
      currency: "USD",
      accountAmount: 250_000,
      date: "2026-09-12",
    });
    expect(charged).toMatchObject({ accountAmount: 250_000, baseAmount: 250_000, fxRate: "125.0000000000" });
  });

  it("refuses an expense category on income and a direction the type cannot have", async () => {
    await expect(
      transactions.create(user.personal, { type: "income", accountId: bkash, amount: 100, currency: "BDT", date: "2026-09-12", categoryId: groceries }),
    ).rejects.toThrow(/expense category/);
    await expect(
      transactions.create(user.personal, { type: "expense", direction: "in", accountId: bkash, amount: 100, currency: "BDT", date: "2026-09-12" }),
    ).rejects.toThrow(/cannot be money in/);
  });

  it("stores drafts without touching balances until they are confirmed", async () => {
    const { transaction } = await transactions.create(user.personal, {
      type: "expense",
      status: "draft",
      accountId: bkash,
      amount: 99_900,
      currency: "BDT",
      date: "2026-09-12",
    });
    expect(await balanceOf(bkash)).toBe(5_000_000);
    await transactions.confirm(user.personal, transaction.id, { categoryId: groceries });
    expect(await balanceOf(bkash)).toBe(4_900_100);
    const history = await db.select().from(auditLogs).where(eq(auditLogs.entityId, transaction.id));
    expect(history.map((h) => h.action)).toEqual(["transaction.created", "transaction.confirmed"]);
  });

  it("recomputes entries on edit and removes them on void", async () => {
    const { transaction } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 100_000,
      currency: "BDT",
      date: "2026-09-12",
    });
    await transactions.update(user.personal, transaction.id, { amount: 300_000 });
    expect(await balanceOf(bkash)).toBe(4_700_000);
    await transactions.void(user.personal, transaction.id, "Entered twice");
    expect(await balanceOf(bkash)).toBe(5_000_000);
    const [actions] = [await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.entityId, transaction.id))];
    expect(actions.map((a) => a.action)).toContain("transaction.amount_changed");
    expect(actions.map((a) => a.action)).toContain("transaction.deleted");
  });
});

describe("idempotency and duplicates", () => {
  it("imports the same external record once, even after it was voided", async () => {
    const system = asSystem(user.personal, "integration");
    const input = { type: "expense" as const, accountId: bkash, amount: 50_000, currency: "BDT", date: "2026-09-12", merchant: "Foodpanda" };
    const first = await transactions.create(system, input, { source: "integration", externalId: "fp_123", connectionId: null });
    const again = await transactions.create(system, input, { source: "integration", externalId: "fp_123", connectionId: null });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, transaction: { id: first.transaction.id } });
    await transactions.void(user.personal, first.transaction.id);
    const afterVoid = await transactions.create(system, input, { source: "integration", externalId: "fp_123", connectionId: null });
    expect(afterVoid.duplicate).toBe(true);
  });

  it("finds a manually entered copy of an imported payment", async () => {
    const { transaction: manual } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 120_000,
      currency: "BDT",
      date: "2026-09-12",
      merchant: "Pathao",
      reference: "BKA123XYZ9",
    });
    const matches = await transactions.findDuplicates(user.personal, { date: "2026-09-13", amount: 999, currency: "BDT", reference: "BKA123XYZ9" });
    expect(matches[0]).toMatchObject({ id: manual.id, exact: true });
  });
});

describe("workspace isolation", () => {
  it("never lets one workspace use or read another's records", async () => {
    const other = await createUser("Someone Else");
    const { transaction } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 10_000,
      currency: "BDT",
      date: "2026-09-12",
    });

    await expect(transactions.get(other.personal, transaction.id)).rejects.toThrow(/not found/);
    await expect(
      transactions.create(other.personal, { type: "expense", accountId: bkash, amount: 10_000, currency: "BDT", date: "2026-09-12" }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(
      transactions.create(user.business, { type: "expense", accountId: bkash, amount: 10_000, currency: "BDT", date: "2026-09-12" }),
    ).rejects.toThrow(/not found in this workspace/);
    expect((await transactions.list(other.personal, {})).total).toBe(0);
    const leaked = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.workspaceId, other.personal.workspaceId)));
    expect(leaked).toHaveLength(0);
  });
});

describe("reconciliation", () => {
  it("reports the difference and can post an adjustment", async () => {
    await transactions.create(user.personal, { type: "expense", accountId: bkash, amount: 100_000, currency: "BDT", date: "2026-09-12" });
    const result = await accounts.reconcile(
      user.personal,
      bkash,
      { statementBalance: 4_880_000, asOf: "2026-09-20", adjust: true },
      async (amount, direction) => {
        const { transaction } = await transactions.create(user.personal, {
          type: "adjustment",
          direction,
          accountId: bkash,
          amount,
          currency: "BDT",
          date: "2026-09-20",
        });
        return transaction.id;
      },
    );
    expect(result).toMatchObject({ bookBalance: 4_900_000, difference: -20_000, reconciled: true });
    expect(await balanceOf(bkash)).toBe(4_880_000);
  });
});
