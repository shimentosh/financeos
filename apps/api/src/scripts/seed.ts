import "reflect-metadata";
import "../load-env.js";

// Seeding runs the real services, so every ledger entry, audit record,
// renewal history and inbox item is exactly what the app itself would write.
process.env.EW_DISABLE_WORKER = "1";

import { addDays, addMonths, type Day, eachMonth, endOfMonth, startOfMonth, today } from "@expensewise/core";
import type { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { and, asc, eq } from "drizzle-orm";
import { auth } from "../auth/auth.js";
import { contextFor, type WorkspaceContext } from "../common/context.js";
import { db } from "../db/index.js";
import { categories, users, workspaceMembers, workspaces } from "../db/schema/index.js";

// A demo account with a published password has no place on a live service.
if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "1") {
  console.error("Refusing to seed demo data with NODE_ENV=production (set SEED_ALLOW_PRODUCTION=1 to override).");
  process.exit(1);
}

const EMAIL = process.env.SEED_EMAIL ?? "demo@expensewise.app";
const PASSWORD = process.env.SEED_PASSWORD ?? "demo-expense-wise";
const NAME = process.env.SEED_NAME ?? "Demo Founder";

/** Deterministic randomness: the same seed data every run. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20260926);
const between = (min: number, max: number) => Math.round(min + random() * (max - min));
const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)] as T;
const taka = (amount: number) => Math.round(amount * 100);
const usd = (amount: number) => Math.round(amount * 100);
const dayIn = (month: string, dayOfMonth: number, max: Day): Day | null => {
  const last = Number(endOfMonth(`${month}-01`).slice(8));
  const day = `${month}-${String(Math.min(dayOfMonth, last)).padStart(2, "0")}`;
  return day <= max ? day : null;
};

async function main() {
  const { AppModule } = await import("../app.module.js");
  const { TransactionsService } = await import("../modules/ledger/transactions.service.js");
  const { AccountsService } = await import("../modules/ledger/accounts.service.js");
  const { FxService } = await import("../modules/ledger/fx.service.js");
  const { ProjectsService, RulesService } = await import("../modules/ledger/catalog.service.js");
  const { SubscriptionsService } = await import("../modules/planning/subscriptions.service.js");
  const { CommitmentsService } = await import("../modules/planning/commitments.service.js");
  const { OccurrencesService } = await import("../modules/planning/occurrences.service.js");
  const { BudgetsService } = await import("../modules/planning/budgets.service.js");
  const { GoalsService } = await import("../modules/planning/goals.service.js");
  const { AssetsService } = await import("../modules/wealth/assets.service.js");
  const { InvestmentsService } = await import("../modules/wealth/investments.service.js");
  const { LiabilitiesService } = await import("../modules/wealth/liabilities.service.js");
  const { ReceivablesService } = await import("../modules/wealth/receivables.service.js");
  const { PayrollService } = await import("../modules/business/payroll.service.js");
  const { SchedulerService } = await import("../modules/jobs/scheduler.service.js");
  const { JobsService } = await import("../modules/system/jobs.service.js");
  const { EventsService } = await import("../modules/system/events.service.js");
  const { ReportsService } = await import("../modules/analytics/reports.service.js");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const get = <T>(type: Type<T>): T => app.get(type, { strict: false });
  const transactions = get(TransactionsService);
  const accounts = get(AccountsService);
  const fx = get(FxService);
  const projectsService = get(ProjectsService);
  const rules = get(RulesService);
  const subscriptions = get(SubscriptionsService);
  const commitments = get(CommitmentsService);
  const occurrences = get(OccurrencesService);
  const budgets = get(BudgetsService);
  const goals = get(GoalsService);
  const assets = get(AssetsService);
  const investments = get(InvestmentsService);
  const liabilities = get(LiabilitiesService);
  const receivables = get(ReceivablesService);
  const payroll = get(PayrollService);

  const [existing] = await db.select().from(users).where(eq(users.email, EMAIL));
  if (existing && !process.argv.includes("--reset")) {
    console.log(`${EMAIL} already exists — nothing to do. Run with --reset to replace the demo data.`);
    await app.close();
    return;
  }
  if (existing) {
    // Only the demo account and the workspaces it owns; cascades remove their data.
    const owned = await db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, existing.id), eq(workspaceMembers.role, "owner")));
    for (const row of owned) await db.delete(workspaces).where(eq(workspaces.id, row.id));
    await db.delete(users).where(eq(users.id, existing.id));
    console.log(`Removed the previous demo account (${owned.length} workspaces).`);
  }

  const started = Date.now();
  await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: NAME } });
  const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
  if (!user) throw new Error("Sign-up did not create the user");

  const memberships = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.id))
    .orderBy(asc(workspaces.createdAt));
  const personalRow = memberships.find((m) => m.workspace.kind === "personal")?.workspace;
  const businessRow = memberships.find((m) => m.workspace.kind === "business")?.workspace;
  if (!personalRow || !businessRow) throw new Error("Provisioning did not create both workspaces");
  await db.update(workspaces).set({ name: "Shimanto Labs" }).where(eq(workspaces.id, businessRow.id));
  const personal = contextFor(personalRow, { userId: user.id, actorType: "user", role: "owner" });
  const business = contextFor({ ...businessRow, name: "Shimanto Labs" }, { userId: user.id, actorType: "user", role: "owner" });

  const now = today(personal.timezone);
  const firstMonth = startOfMonth(addMonths(now, -11));
  const opening = addDays(firstMonth, -1);
  const months = eachMonth(firstMonth, now);

  // A dollar rate for every month (the defaults are a single January rate), so
  // USD balances and history convert at the rate of their own time.
  for (const ctx of [personal, business]) {
    for (const [index, date] of [opening, ...months.map((m) => `${m}-01`)].entries()) {
      await fx.upsert(ctx, { fromCurrency: "USD", toCurrency: "BDT", rate: (119.6 + index * 0.19).toFixed(2), date: date as Day });
    }
  }

  const categoryIds = async (ctx: WorkspaceContext) => {
    const rows = await db.select().from(categories).where(eq(categories.workspaceId, ctx.workspaceId));
    return (name: string) => {
      const row = rows.find((c) => c.name === name);
      if (!row) throw new Error(`No category ${name} in ${ctx.workspaceName}`);
      return row.id;
    };
  };

  let count = 0;
  const post = async (ctx: WorkspaceContext, input: Parameters<typeof transactions.create>[1], source?: "manual" | "screenshot" | "integration") => {
    const result = await transactions.create(ctx, input, { source });
    count++;
    return result.transaction;
  };

  // ------------------------------------------------------------------ personal
  console.log("Personal workspace…");
  const cat = await categoryIds(personal);
  const cash = (await accounts.list(personal)).find((a) => a.kind === "cash")?.id as string;
  await accounts.update(personal, cash, { openingBalance: taka(12_000), openingDate: opening });
  const brac = (
    await accounts.create(personal, {
      name: "BRAC Bank Savings",
      kind: "bank",
      provider: "bank",
      institution: "BRAC Bank",
      mask: "4410",
      currency: "BDT",
      openingBalance: taka(3_50_000),
      openingDate: opening,
    })
  ).id;
  const amex = (
    await accounts.create(personal, {
      name: "City Bank Amex",
      kind: "card",
      provider: "card",
      institution: "City Bank",
      mask: "1008",
      currency: "BDT",
      openingBalance: 0,
      openingDate: opening,
      creditLimit: taka(3_00_000),
      isLiability: true,
    })
  ).id;
  const bkash = (
    await accounts.create(personal, {
      name: "bKash",
      kind: "mobile_wallet",
      provider: "bkash",
      mask: "7712",
      currency: "BDT",
      openingBalance: taka(8_000),
      openingDate: opening,
    })
  ).id;
  await accounts.create(personal, {
    name: "Nagad",
    kind: "mobile_wallet",
    provider: "nagad",
    currency: "BDT",
    openingBalance: taka(2_000),
    openingDate: opening,
  });
  const wise = (
    await accounts.create(personal, {
      name: "Wise USD",
      kind: "digital_wallet",
      provider: "wise",
      currency: "USD",
      openingBalance: usd(1_200),
      openingDate: opening,
    })
  ).id;

  for (const [index, month] of months.entries()) {
    const d = (day: number) => dayIn(month, day, now);
    const salaryDay = d(1);
    if (salaryDay)
      await post(personal, {
        type: "income",
        accountId: brac,
        amount: taka(1_85_000),
        currency: "BDT",
        date: salaryDay,
        merchant: "Acme Software Ltd",
        categoryId: cat("Salary"),
        description: `Salary ${month}`,
      });
    if (index % 2 === 1 && d(12)) {
      await post(personal, {
        type: "income",
        accountId: wise,
        amount: usd(between(400, 950)),
        currency: "USD",
        date: d(12) as Day,
        merchant: "Upwork",
        categoryId: cat("Freelance"),
        description: "Freelance design work",
      });
    }
    if (index % 3 === 2 && d(15)) {
      const dollars = between(500, 900);
      await post(personal, {
        type: "transfer",
        accountId: wise,
        toAccountId: brac,
        amount: usd(dollars),
        currency: "USD",
        toAccountAmount: taka(dollars * 121.4),
        date: d(15) as Day,
        description: "Wise to BRAC",
      });
    }
    if (d(2))
      await post(personal, {
        type: "transfer",
        accountId: brac,
        toAccountId: bkash,
        amount: taka(50_000),
        currency: "BDT",
        date: d(2) as Day,
        description: "Top up bKash",
      });
    if (d(3))
      await post(personal, {
        type: "transfer",
        accountId: bkash,
        toAccountId: cash,
        amount: taka(8_000),
        currency: "BDT",
        date: d(3) as Day,
        description: "Cash out",
      });
    if (d(4))
      await post(personal, {
        type: "expense",
        accountId: bkash,
        amount: taka(15_000),
        currency: "BDT",
        date: d(4) as Day,
        merchant: "Ammu (bKash)",
        categoryId: cat("Family support"),
        description: "Monthly support for parents",
      });
    for (const [day, merchant, category, min, max, account] of [
      [7, "DESCO", "Electricity", 2_400, 4_600, bkash],
      [8, "Link3 Technologies", "Internet", 1_500, 1_500, bkash],
      [9, "Grameenphone", "Mobile", 799, 799, bkash],
      [10, "Titas Gas", "Gas", 1_080, 1_080, bkash],
      [6, "Sunbeam School", "Education", 8_000, 8_000, brac],
    ] as const) {
      const date = d(day);
      if (date)
        await post(personal, {
          type: "expense",
          accountId: account,
          amount: taka(between(min, max)),
          currency: "BDT",
          date,
          merchant,
          categoryId: cat(category),
        });
    }
    for (const week of [3, 10, 17, 24]) {
      const date = d(week + between(0, 2));
      if (date)
        await post(personal, {
          type: "expense",
          accountId: pick([amex, bkash]),
          amount: taka(between(2_500, 6_500)),
          currency: "BDT",
          date,
          merchant: pick(["Shwapno", "Meena Bazar", "Chaldal", "Unimart"]),
          categoryId: cat("Groceries"),
        });
    }
    for (let i = 0; i < between(4, 8); i++) {
      const date = d(between(1, 28));
      if (date)
        await post(personal, {
          type: "expense",
          accountId: pick([amex, bkash, cash]),
          amount: taka(between(600, 3_500)),
          currency: "BDT",
          date,
          merchant: pick(["Foodpanda", "Kacchi Bhai", "Sultan's Dine", "North End Coffee", "Takeout"]),
          categoryId: cat("Restaurants"),
        });
    }
    for (let i = 0; i < between(8, 14); i++) {
      const date = d(between(1, 28));
      if (date)
        await post(personal, {
          type: "expense",
          accountId: pick([bkash, cash]),
          amount: taka(between(150, 650)),
          currency: "BDT",
          date,
          merchant: pick(["Pathao", "Uber", "Obhai"]),
          categoryId: cat("Transport"),
        });
    }
    if (d(20))
      await post(personal, {
        type: "expense",
        accountId: amex,
        amount: taka(between(3_500, 5_000)),
        currency: "BDT",
        date: d(20) as Day,
        merchant: "Meghna Petroleum",
        categoryId: cat("Fuel"),
      });
    if (random() < 0.6 && d(18))
      await post(personal, {
        type: "expense",
        accountId: amex,
        amount: taka(between(2_000, 12_000)),
        currency: "BDT",
        date: d(18) as Day,
        merchant: pick(["Aarong", "Daraz", "Bata", "Yellow"]),
        categoryId: cat("Shopping"),
      });
    if (random() < 0.5 && d(22))
      await post(personal, {
        type: "expense",
        accountId: pick([bkash, cash]),
        amount: taka(between(500, 3_000)),
        currency: "BDT",
        date: d(22) as Day,
        merchant: "Lazz Pharma",
        categoryId: cat("Health"),
      });
    if (d(25) && index < months.length - 1)
      await post(personal, {
        type: "transfer",
        accountId: brac,
        toAccountId: amex,
        amount: taka(between(25_000, 40_000)),
        currency: "BDT",
        date: d(25) as Day,
        description: "Amex bill payment",
      });
  }
  // One-offs: a trip, zakat, a refund, a hospital visit, a big purchase.
  const trip = addMonths(now, -9);
  await post(personal, {
    type: "expense",
    accountId: amex,
    amount: taka(18_000),
    currency: "BDT",
    date: dayIn(trip.slice(0, 7), 14, now) as Day,
    merchant: "Sayeman Beach Resort",
    categoryId: cat("Travel"),
    description: "Cox's Bazar trip",
  });
  await post(personal, {
    type: "expense",
    accountId: amex,
    amount: taka(14_200),
    currency: "BDT",
    date: dayIn(trip.slice(0, 7), 12, now) as Day,
    merchant: "US-Bangla Airlines",
    categoryId: cat("Travel"),
    description: "Flights to Cox's Bazar",
  });
  await post(personal, {
    type: "expense",
    accountId: brac,
    amount: taka(25_000),
    currency: "BDT",
    date: dayIn(addMonths(now, -6).slice(0, 7), 20, now) as Day,
    merchant: "Zakat",
    categoryId: cat("Charity"),
  });
  const refunded = await post(personal, {
    type: "expense",
    accountId: amex,
    amount: taka(4_500),
    currency: "BDT",
    date: addDays(now, -20),
    merchant: "Daraz",
    categoryId: cat("Shopping"),
    description: "Headphones (returned)",
  });
  await post(personal, {
    type: "refund",
    direction: "in",
    accountId: amex,
    amount: taka(4_500),
    currency: "BDT",
    date: addDays(now, -12),
    merchant: "Daraz",
    categoryId: cat("Shopping"),
    linkedTransactionId: refunded.id,
    description: "Refund: headphones",
  });
  await post(personal, {
    type: "expense",
    accountId: brac,
    amount: taka(12_500),
    currency: "BDT",
    date: addDays(now, -40),
    merchant: "Square Hospital",
    categoryId: cat("Health"),
  });
  // A spending spike this month so anomaly detection has something real to find.
  await post(personal, {
    type: "expense",
    accountId: amex,
    amount: taka(38_000),
    currency: "BDT",
    date: addDays(now, -3),
    merchant: "Star Tech",
    categoryId: cat("Shopping"),
    description: "New monitor and keyboard",
  });
  // Drafts waiting in the AI Inbox, as if captured from screenshots.
  await transactions.create(
    personal,
    {
      type: "expense",
      status: "draft",
      accountId: bkash,
      amount: taka(1_250),
      currency: "BDT",
      date: addDays(now, -1),
      merchant: "Foodpanda",
      reference: "BKA7Q2M9XZ",
      description: "bKash payment",
    },
    {
      source: "screenshot",
      reviewReason: "Captured from a screenshot — check the category",
      aiConfidence: { overall: 0.82, fields: { amount: 0.99, date: 0.96, merchant: 0.91, category: 0.64 } },
    },
  );
  await transactions.create(
    personal,
    { type: "expense", status: "draft", accountId: amex, amount: taka(640), currency: "BDT", date: now, merchant: "Pathao", description: "Ride" },
    {
      source: "screenshot",
      reviewReason: "Captured from a screenshot",
      aiConfidence: { overall: 0.93, fields: { amount: 0.99, date: 0.98, merchant: 0.95, category: 0.88 } },
    },
  );

  // Subscriptions with real renewal history (prices change mid-year).
  const subscribe = async (
    ctx: WorkspaceContext,
    input: Parameters<typeof subscriptions.create>[1],
    payments: Array<{ on: Day; amount?: number; accountId: string; updateFutureAmount?: boolean }>,
  ) => {
    const { commitment } = await subscriptions.create(ctx, input);
    for (const payment of payments) {
      await occurrences.payNext(ctx, commitment.id, {
        paidOn: payment.on,
        amount: payment.amount,
        accountId: payment.accountId,
        updateFutureAmount: payment.updateFutureAmount,
        force: true,
      });
    }
    return commitment;
  };
  // The last `count` months up to and including this one; this month only once its day has passed.
  const monthlyDates = (day: number, count: number) =>
    Array.from({ length: count }, (_, i) => dayIn(addMonths(now, -(count - 1 - i)).slice(0, 7), day, now)).filter((x): x is Day => Boolean(x));
  const netflixDates = monthlyDates(14, 11);
  await subscribe(
    personal,
    {
      provider: "Netflix",
      planName: "Standard",
      amount: taka(950),
      currency: "BDT",
      billingCycle: "monthly",
      startDate: netflixDates[0] as Day,
      nextRenewalDate: netflixDates[0] as Day,
      accountId: amex,
      categoryId: cat("Subscriptions"),
    },
    // Netflix raised the price after six months: one real price change.
    netflixDates.map((on, i) => ({ on, amount: taka(i < 6 ? 950 : 1_100), accountId: amex, updateFutureAmount: i === 6 })),
  );
  const spotify = monthlyDates(3, 8);
  await subscribe(
    personal,
    {
      provider: "Spotify",
      planName: "Premium Individual",
      amount: taka(299),
      currency: "BDT",
      billingCycle: "monthly",
      startDate: spotify[0] as Day,
      nextRenewalDate: spotify[0] as Day,
      accountId: bkash,
      categoryId: cat("Subscriptions"),
    },
    spotify.map((on) => ({ on, accountId: bkash })),
  );
  const chatgpt = monthlyDates(19, 6);
  await subscribe(
    personal,
    {
      provider: "OpenAI",
      planName: "ChatGPT Plus",
      amount: usd(20),
      currency: "USD",
      billingCycle: "monthly",
      startDate: chatgpt[0] as Day,
      nextRenewalDate: chatgpt[0] as Day,
      accountId: amex,
      categoryId: cat("AI & APIs"),
    },
    chatgpt.map((on) => ({ on, accountId: amex })),
  );
  // The spec's example: Claude Pro annual, purchased a year ago, renewing today.
  const claudePurchase = addMonths(now, -12);
  await subscriptions.create(personal, {
    provider: "Anthropic",
    name: "Claude Pro",
    planName: "Annual plan",
    amount: usd(200),
    currency: "USD",
    billingCycle: "yearly",
    purchaseDate: claudePurchase,
    startDate: claudePurchase,
    expiryDate: now,
    nextRenewalDate: now,
    autoRenew: true,
    accountId: amex,
    categoryId: cat("AI & APIs"),
    recordPurchase: { accountId: amex, date: claudePurchase },
  });
  await subscriptions.create(personal, {
    provider: "Google",
    name: "Google One",
    planName: "2 TB annual",
    amount: taka(3_800),
    currency: "BDT",
    billingCycle: "yearly",
    purchaseDate: addDays(addMonths(now, -12), 12),
    startDate: addDays(addMonths(now, -12), 12),
    nextRenewalDate: addDays(now, 12),
    expiryDate: addDays(now, 12),
    cancellationDeadline: addDays(now, 5),
    autoRenew: false,
    accountId: amex,
    categoryId: cat("Subscriptions"),
    recordPurchase: { accountId: amex, date: addDays(addMonths(now, -12), 12) },
  });

  // Commitments: rent, school fees, insurance, expected salary.
  const rentStart = startOfMonth(addMonths(now, 1));
  await commitments.create(personal, {
    kind: "rent",
    name: "Flat rent",
    payee: "Mr. Karim (landlord)",
    amount: taka(35_000),
    currency: "BDT",
    frequency: "monthly",
    startDate: addDays(rentStart, 4),
    accountId: brac,
    categoryId: cat("Rent"),
  });
  await commitments.create(personal, {
    kind: "education",
    name: "School fees",
    payee: "Sunbeam School",
    amount: taka(8_000),
    currency: "BDT",
    frequency: "monthly",
    startDate: addDays(rentStart, 5),
    accountId: brac,
    categoryId: cat("Education"),
  });
  await commitments.create(personal, {
    kind: "insurance",
    name: "Car insurance",
    payee: "Green Delta",
    amount: taka(22_000),
    currency: "BDT",
    frequency: "yearly",
    startDate: addDays(now, 20),
    accountId: brac,
    categoryId: cat("Fees & Charges"),
  });
  await commitments.create(personal, {
    kind: "income",
    direction: "in",
    name: "Salary",
    payee: "Acme Software Ltd",
    amount: taka(1_85_000),
    currency: "BDT",
    frequency: "monthly",
    startDate: rentStart,
    accountId: brac,
    categoryId: cat("Salary"),
  });

  // Budgets.
  for (const [name, category, amount] of [
    ["Groceries", "Groceries", 22_000],
    ["Eating out", "Restaurants", 14_000],
    ["Getting around", "Transport", 9_500],
    ["Shopping", "Shopping", 10_000],
  ] as const) {
    await budgets.create(personal, { name, period: "monthly", amount: taka(amount), categoryId: cat(category), startDate: firstMonth });
  }
  await budgets.create(personal, { name: "Monthly spending", period: "monthly", amount: taka(1_30_000), startDate: firstMonth });

  // Wealth.
  await assets.create(personal, {
    name: "MacBook Pro 14 (M4)",
    kind: "electronics",
    purchasePrice: taka(3_20_000),
    currency: "BDT",
    purchaseDate: addMonths(now, -10),
    currentValue: taka(2_75_000),
    valuedAt: addDays(now, -30),
    owner: "Me",
  });
  await assets.create(personal, {
    name: "Toyota Axio 2016",
    kind: "vehicle",
    purchasePrice: taka(18_00_000),
    currency: "BDT",
    purchaseDate: "2022-03-10",
    currentValue: taka(14_50_000),
    valuedAt: addDays(now, -60),
    owner: "Me",
  });
  await assets.create(personal, {
    name: "Gold jewellery",
    kind: "jewelry",
    purchasePrice: taka(3_20_000),
    currency: "BDT",
    purchaseDate: "2021-12-01",
    currentValue: taka(4_60_000),
    valuedAt: addDays(now, -15),
    owner: "Family",
  });
  const sanchay = await investments.create(personal, {
    name: "Paribar Sanchayapatra",
    kind: "savings_certificate",
    institution: "Bangladesh Bank",
    currency: "BDT",
    openedOn: "2024-07-01",
    maturityDate: "2029-07-01",
    interestRate: "11.52",
    openingCostBasis: taka(5_00_000),
    currentValue: taka(5_00_000),
    valuedAt: addDays(now, -5),
  });
  const dse = await investments.create(personal, {
    name: "DSE portfolio",
    kind: "stock",
    institution: "LankaBangla Securities",
    currency: "BDT",
    openedOn: "2023-02-01",
    openingCostBasis: taka(2_00_000),
    currentValue: taka(2_36_500),
    valuedAt: addDays(now, -2),
  });
  const dps = await investments.create(personal, {
    name: "BRAC DPS",
    kind: "dps",
    institution: "BRAC Bank",
    currency: "BDT",
    openedOn: firstMonth,
    openingCostBasis: 0,
  });
  for (const month of months) {
    const date = dayIn(month, 11, now);
    if (date) await investments.recordFlow(personal, dps.id, { direction: "out", amount: taka(5_000), accountId: brac, date });
  }
  await investments.addValuation(personal, dps.id, { value: taka(5_000 * months.length + 1_850), date: addDays(now, -1) });
  // Month-end statements for every past month, so net worth history is complete.
  for (const [index, month] of months.slice(0, -1).entries()) {
    const monthEnd = endOfMonth(`${month}-01`);
    await investments.addValuation(personal, sanchay.id, { value: taka(5_00_000), date: monthEnd });
    await investments.addValuation(personal, dps.id, { value: taka(5_000 * (index + 1) + index * index * 15), date: monthEnd });
    await investments.addValuation(personal, dse.id, { value: taka(2_05_000 + Math.round((index / 10) * 28_000) + between(-4_000, 4_000)), date: monthEnd });
  }
  await liabilities.create(personal, {
    kind: "loan",
    name: "Car loan",
    counterpartyName: "IDLC Finance",
    principal: taka(10_00_000),
    currency: "BDT",
    openingOutstanding: taka(4_20_000),
    interestRate: "9.5",
    startDate: "2022-03-10",
    dueDate: "2027-03-10",
    schedule: { amount: taka(28_000), frequency: "monthly", firstDueDate: addDays(rentStart, 9), autoPay: true },
  });
  const brother = await liabilities.create(personal, {
    kind: "personal_debt",
    name: "Loan from Rafiq bhai",
    counterpartyName: "Rafiq (brother)",
    principal: taka(50_000),
    currency: "BDT",
    openingOutstanding: taka(50_000),
    startDate: addMonths(now, -4),
    dueDate: addDays(now, 45),
  });
  await liabilities.pay(personal, brother.id, { amount: taka(10_000), interest: 0, accountId: bkash, date: addDays(now, -25) });
  await receivables.create(personal, {
    kind: "loan",
    counterpartyName: "Rahim",
    title: "Lent to Rahim for his shop",
    amount: taka(30_000),
    currency: "BDT",
    issueDate: addDays(now, -50),
    dueDate: addDays(now, 14),
    lentFromAccountId: bkash,
  });
  const tanvir = await receivables.create(personal, {
    kind: "other",
    counterpartyName: "Tanvir",
    title: "Concert tickets I paid for",
    amount: taka(6_000),
    currency: "BDT",
    issueDate: addDays(now, -40),
    dueDate: addDays(now, -20),
  });
  await receivables.pay(personal, tanvir.id, { amount: taka(2_000), accountId: cash, date: addDays(now, -18) });

  // Goals and dream assets.
  const emergency = await goals.create(personal, {
    kind: "emergency_fund",
    name: "Emergency fund (6 months)",
    targetAmount: taka(6_00_000),
    currency: "BDT",
    targetDate: addMonths(now, 14),
    priority: "high",
    monthlyPlan: taka(20_000),
    startingAmount: taka(2_50_000),
  });
  for (const month of months.slice(-6)) {
    const date = dayIn(month, 2, now);
    if (date) await goals.addContribution(personal, emergency.id, { amount: taka(month === months.at(-2) ? 12_000 : 20_000), date });
  }
  const japan = await goals.create(personal, {
    kind: "travel",
    name: "Japan trip with family",
    targetAmount: taka(3_50_000),
    currency: "BDT",
    targetDate: addMonths(now, 7),
    priority: "medium",
    monthlyPlan: taka(25_000),
    startingAmount: taka(60_000),
  });
  await goals.addContribution(personal, japan.id, { amount: taka(25_000), date: addDays(now, -30) });
  await goals.create(personal, {
    kind: "dream_asset",
    name: "Toyota Premio 2021",
    targetAmount: taka(45_00_000),
    currency: "BDT",
    targetDate: addMonths(now, 30),
    priority: "high",
    monthlyPlan: taka(60_000),
    startingAmount: taka(9_00_000),
    notes: "Replace the Axio once the car loan is cleared.",
  });
  await goals.create(personal, {
    kind: "dream_asset",
    name: "Land in Purbachal",
    targetAmount: taka(1_20_00_000),
    currency: "BDT",
    targetDate: addMonths(now, 72),
    priority: "medium",
    startingAmount: taka(15_00_000),
  });
  await goals.create(personal, {
    kind: "education",
    name: "Kids' university fund",
    targetAmount: taka(25_00_000),
    currency: "BDT",
    targetDate: addMonths(now, 120),
    priority: "medium",
    monthlyPlan: taka(15_000),
    startingAmount: taka(3_20_000),
  });

  // Rules: known merchants never need a model.
  await rules.create(personal, {
    name: "Ride-hailing is transport",
    priority: 10,
    match: "any",
    conditions: [
      { field: "merchant", operator: "contains", value: "Pathao" },
      { field: "merchant", operator: "contains", value: "Uber" },
      { field: "merchant", operator: "contains", value: "Obhai" },
    ],
    actions: { categoryId: cat("Transport") },
  });
  await rules.create(personal, {
    name: "Foodpanda is eating out",
    priority: 20,
    match: "all",
    conditions: [{ field: "merchant", operator: "contains", value: "Foodpanda" }],
    actions: { categoryId: cat("Restaurants") },
  });
  await rules.create(personal, {
    name: "Large amounts need a look",
    priority: 90,
    match: "all",
    conditions: [{ field: "amount", operator: "gte", value: taka(50_000) }],
    actions: { requireReview: true },
  });

  // ------------------------------------------------------------------ business
  console.log("Business workspace…");
  const bcat = await categoryIds(business);
  const dbbl = (
    await accounts.create(business, {
      name: "DBBL Business",
      kind: "bank",
      provider: "bank",
      institution: "Dutch-Bangla Bank",
      mask: "2201",
      currency: "BDT",
      openingBalance: taka(12_00_000),
      openingDate: opening,
    })
  ).id;
  const stripe = (
    await accounts.create(business, {
      name: "Stripe",
      kind: "payment_processor",
      provider: "stripe",
      currency: "USD",
      openingBalance: usd(850),
      openingDate: opening,
    })
  ).id;
  const payoneer = (
    await accounts.create(business, {
      name: "Payoneer",
      kind: "digital_wallet",
      provider: "payoneer",
      currency: "USD",
      openingBalance: usd(2_400),
      openingDate: opening,
    })
  ).id;
  const petty = (await accounts.create(business, { name: "Petty cash", kind: "cash", currency: "BDT", openingBalance: taka(20_000), openingDate: opening })).id;

  const general = (await projectsService.list(business)).find((p) => p.isDefault)?.id as string;
  const clipmesh = (
    await projectsService.create(business, {
      name: "ClipMesh",
      code: "CLIP",
      color: "#2a78d6",
      budgetAmount: taka(25_00_000),
      startDate: firstMonth,
      description: "AI video clipping SaaS",
    })
  ).id;
  const teamos = (
    await projectsService.create(business, {
      name: "TeamOS",
      code: "TOS",
      color: "#eb6834",
      budgetAmount: taka(12_00_000),
      startDate: firstMonth,
      description: "Self-hosted project management",
    })
  ).id;
  const expensewise = (
    await projectsService.create(business, {
      name: "Expense Wise",
      code: "EW",
      color: "#10b981",
      budgetAmount: taka(6_00_000),
      startDate: addMonths(firstMonth, 6),
      description: "Financial operating system",
    })
  ).id;

  await post(business, {
    type: "equity",
    direction: "in",
    accountId: dbbl,
    amount: taka(5_00_000),
    currency: "BDT",
    date: firstMonth,
    description: "Owner capital",
    projectId: clipmesh,
  });

  const customers = ["Brightline Media", "Northwind Studio", "Pixel Forge", "Lumen Labs", "Orbit Creators"];
  for (const [index, month] of months.entries()) {
    const d = (day: number) => dayIn(month, day, now);
    // ClipMesh revenue grows; TeamOS is steadier.
    const clipCharges = 4 + Math.floor(index / 2);
    const chargeDays = new Set<number>();
    while (chargeDays.size < clipCharges) chargeDays.add(between(1, 28));
    for (const chargeDay of chargeDays) {
      const date = d(chargeDay);
      if (!date) continue;
      const gross = pick([29, 49, 99, 199]);
      const charge = `ch_${Math.floor(random() * 36 ** 8)
        .toString(36)
        .padStart(8, "0")}`;
      await post(business, {
        type: "income",
        accountId: stripe,
        amount: usd(gross),
        currency: "USD",
        date,
        merchant: pick(customers),
        reference: charge,
        categoryId: bcat("Subscription revenue"),
        projectId: clipmesh,
        description: "ClipMesh subscription",
      });
      await post(business, {
        type: "expense",
        accountId: stripe,
        amount: usd(Math.round((gross * 0.029 + 0.3) * 100) / 100),
        currency: "USD",
        date,
        merchant: "Stripe",
        reference: `fee_${charge.slice(3)}`,
        categoryId: bcat("Payment processing fees"),
        projectId: clipmesh,
        description: "Stripe fee",
      });
    }
    if (d(20))
      await post(business, {
        type: "income",
        accountId: stripe,
        amount: usd(between(300, 650)),
        currency: "USD",
        date: d(20) as Day,
        merchant: pick(customers),
        categoryId: bcat("Product sales"),
        projectId: teamos,
        description: "TeamOS self-hosted licence",
      });
    if (index % 2 === 0 && d(16))
      await post(business, {
        type: "income",
        accountId: payoneer,
        amount: usd(1_500),
        currency: "USD",
        date: d(16) as Day,
        merchant: "Northwind Studio",
        categoryId: bcat("Services"),
        projectId: teamos,
        description: "TeamOS setup & support",
      });
    if (d(27) && index < months.length - 1) {
      const dollars = between(600, 1_400);
      await post(business, {
        type: "transfer",
        accountId: stripe,
        toAccountId: dbbl,
        amount: usd(dollars),
        currency: "USD",
        toAccountAmount: taka(dollars * 121.1),
        date: d(27) as Day,
        description: "Stripe payout",
      });
    }
    for (const [day, merchant, category, min, max, account, project] of [
      [5, "OpenAI", "AI & APIs", 120, 420, payoneer, clipmesh],
      [6, "Anthropic", "AI & APIs", 80, 300, payoneer, index > 5 ? expensewise : clipmesh],
      [8, "Amazon Web Services", "Hosting", 90, 160, payoneer, clipmesh],
      [9, "Vercel", "Hosting", 20, 20, payoneer, teamos],
      [12, "GitHub", "Software", 21, 21, payoneer, general],
      [13, "Notion", "Software", 10, 10, payoneer, general],
    ] as const) {
      const date = d(day);
      if (date)
        await post(business, {
          type: "expense",
          accountId: account,
          amount: usd(between(min, max)),
          currency: "USD",
          date,
          merchant,
          categoryId: bcat(category),
          projectId: project,
        });
    }
    if (d(10))
      await post(business, {
        type: "expense",
        accountId: dbbl,
        amount: taka(between(18_000, 42_000)),
        currency: "BDT",
        date: d(10) as Day,
        merchant: "Meta Ads",
        categoryId: bcat("Advertising"),
        projectId: clipmesh,
        description: "ClipMesh campaigns",
      });
    if (d(3))
      await post(business, {
        type: "expense",
        accountId: dbbl,
        amount: taka(25_000),
        currency: "BDT",
        date: d(3) as Day,
        merchant: "Shanta Holdings",
        categoryId: bcat("Office"),
        projectId: general,
        description: "Office rent",
      });
    if (index % 3 === 1 && d(21))
      await post(business, {
        type: "expense",
        accountId: payoneer,
        amount: usd(between(250, 450)),
        currency: "USD",
        date: d(21) as Day,
        merchant: "Upwork – freelance designer",
        categoryId: bcat("Contractors"),
        projectId: pick([clipmesh, teamos]),
      });
    if (index % 3 === 2 && d(24))
      await post(business, {
        type: "expense",
        accountId: dbbl,
        amount: taka(10_000),
        currency: "BDT",
        date: d(24) as Day,
        merchant: "Hoque & Co. Accountants",
        categoryId: bcat("Accounting"),
        projectId: general,
      });
    if (random() < 0.5 && d(14))
      await post(business, {
        type: "expense",
        accountId: petty,
        amount: taka(between(800, 4_000)),
        currency: "BDT",
        date: d(14) as Day,
        merchant: pick(["Office snacks", "Courier", "Stationery"]),
        categoryId: bcat("Operations"),
        projectId: general,
      });
  }
  await post(business, {
    type: "expense",
    accountId: dbbl,
    amount: taka(15_000),
    currency: "BDT",
    date: addDays(now, -2),
    merchant: "Star Tech",
    categoryId: bcat("Equipment"),
    projectId: general,
    description: "Monitor for the office",
  });
  // An AI bill well above normal this month: a real anomaly.
  await post(business, {
    type: "expense",
    accountId: payoneer,
    amount: usd(980),
    currency: "USD",
    date: addDays(now, -4),
    merchant: "OpenAI",
    categoryId: bcat("AI & APIs"),
    projectId: clipmesh,
    description: "API usage spike (batch re-processing)",
  });

  // Payroll: three people, monthly runs for the last five months.
  const nadia = await payroll.createEmployee(business, {
    name: "Nadia Islam",
    title: "Senior engineer",
    salary: taka(1_20_000),
    currency: "BDT",
    payDay: 28,
    defaultProjectId: clipmesh,
    accountId: dbbl,
    startDate: firstMonth,
  });
  await payroll.createEmployee(business, {
    name: "Rafi Hasan",
    title: "Engineer",
    salary: taka(80_000),
    currency: "BDT",
    payDay: 28,
    defaultProjectId: teamos,
    accountId: dbbl,
    startDate: firstMonth,
  });
  await payroll.createEmployee(business, {
    name: "Mitu Akter",
    title: "Product designer",
    salary: taka(60_000),
    currency: "BDT",
    payDay: 28,
    defaultProjectId: expensewise,
    accountId: dbbl,
    startDate: firstMonth,
    createSalaryCommitment: true,
  });
  void nadia;
  for (const month of months.slice(-6, -1)) {
    const run = await payroll.createRun(business, { period: month, payDate: dayIn(month, 28, now) ?? endOfMonth(`${month}-01`) });
    await payroll.post(business, run.id);
  }

  // Business subscriptions and commitments. Figma is the spec's annual example.
  const figmaPurchase = addDays(addMonths(now, -12), 14);
  await subscriptions.create(business, {
    provider: "Figma",
    planName: "Professional annual",
    amount: usd(180),
    currency: "USD",
    billingCycle: "yearly",
    purchaseDate: figmaPurchase,
    startDate: figmaPurchase,
    expiryDate: addDays(now, 14),
    nextRenewalDate: addDays(now, 14),
    cancellationDeadline: addDays(now, 7),
    autoRenew: true,
    accountId: payoneer,
    categoryId: bcat("Software"),
    projectId: general,
    recordPurchase: { accountId: payoneer, date: figmaPurchase },
  });
  const claudeTeam = monthlyDates(2, 5);
  await subscribe(
    business,
    {
      provider: "Anthropic",
      name: "Claude Team",
      planName: "5 seats",
      amount: usd(150),
      currency: "USD",
      billingCycle: "monthly",
      startDate: claudeTeam[0] as Day,
      nextRenewalDate: claudeTeam[0] as Day,
      accountId: payoneer,
      categoryId: bcat("AI & APIs"),
      projectId: clipmesh,
    },
    claudeTeam.map((on) => ({ on, accountId: payoneer })),
  );
  await subscriptions.create(business, {
    provider: "Cloudflare",
    name: "clipmesh.com domain",
    amount: usd(10),
    currency: "USD",
    billingCycle: "yearly",
    startDate: addDays(now, 40),
    nextRenewalDate: addDays(now, 40),
    autoRenew: true,
    accountId: payoneer,
    categoryId: bcat("Hosting"),
    projectId: clipmesh,
  });
  await commitments.create(business, {
    kind: "rent",
    name: "Office rent",
    payee: "Shanta Holdings",
    amount: taka(25_000),
    currency: "BDT",
    frequency: "monthly",
    startDate: addDays(startOfMonth(addMonths(now, 1)), 2),
    accountId: dbbl,
    categoryId: bcat("Office"),
    projectId: general,
  });
  await commitments.create(business, {
    kind: "hosting",
    name: "AWS",
    payee: "Amazon Web Services",
    amount: usd(140),
    currency: "USD",
    frequency: "monthly",
    startDate: addDays(startOfMonth(addMonths(now, 1)), 7),
    accountId: payoneer,
    categoryId: bcat("Hosting"),
    projectId: clipmesh,
    autoPay: true,
  });

  await budgets.create(business, {
    name: "ClipMesh AI spend",
    period: "monthly",
    amount: taka(1_00_000),
    categoryId: bcat("AI & APIs"),
    projectId: clipmesh,
    startDate: firstMonth,
  });
  await budgets.create(business, { name: "Advertising", period: "monthly", amount: taka(50_000), categoryId: bcat("Advertising"), startDate: firstMonth });

  await receivables.create(business, {
    kind: "invoice",
    counterpartyName: "Brightline Media",
    title: "TeamOS rollout — phase 2",
    reference: "INV-2026-041",
    amount: usd(2_500),
    currency: "USD",
    issueDate: addDays(now, -10),
    dueDate: addDays(now, 10),
    projectId: teamos,
    categoryId: bcat("Services"),
  });
  await receivables.create(business, {
    kind: "invoice",
    counterpartyName: "Pixel Forge",
    title: "ClipMesh annual enterprise plan",
    reference: "INV-2026-037",
    amount: usd(1_200),
    currency: "USD",
    issueDate: addDays(now, -50),
    dueDate: addDays(now, -20),
    projectId: clipmesh,
    categoryId: bcat("Subscription revenue"),
  });
  await liabilities.create(business, {
    kind: "payable",
    name: "Brand identity work",
    counterpartyName: "Studio Dhoni",
    principal: taka(45_000),
    currency: "BDT",
    openingOutstanding: taka(45_000),
    dueDate: addDays(now, 7),
    categoryId: bcat("Contractors"),
    projectId: expensewise,
  });
  await liabilities.create(business, {
    kind: "business_debt",
    name: "SME working-capital loan",
    counterpartyName: "BRAC Bank SME",
    principal: taka(20_00_000),
    currency: "BDT",
    openingOutstanding: taka(12_00_000),
    interestRate: "11",
    startDate: "2024-01-15",
    dueDate: "2028-01-15",
    schedule: { amount: taka(55_000), frequency: "monthly", firstDueDate: addDays(startOfMonth(addMonths(now, 1)), 14), autoPay: true },
  });
  await assets.create(business, {
    name: "Team laptops (3)",
    kind: "electronics",
    purchasePrice: taka(6_00_000),
    currency: "BDT",
    purchaseDate: addMonths(now, -8),
    currentValue: taka(4_80_000),
    valuedAt: addDays(now, -30),
    owner: "Company",
  });
  await rules.create(business, {
    name: "OpenAI and Anthropic are AI & APIs",
    priority: 10,
    match: "any",
    conditions: [
      { field: "merchant", operator: "contains", value: "OpenAI" },
      { field: "merchant", operator: "contains", value: "Anthropic" },
    ],
    actions: { categoryId: bcat("AI & APIs") },
  });

  // ------------------------------------------------ background jobs, once
  console.log("Running detection jobs…");
  const scheduler = get(SchedulerService);
  const jobs = get(JobsService);
  const events = get(EventsService);
  for (const task of scheduler.list()) {
    if (task.name === "system.prune" || task.name.startsWith("reports.") || task.name.startsWith("integrations.")) continue;
    await scheduler.runTask(task.name);
  }
  for (let round = 0; round < 50; round++) {
    const ran = (await events.dispatchPending(200)) + (await jobs.runDue(10));
    if (!ran) break;
  }
  const reports = get(ReportsService);
  await reports.generate(personal, { kind: "monthly", withNarrative: true });
  await reports.generate(business, { kind: "monthly", withNarrative: true });

  console.log(`Seeded ${count} transactions in ${Math.round((Date.now() - started) / 1000)}s.`);
  console.log(`Sign in at ${process.env.APP_URL ?? "http://localhost:3100"} with ${EMAIL} / ${PASSWORD}`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
