import { addDays, type Day } from "@expensewise/core";
import { z } from "zod";
import { between, compactDay, pageOf, pick, random, revealedDays, seedFrom, simulationClock } from "./simulation.js";
import { defineConnector, type RawRecord } from "./types.js";

/**
 * A sandbox bank + mobile-wallet feed with a Dhaka household's money:
 * salary, rent, utilities, groceries, ride-hailing, food delivery and bKash
 * transfers. Deterministic per connection; each sync after the first moves a
 * simulated clock forward and reveals the newer transactions.
 */

export const DEMO_BANK = {
  currency: "BDT",
  openingBalance: 4_500_000,
  historyDays: 104,
  initialLagDays: 7,
  stepDays: 3,
  pageSize: 50,
} as const;

export type DemoBankTransaction = {
  id: string;
  date: Day;
  occurredAt: string;
  type: "income" | "expense";
  amount: number;
  description: string;
  merchant: string;
  category: string;
  reference: string;
  channel: "card" | "bkash" | "bank_transfer" | "direct_debit";
};

const GROCERS = ["Shwapno", "Meena Bazar", "Agora", "Unimart", "Khulshi Mart"] as const;
const RIDES = [
  { merchant: "Pathao", label: "PATHAO RIDE" },
  { merchant: "Uber", label: "UBER *TRIP DHAKA" },
  { merchant: "Obhai", label: "OBHAI RIDE" },
] as const;
const FOOD = ["Foodpanda", "Pathao Food"] as const;
const AREAS = ["GULSHAN-2", "DHANMONDI", "BANANI", "MIRPUR-10", "UTTARA"] as const;

function trxId(rng: () => number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 10; i++) id += alphabet[Math.floor(rng() * alphabet.length)];
  return id;
}

/** The transactions on one day of the feed, in time order. Stable for a seed and day. */
export function demoBankDay(seed: string, day: Day): DemoBankTransaction[] {
  const rng = random(seedFrom(`${seed}:${day}`));
  const dom = Number(day.slice(8, 10));
  const month = day.slice(0, 7);
  type Draft = Omit<DemoBankTransaction, "id" | "occurredAt" | "date" | "reference"> & { hour: number; reference?: string };
  const out: Array<Draft & { reference: string }> = [];
  const add = (entry: Draft) => out.push({ ...entry, reference: entry.reference ?? `POS${between(rng, 100000, 999999)}` });

  if (dom === 1) {
    add({
      type: "income",
      amount: 8_500_000,
      description: `ACME TECH LTD SALARY ${month}`,
      merchant: "Acme Tech Ltd",
      category: "Salary",
      channel: "bank_transfer",
      hour: 10,
      reference: `SAL${compactDay(day)}`,
    });
  }
  if (dom === 3) {
    add({
      type: "expense",
      amount: 2_500_000,
      description: "BEFTN HOUSE RENT DHANMONDI",
      merchant: "Landlord (Dhanmondi flat)",
      category: "Rent",
      channel: "bank_transfer",
      hour: 11,
      reference: `RENT${compactDay(day)}`,
    });
  }
  if (dom === 2 || dom === 16) {
    add({
      type: "expense",
      amount: 500_000,
      description: "bKash SEND MONEY 017XXXXX421",
      merchant: "Ammu (bKash)",
      category: "Family support",
      channel: "bkash",
      hour: 20,
      reference: trxId(rng),
    });
  }
  if (dom === 7) {
    add({
      type: "expense",
      amount: between(rng, 10, 25) * 10_000,
      description: "DESCO PREPAID RECHARGE VIA bKash",
      merchant: "DESCO",
      category: "Electricity",
      channel: "bkash",
      hour: 9,
      reference: trxId(rng),
    });
  }
  if (dom === 12) {
    add({
      type: "expense",
      amount: 150_000,
      description: "LINK3 TECHNOLOGIES INTERNET BILL",
      merchant: "Link3",
      category: "Internet",
      channel: "direct_debit",
      hour: 8,
    });
  }
  if (dom === 18) {
    add({
      type: "expense",
      amount: 108_000,
      description: "TITAS GAS BILL PAYMENT",
      merchant: "Titas Gas",
      category: "Gas",
      channel: "bkash",
      hour: 12,
      reference: trxId(rng),
    });
  }
  if (dom === 22) {
    add({
      type: "expense",
      amount: 65_000,
      description: "DHAKA WASA WATER BILL",
      merchant: "Dhaka WASA",
      category: "Water",
      channel: "bkash",
      hour: 12,
      reference: trxId(rng),
    });
  }
  if (dom === 20 && rng() < 0.6) {
    add({
      type: "income",
      amount: between(rng, 250, 600) * 10_000,
      description: "PAYONEER TRANSFER UPWORK EARNINGS",
      merchant: "Upwork",
      category: "Freelance",
      channel: "bank_transfer",
      hour: 15,
      reference: `PYN${between(rng, 1000000, 9999999)}`,
    });
  }
  if (rng() < 0.15) {
    add({
      type: "expense",
      amount: pick(rng, [19_900, 29_900, 49_900, 79_900]),
      description: "GRAMEENPHONE RECHARGE",
      merchant: "Grameenphone",
      category: "Mobile",
      channel: "bkash",
      hour: 21,
      reference: trxId(rng),
    });
  }
  if (rng() < 0.4) {
    const grocer = pick(rng, GROCERS);
    add({
      type: "expense",
      amount: between(rng, 65, 480) * 1_000,
      description: `POS PURCHASE ${grocer.toUpperCase()} ${pick(rng, AREAS)}`,
      merchant: grocer,
      category: "Groceries",
      channel: "card",
      hour: 18,
    });
  }
  const rides = rng() < 0.65 ? (rng() < 0.3 ? 2 : 1) : 0;
  for (let i = 0; i < rides; i++) {
    const ride = pick(rng, RIDES);
    add({
      type: "expense",
      amount: between(rng, 12, 65) * 1_000,
      description: ride.label,
      merchant: ride.merchant,
      category: "Transport",
      channel: "bkash",
      hour: i === 0 ? 8 : 19,
      reference: trxId(rng),
    });
  }
  if (rng() < 0.25) {
    const food = pick(rng, FOOD);
    add({
      type: "expense",
      amount: between(rng, 28, 145) * 1_000,
      description: `${food.toUpperCase()} ORDER`,
      merchant: food,
      category: "Restaurants",
      channel: "card",
      hour: 21,
    });
  }
  if (rng() < 0.06) {
    add({
      type: "expense",
      amount: between(rng, 30, 220) * 1_000,
      description: "LAZZ PHARMA POS",
      merchant: "Lazz Pharma",
      category: "Health",
      channel: "card",
      hour: 17,
    });
  }
  if (rng() < 0.05) {
    add({
      type: "expense",
      amount: between(rng, 90, 650) * 1_000,
      description: "DARAZ BANGLADESH ONLINE",
      merchant: "Daraz",
      category: "Shopping",
      channel: "card",
      hour: 14,
    });
  }
  if (dom === 28 && ["03", "06", "09", "12"].includes(day.slice(5, 7))) {
    add({
      type: "expense",
      amount: 23_000,
      description: "ACCOUNT MAINTENANCE FEE",
      merchant: "Demo Bank",
      category: "Fees & Charges",
      channel: "direct_debit",
      hour: 23,
      reference: `FEE${compactDay(day)}`,
    });
  }
  // Dhaka commutes: every day has at least one ride.
  if (!out.length) {
    add({
      type: "expense",
      amount: between(rng, 12, 45) * 1_000,
      description: "PATHAO RIDE",
      merchant: "Pathao",
      category: "Transport",
      channel: "bkash",
      hour: 9,
      reference: trxId(rng),
    });
  }

  return out
    .sort((a, b) => a.hour - b.hour)
    .map((entry, index) => {
      const minute = String((index * 17 + 5) % 60).padStart(2, "0");
      const { hour, ...rest } = entry;
      return {
        ...rest,
        date: day,
        id: `DB-${compactDay(day)}-${String(index + 1).padStart(2, "0")}`,
        occurredAt: `${day}T${String(hour).padStart(2, "0")}:${minute}:00+06:00`,
      };
    });
}

/** Every transaction dated in [from, to]. */
export function demoBankRange(seed: string, from: Day, to: Day): DemoBankTransaction[] {
  const all: DemoBankTransaction[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) all.push(...demoBankDay(seed, day));
  return all;
}

const noCredentials = z
  .object({})
  .loose()
  .transform(() => ({}) as Record<string, string>);
const config = z.object({}).loose();

export const demoBankConnector = defineConnector<Record<string, unknown>, Record<string, string>>({
  id: "demo_bank",
  displayName: "Demo Bank & bKash",
  category: "banking",
  description:
    "A sandbox bank and mobile-wallet feed with three months of realistic Dhaka household transactions. Every sync reveals a few newer days, so you can watch incremental sync, rules and duplicate detection at work.",
  icon: "landmark",
  capabilities: { sync: true, webhook: false, import: false, testConnection: true },
  credentialFields: [],
  configFields: [],
  credentialsSchema: noCredentials,
  configSchema: config,
  requiresAccount: true,
  defaultSyncFrequency: "daily",

  async validate() {
    return { ok: true, message: "The demo feed is ready: no credentials needed." };
  },

  suggestAccount({ today }) {
    // Opening balance on the day before the feed starts: once every record is
    // posted, the books match the balance the bank reports.
    return {
      name: "Demo Bank",
      kind: "bank",
      currency: DEMO_BANK.currency,
      provider: "demo_bank",
      openingBalance: DEMO_BANK.openingBalance,
      openingDate: addDays(today, -DEMO_BANK.historyDays - 1),
    };
  },

  async fetch(ctx, params) {
    const clock = simulationClock({
      cursor: params.cursor,
      createdAt: ctx.connection.createdAt,
      now: ctx.now,
      timeZone: ctx.connection.timezone,
      historyDays: DEMO_BANK.historyDays,
      initialLagDays: DEMO_BANK.initialLagDays,
      stepDays: DEMO_BANK.stepDays,
    });
    const days = revealedDays(clock);
    const items = days.flatMap((day) => demoBankDay(ctx.connection.id, day));
    const { page, nextCursor, hasMore } = pageOf(items, clock, DEMO_BANK.pageSize);
    const records: RawRecord[] = page.map((item) => ({ ...item, object: "transaction" }));
    if (!hasMore) {
      // The balance the "bank" reports, for reconciliation on the sync run.
      const asOf = clock.target > clock.through ? clock.target : clock.through;
      const history = asOf >= clock.start ? demoBankRange(ctx.connection.id, clock.start, asOf) : [];
      const balance = history.reduce<number>((sum, t) => sum + (t.type === "income" ? t.amount : -t.amount), DEMO_BANK.openingBalance);
      records.push({ object: "balance", balance, currency: DEMO_BANK.currency, asOf });
    }
    return { records, nextCursor, hasMore };
  },

  normalize(raw) {
    if (raw.object === "balance") {
      return { kind: "balance", balance: raw.balance as number, currency: raw.currency as string, asOf: raw.asOf as string };
    }
    const item = raw as unknown as DemoBankTransaction;
    return {
      kind: "transaction",
      externalId: item.id,
      type: item.type,
      direction: item.type === "income" ? "in" : "out",
      amount: item.amount,
      currency: DEMO_BANK.currency,
      date: item.date,
      occurredAt: item.occurredAt,
      description: item.description,
      counterparty: item.merchant,
      categoryHint: item.category,
      reference: item.reference,
      metadata: { channel: item.channel },
    };
  },
});
