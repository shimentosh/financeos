import { addDays, type Day } from "@expensewise/core";
import type { CanonicalRecordInput } from "@expensewise/core/contracts/integrations-extra";
import { z } from "zod";
import { randomBase62 } from "../crypto.js";
import { signTimestampedHeader, verifyTimestampedHeader } from "./signatures.js";
import { between, compactDay, pageOf, pick, random, revealedDays, seedFrom, simulationClock } from "./simulation.js";
import { ConnectorError, defineConnector, type RawRecord } from "./types.js";

/**
 * A Stripe-like sandbox for a business: charges (gross revenue with the
 * customer and product), processing fees, refunds and weekly payouts, plus
 * signed webhooks. Nothing leaves the server; the data is deterministic per
 * connection.
 */

export const DEMO_PAYMENTS = {
  historyDays: 90,
  initialLagDays: 3,
  stepDays: 2,
  pageSize: 50,
  signatureHeader: "x-demo-signature",
} as const;

const CURRENCY_SCALE: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, BDT: 120 };

const PRODUCTS = [
  { name: "Pro plan (monthly)", price: 2_900, category: "Subscription revenue", weight: 5 },
  { name: "Team plan (monthly)", price: 9_900, category: "Subscription revenue", weight: 3 },
  { name: "Pro plan (annual)", price: 29_000, category: "Subscription revenue", weight: 1 },
  { name: "Onboarding service", price: 49_900, category: "Services", weight: 1 },
] as const;
const WEIGHTED_PRODUCTS = PRODUCTS.flatMap((product) => Array.from({ length: product.weight }, () => product));

const CUSTOMERS = [
  { name: "Nimbus Labs", email: "billing@nimbuslabs.io" },
  { name: "Brightline Studio", email: "accounts@brightline.studio" },
  { name: "Karim & Co", email: "finance@karimco.com.bd" },
  { name: "Dhaka Digital", email: "ops@dhakadigital.com" },
  { name: "Pixelwave", email: "hello@pixelwave.app" },
  { name: "Riverstone Ltd", email: "ap@riverstone.co.uk" },
  { name: "Northwind Traders", email: "payables@northwind.example" },
  { name: "Bluebird Apps", email: "team@bluebird.dev" },
] as const;

export type DemoCharge = {
  object: "charge";
  id: string;
  amount: number;
  fee: number;
  currency: string;
  created: number;
  customer: { name: string; email: string };
  description: string;
  product: string;
  category: string;
};
export type DemoRefund = {
  object: "refund";
  id: string;
  amount: number;
  currency: string;
  created: number;
  charge: string;
  customer: { name: string; email: string };
  category: string;
};
export type DemoPayout = { object: "payout"; id: string; amount: number; currency: string; created: number; arrival_date: number; status: "paid" };
export type DemoEvent = DemoCharge | DemoRefund | DemoPayout;

function unix(day: Day, hour: number, minute = 0): number {
  return Math.floor(Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) / 1000);
}

function feeFor(amount: number, currency: string): number {
  const fixed = Math.round(30 * (CURRENCY_SCALE[currency] ?? 1));
  return Math.round(amount * 0.029) + fixed;
}

function chargesOn(seed: string, day: Day, currency: string): DemoCharge[] {
  const rng = random(seedFrom(`${seed}:charges:${day}`));
  const scale = CURRENCY_SCALE[currency] ?? 1;
  const count = 2 + Math.floor(rng() * 4);
  const tag = seedFrom(seed).toString(36).slice(0, 6);
  return Array.from({ length: count }, (_, index) => {
    const product = pick(rng, WEIGHTED_PRODUCTS);
    const customer = pick(rng, CUSTOMERS);
    const amount = Math.round(product.price * scale);
    return {
      object: "charge" as const,
      id: `ch_${tag}${compactDay(day)}${String(index + 1).padStart(2, "0")}`,
      amount,
      fee: feeFor(amount, currency),
      currency: currency.toLowerCase(),
      created: unix(day, 3 + index * 3, between(rng, 0, 59)),
      customer: { ...customer },
      description: product.name,
      product: product.name,
      category: product.category,
    };
  });
}

function refundsOn(seed: string, day: Day, currency: string, start: Day): DemoRefund[] {
  const rng = random(seedFrom(`${seed}:refunds:${day}`));
  const refunded = addDays(day, -3);
  if (refunded < start || rng() >= 0.12) return [];
  const [charge] = chargesOn(seed, refunded, currency);
  if (!charge) return [];
  return [
    {
      object: "refund",
      id: `re_${charge.id.slice(3)}`,
      amount: charge.amount,
      currency: charge.currency,
      created: unix(day, 11, between(rng, 0, 59)),
      charge: charge.id,
      customer: charge.customer,
      category: charge.category,
    },
  ];
}

function netOn(seed: string, day: Day, currency: string, start: Day): number {
  const charges = chargesOn(seed, day, currency).reduce((sum, c) => sum + c.amount - c.fee, 0);
  const refunds = refundsOn(seed, day, currency, start).reduce((sum, r) => sum + r.amount, 0);
  return charges - refunds;
}

function payoutsOn(seed: string, day: Day, currency: string, start: Day): DemoPayout[] {
  // Weekly payouts every Monday of the previous seven days' net balance.
  if (new Date(`${day}T00:00:00Z`).getUTCDay() !== 1) return [];
  let net = 0;
  for (let offset = 1; offset <= 7; offset++) {
    const previous = addDays(day, -offset);
    if (previous >= start) net += netOn(seed, previous, currency, start);
  }
  if (net <= 0) return [];
  const tag = seedFrom(seed).toString(36).slice(0, 6);
  return [
    {
      object: "payout",
      id: `po_${tag}${compactDay(day)}`,
      amount: net,
      currency: currency.toLowerCase(),
      created: unix(day, 1),
      arrival_date: unix(addDays(day, 2), 0),
      status: "paid",
    },
  ];
}

/** Everything that happened on one day, in time order. */
export function demoPaymentsDay(seed: string, day: Day, currency: string, start: Day): DemoEvent[] {
  return [...payoutsOn(seed, day, currency, start), ...chargesOn(seed, day, currency), ...refundsOn(seed, day, currency, start)].sort(
    (a, b) => a.created - b.created,
  );
}

/** The processor balance (charges − fees − refunds − payouts) through `through`. */
export function demoPaymentsBalance(seed: string, currency: string, start: Day, through: Day): number {
  let balance = 0;
  for (let day = start; day <= through; day = addDays(day, 1)) {
    for (const event of demoPaymentsDay(seed, day, currency, start)) {
      if (event.object === "charge") balance += event.amount - event.fee;
      else balance -= event.amount;
    }
  }
  return balance;
}

const configSchema = z
  .object({
    currency: z.enum(["USD", "EUR", "GBP", "BDT"]).default("USD"),
    /** Payouts become transfers into this account; without it they are skipped. */
    payoutAccountId: z.uuid().nullish(),
  })
  .loose();
type Config = z.output<typeof configSchema>;

const customerName = (value: unknown) => (value && typeof value === "object" ? String((value as { name?: unknown }).name ?? "") : "") || null;

function dayOf(created: number, timeZone: string): Day {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(created * 1000));
}

export function normalizeDemoPayment(raw: RawRecord, connection: { timezone: string; config: Config }): CanonicalRecordInput | CanonicalRecordInput[] | null {
  if (raw.object === "balance") {
    return { kind: "balance", balance: raw.balance as number, currency: String(raw.currency).toUpperCase(), asOf: raw.asOf as string };
  }
  const event = raw as unknown as DemoEvent;
  const currency = String(event.currency ?? "").toUpperCase();
  const date = dayOf(event.created, connection.timezone);
  const occurredAt = new Date(event.created * 1000).toISOString();
  if (event.object === "charge") {
    const customer = customerName(event.customer);
    const records: CanonicalRecordInput[] = [
      {
        kind: "revenue",
        externalId: event.id,
        amount: event.amount,
        currency,
        date,
        occurredAt,
        source: "Demo Payments",
        customer,
        product: event.product,
        categoryHint: event.category,
        description: `${event.product}${customer ? ` · ${customer}` : ""}`,
        reference: event.id,
        metadata: { chargeId: event.id, customerEmail: event.customer?.email ?? null },
      },
    ];
    if (event.fee > 0) {
      records.push({
        kind: "expense",
        externalId: `${event.id}:fee`,
        amount: event.fee,
        currency,
        date,
        occurredAt,
        vendor: "Demo Payments",
        categoryHint: "Payment processing fees",
        description: `Processing fee · ${event.id}`,
        reference: event.id,
        metadata: { chargeId: event.id },
      });
    }
    return records;
  }
  if (event.object === "refund") {
    return {
      kind: "transaction",
      externalId: event.id,
      type: "refund",
      direction: "out",
      amount: event.amount,
      currency,
      date,
      occurredAt,
      counterparty: customerName(event.customer),
      categoryHint: event.category,
      description: `Refund of ${event.charge}`,
      reference: event.id,
      metadata: { chargeId: event.charge },
    };
  }
  if (event.object === "payout") {
    if (!connection.config.payoutAccountId) {
      return {
        kind: "skip",
        externalId: event.id,
        reason: "Payout not recorded: choose a payout account in the connection settings to record payouts as transfers",
      };
    }
    return {
      kind: "transaction",
      externalId: event.id,
      type: "transfer",
      direction: "out",
      amount: event.amount,
      currency,
      date,
      occurredAt,
      toAccountRef: connection.config.payoutAccountId,
      description: "Payout to bank",
      reference: event.id,
      metadata: { payoutId: event.id },
    };
  }
  return null;
}

const WEBHOOK_EVENTS = ["charge.succeeded", "charge.refunded", "payout.paid"] as const;

export const demoPaymentsConnector = defineConnector<Config, Record<string, string>>({
  id: "demo_payments",
  displayName: "Demo Payments",
  category: "payments",
  description:
    "A Stripe-like sandbox for a business: gross revenue by customer and product, processing fees, refunds and weekly payouts, with signed webhooks you can fire yourself.",
  icon: "credit-card",
  capabilities: { sync: true, webhook: true, import: false, testConnection: true },
  credentialFields: [],
  configFields: [
    {
      key: "currency",
      label: "Currency",
      type: "select",
      required: false,
      default: "USD",
      options: ["USD", "EUR", "GBP", "BDT"].map((code) => ({ value: code, label: code })),
      help: "The currency the sandbox charges in.",
    },
    {
      key: "payoutAccountId",
      label: "Payout account",
      type: "account",
      required: false,
      help: "The bank account payouts land in. Without one, payouts are skipped (and listed in the sync log).",
    },
  ],
  credentialsSchema: z
    .object({})
    .loose()
    .transform(() => ({}) as Record<string, string>),
  configSchema,
  requiresAccount: true,
  defaultSyncFrequency: "hourly",
  webhookDocs: {
    signatureHeader: DEMO_PAYMENTS.signatureHeader,
    scheme: "t=<unix seconds>,v1=<hex HMAC-SHA256 of <t>.<raw body> with the webhook secret>; 5-minute tolerance",
    events: [...WEBHOOK_EVENTS],
  },

  async validate({ config }) {
    return { ok: true, message: `The demo payments sandbox is ready (charging in ${config.currency}).` };
  },

  suggestAccount({ config }) {
    return { name: "Demo Payments balance", kind: "payment_processor", currency: config.currency, provider: "demo_payments", openingBalance: 0 };
  },

  async fetch(ctx, params) {
    const clock = simulationClock({
      cursor: params.cursor,
      createdAt: ctx.connection.createdAt,
      now: ctx.now,
      timeZone: ctx.connection.timezone,
      historyDays: DEMO_PAYMENTS.historyDays,
      initialLagDays: DEMO_PAYMENTS.initialLagDays,
      stepDays: DEMO_PAYMENTS.stepDays,
    });
    const currency = ctx.config.currency;
    const items = revealedDays(clock).flatMap((d) => demoPaymentsDay(ctx.connection.id, d, currency, clock.start));
    const { page, nextCursor, hasMore } = pageOf(items, clock, DEMO_PAYMENTS.pageSize);
    const records: RawRecord[] = page.map((item) => ({ ...item }));
    if (!hasMore) {
      const asOf = clock.target > clock.through ? clock.target : clock.through;
      const balance = asOf >= clock.start ? demoPaymentsBalance(ctx.connection.id, currency, clock.start, asOf) : 0;
      records.push({ object: "balance", balance, currency, asOf });
    }
    return { records, nextCursor, hasMore };
  },

  normalize: (raw, connection) => normalizeDemoPayment(raw, connection),

  verifyWebhook({ headers, rawBody, secret, now }) {
    return verifyTimestampedHeader({ header: headers[DEMO_PAYMENTS.signatureHeader], rawBody, secret, now });
  },

  parseWebhook(rawBody) {
    const event = parseJsonObject(rawBody);
    const id = typeof event.id === "string" ? event.id : null;
    const type = typeof event.type === "string" ? event.type : null;
    if (!id || !type) throw new ConnectorError("A demo payments event needs `id` and `type`");
    const object = (event.data as { object?: unknown } | undefined)?.object;
    const records = (WEBHOOK_EVENTS as readonly string[]).includes(type) && object && typeof object === "object" ? [object as RawRecord] : [];
    return { eventId: id, eventType: type, records };
  },

  buildTestEvent({ connection, secret, now, eventType }) {
    const type = eventType && (WEBHOOK_EVENTS as readonly string[]).includes(eventType) ? eventType : "charge.succeeded";
    const currency = connection.config.currency;
    const created = Math.floor(now.getTime() / 1000);
    const token = randomBase62(8);
    const product = PRODUCTS[0];
    const customer = CUSTOMERS[2];
    const amount = Math.round(product.price * (CURRENCY_SCALE[currency] ?? 1));
    let object: DemoEvent;
    if (type === "charge.refunded") {
      object = {
        object: "refund",
        id: `re_test_${token}`,
        amount,
        currency: currency.toLowerCase(),
        created,
        charge: `ch_test_${token}`,
        customer: { ...customer },
        category: product.category,
      };
    } else if (type === "payout.paid") {
      object = {
        object: "payout",
        id: `po_test_${token}`,
        amount: amount * 5,
        currency: currency.toLowerCase(),
        created,
        arrival_date: created + 2 * 86_400,
        status: "paid",
      };
    } else {
      object = {
        object: "charge",
        id: `ch_test_${token}`,
        amount,
        fee: feeFor(amount, currency),
        currency: currency.toLowerCase(),
        created,
        customer: { ...customer },
        description: product.name,
        product: product.name,
        category: product.category,
      };
    }
    const rawBody = Buffer.from(JSON.stringify({ id: `evt_test_${token}`, type, created, livemode: false, data: { object } }));
    return {
      eventType: type,
      rawBody,
      headers: { "content-type": "application/json", [DEMO_PAYMENTS.signatureHeader]: signTimestampedHeader(secret, rawBody, now) },
    };
  },
});

export function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new ConnectorError("The event body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConnectorError("The event body must be a JSON object");
  return parsed as Record<string, unknown>;
}
