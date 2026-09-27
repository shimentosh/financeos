import type { CanonicalRecordInput } from "@expensewise/core/contracts/integrations-extra";
import { z } from "zod";
import { parseJsonObject } from "./demo-payments.js";
import type { HttpClient, HttpResponse } from "./http.js";
import { verifyTimestampedHeader } from "./signatures.js";
import { ConnectorError, defineConnector, type RawRecord } from "./types.js";

/**
 * Stripe, for real: a restricted key reads balance transactions (the ledger
 * of the Stripe balance), paged with `starting_after` and resumed from
 * `created[gte]`. Amounts are already minor units. Webhooks use Stripe's
 * signature scheme with the endpoint's signing secret.
 */

const API = "https://api.stripe.com/v1";
const PAGE_LIMIT = 100;
/** Re-read the last ten minutes each sync: late-visible rows are caught, duplicates are free. */
const OVERLAP_SECONDS = 600;
const WEBHOOK_EVENTS = ["charge.succeeded", "charge.refunded", "payout.paid"] as const;

const credentialsSchema = z.object({
  secretKey: z
    .string()
    .trim()
    .regex(/^(rk|sk)_(live|test)_[A-Za-z0-9]{10,}$/, "Expected a Stripe restricted key (rk_live_…) or secret key (sk_live_…)"),
  webhookSigningSecret: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9]+$/, "Expected the endpoint's signing secret (whsec_…)")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
type Credentials = z.output<typeof credentialsSchema>;

const configSchema = z
  .object({
    payoutAccountId: z.uuid().nullish(),
    revenueCategory: z.string().trim().max(60).nullish(),
    feeCategory: z.string().trim().max(60).default("Payment processing fees"),
    initialDays: z.coerce.number().int().min(1).max(730).default(90),
  })
  .loose();
type Config = z.output<typeof configSchema>;

const cursorSchema = z.object({
  createdGte: z.number().int(),
  startingAfter: z.string().optional(),
  maxCreated: z.number().int().optional(),
});

type StripeObject = Record<string, unknown>;

export type StripeBalanceTransaction = {
  id: string;
  object: "balance_transaction";
  amount: number;
  currency: string;
  created: number;
  description: string | null;
  fee: number;
  net: number;
  type: string;
  reporting_category?: string;
  status?: string;
  source: string | StripeObject | null;
};

function dayIn(created: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(created * 1000));
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const obj = (value: unknown): StripeObject | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : null);

/** The best customer label a charge carries: billing name, expanded customer, receipt email. */
function customerOf(source: StripeObject | null): string | null {
  if (!source) return null;
  const billing = obj(source.billing_details);
  const customer = obj(source.customer);
  return str(billing?.name) ?? str(customer?.name) ?? str(customer?.email) ?? str(source.receipt_email) ?? str(billing?.email) ?? null;
}

function sourceId(source: StripeBalanceTransaction["source"]): string | null {
  if (typeof source === "string") return source;
  return str(obj(source)?.id);
}

/** Maps one balance transaction to canonical records (revenue + fee, refund, payout transfer, ...). */
export function mapBalanceTransaction(bt: StripeBalanceTransaction, config: Config, timeZone: string): CanonicalRecordInput[] {
  const currency = bt.currency.toUpperCase();
  const date = dayIn(bt.created, timeZone);
  const occurredAt = new Date(bt.created * 1000).toISOString();
  const source = obj(bt.source);
  const ref = sourceId(bt.source) ?? bt.id;
  const metadata = { balanceTransactionId: bt.id, sourceId: ref, stripeType: bt.type, reportingCategory: bt.reporting_category ?? null };
  const amount = Math.abs(bt.amount);
  const records: CanonicalRecordInput[] = [];
  const fee = (description: string) => {
    if (!bt.fee) return;
    if (bt.fee > 0) {
      records.push({
        kind: "expense",
        externalId: `${bt.id}:fee`,
        amount: bt.fee,
        currency,
        date,
        occurredAt,
        vendor: "Stripe",
        categoryHint: config.feeCategory,
        description,
        reference: ref,
        metadata,
      });
    } else {
      // A fee Stripe gave back (e.g. on some refunds) reduces what fees cost.
      records.push({
        kind: "transaction",
        externalId: `${bt.id}:fee`,
        type: "refund",
        direction: "in",
        amount: -bt.fee,
        currency,
        date,
        occurredAt,
        counterparty: "Stripe",
        categoryHint: config.feeCategory,
        description: "Stripe fee refunded",
        reference: ref,
        metadata,
      });
    }
  };
  if (amount === 0 && !bt.fee) return [{ kind: "skip", externalId: bt.id, reason: `Zero-amount Stripe ${bt.type}` }];

  switch (bt.type) {
    case "charge":
    case "payment": {
      const customer = customerOf(source);
      const product = str(source?.description) ?? str(bt.description);
      records.push({
        kind: "revenue",
        externalId: bt.id,
        amount,
        currency,
        date,
        occurredAt,
        source: "Stripe",
        customer,
        product,
        categoryHint: config.revenueCategory ?? null,
        description: [product ?? "Stripe payment", customer].filter(Boolean).join(" · "),
        reference: ref,
        metadata,
      });
      fee("Stripe fees");
      return records;
    }
    case "refund":
    case "payment_refund": {
      records.push({
        kind: "transaction",
        externalId: bt.id,
        type: "refund",
        direction: "out",
        amount,
        currency,
        date,
        occurredAt,
        counterparty: customerOf(obj(source?.charge) ?? source),
        categoryHint: config.revenueCategory ?? null,
        description: str(bt.description) ?? "Stripe refund",
        reference: ref,
        metadata,
      });
      fee("Stripe fees on refund");
      return records;
    }
    case "payout": {
      if (!config.payoutAccountId) {
        records.push({
          kind: "skip",
          externalId: bt.id,
          reason: "Payout not recorded: choose a payout account in the connection settings to record payouts as transfers",
        });
      } else {
        records.push({
          kind: "transaction",
          externalId: bt.id,
          type: "transfer",
          direction: "out",
          amount,
          currency,
          date,
          occurredAt,
          toAccountRef: config.payoutAccountId,
          description: str(bt.description) ?? "Stripe payout",
          reference: ref,
          metadata,
        });
      }
      fee("Stripe payout fee");
      return records;
    }
    case "payout_cancel":
    case "payout_failure": {
      if (!config.payoutAccountId) {
        records.push({ kind: "skip", externalId: bt.id, reason: `Stripe ${bt.type.replace("_", " ")} not recorded: no payout account is configured` });
      } else {
        // The payout came back: money moves from the bank to the Stripe balance.
        records.push({
          kind: "transaction",
          externalId: bt.id,
          type: "transfer",
          direction: "out",
          amount,
          currency,
          date,
          occurredAt,
          accountRef: config.payoutAccountId,
          toAccountRef: "@connection",
          description: `Stripe ${bt.type.replace("_", " ")}`,
          reference: ref,
          metadata,
        });
      }
      return records;
    }
    case "adjustment": {
      records.push({
        kind: "transaction",
        externalId: bt.id,
        type: "adjustment",
        direction: bt.amount >= 0 ? "in" : "out",
        amount,
        currency,
        date,
        occurredAt,
        description: str(bt.description) ?? "Stripe adjustment",
        reference: ref,
        metadata,
      });
      fee("Stripe fees on adjustment");
      return records;
    }
    case "stripe_fee":
    case "tax_fee": {
      records.push({
        kind: "expense",
        externalId: bt.id,
        amount,
        currency,
        date,
        occurredAt,
        vendor: "Stripe",
        categoryHint: config.feeCategory,
        description: str(bt.description) ?? "Stripe fee",
        reference: ref,
        metadata,
      });
      return records;
    }
    default:
      return [{ kind: "skip", externalId: bt.id, reason: `Stripe ${bt.type} balance transactions are not imported` }];
  }
}

/**
 * Webhook objects map onto the same external ids as the balance transaction
 * they produce, so an event and the next sync never import the same money
 * twice. Without a balance transaction id the sync imports it later.
 */
export function mapStripeEventObject(raw: RawRecord, config: Config, timeZone: string): CanonicalRecordInput[] {
  const kind = raw.__stripe;
  const object = obj(raw.object) ?? {};
  const created = typeof object.created === "number" ? object.created : Math.floor(Date.now() / 1000);
  const currency = String(object.currency ?? "").toUpperCase();
  const date = dayIn(created, timeZone);
  const occurredAt = new Date(created * 1000).toISOString();
  const btId = str(object.balance_transaction) ?? str(obj(object.balance_transaction)?.id);
  const id = str(object.id) ?? "unknown";
  const later = (what: string): CanonicalRecordInput => ({
    kind: "skip",
    externalId: id,
    reason: `${what} has no balance transaction yet; the next sync imports it`,
  });

  if (kind === "charge") {
    if (!btId) return [later(`Charge ${id}`)];
    const customer = customerOf(object);
    const product = str(object.description);
    return [
      {
        kind: "revenue",
        externalId: btId,
        amount: Number(object.amount),
        currency,
        date,
        occurredAt,
        source: "Stripe",
        customer,
        product,
        categoryHint: config.revenueCategory ?? null,
        description: [product ?? "Stripe payment", customer].filter(Boolean).join(" · "),
        reference: id,
        metadata: { balanceTransactionId: btId, sourceId: id, stripeType: "charge", via: "webhook" },
      },
    ];
  }
  if (kind === "refund") {
    if (!btId) return [later(`Refund ${id}`)];
    return [
      {
        kind: "transaction",
        externalId: btId,
        type: "refund",
        direction: "out",
        amount: Number(object.amount),
        currency,
        date,
        occurredAt,
        counterparty: str(raw.customer),
        categoryHint: config.revenueCategory ?? null,
        description: "Stripe refund",
        reference: id,
        metadata: { balanceTransactionId: btId, sourceId: id, stripeType: "refund", via: "webhook" },
      },
    ];
  }
  if (kind === "payout") {
    if (!btId) return [later(`Payout ${id}`)];
    if (!config.payoutAccountId) {
      return [
        { kind: "skip", externalId: btId, reason: "Payout not recorded: choose a payout account in the connection settings to record payouts as transfers" },
      ];
    }
    return [
      {
        kind: "transaction",
        externalId: btId,
        type: "transfer",
        direction: "out",
        amount: Number(object.amount),
        currency,
        date,
        occurredAt,
        toAccountRef: config.payoutAccountId,
        description: str(object.description) ?? "Stripe payout",
        reference: id,
        metadata: { balanceTransactionId: btId, sourceId: id, stripeType: "payout", via: "webhook" },
      },
    ];
  }
  return [];
}

async function stripeGet(http: HttpClient, key: string, path: string): Promise<HttpResponse> {
  const response = await http({ method: "GET", url: `${API}${path}`, headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (response.status >= 200 && response.status < 300) return response;
  let message = `HTTP ${response.status}`;
  try {
    message = (response.json<{ error?: { message?: string } }>().error?.message ?? message).slice(0, 300);
  } catch {
    // Not JSON: keep the status.
  }
  if (response.status === 401) throw new ConnectorError(`Stripe rejected the API key: ${message}`);
  if (response.status === 403)
    throw new ConnectorError(`The key lacks a permission this needs: ${message}. Give the restricted key read access to Balance and Charges.`);
  throw new ConnectorError(`Stripe returned ${message}`, { retryable: response.status === 429 || response.status >= 500 });
}

type StripeBalance = { available?: Array<{ amount: number; currency: string }>; pending?: Array<{ amount: number; currency: string }>; livemode?: boolean };

function balancesByCurrency(balance: StripeBalance): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of [...(balance.available ?? []), ...(balance.pending ?? [])]) {
    const code = entry.currency.toUpperCase();
    totals.set(code, (totals.get(code) ?? 0) + entry.amount);
  }
  return totals;
}

export const stripeConnector = defineConnector<Config, Credentials>({
  id: "stripe",
  displayName: "Stripe",
  category: "payments",
  description:
    "Imports your Stripe balance activity: gross revenue by customer, Stripe fees as expenses, refunds, and payouts as transfers to your bank. Webhooks bring new charges in within seconds.",
  icon: "credit-card",
  website: "https://stripe.com",
  capabilities: { sync: true, webhook: true, import: false, testConnection: true },
  credentialFields: [
    {
      key: "secretKey",
      label: "Restricted API key",
      type: "password",
      required: true,
      placeholder: "rk_live_…",
      help: "Create a restricted key in Stripe → Developers → API keys with read access to Balance, Balance transactions, Charges and Payouts.",
    },
    {
      key: "webhookSigningSecret",
      label: "Webhook signing secret",
      type: "password",
      required: false,
      placeholder: "whsec_…",
      help: "Optional. Add the webhook URL shown after connecting as an endpoint in Stripe (events: charge.succeeded, charge.refunded, payout.paid), then paste its signing secret here.",
    },
  ],
  configFields: [
    {
      key: "payoutAccountId",
      label: "Payout bank account",
      type: "account",
      required: false,
      help: "Payouts become transfers into this account. Without one, payouts are skipped.",
    },
    {
      key: "revenueCategory",
      label: "Revenue category",
      type: "text",
      required: false,
      placeholder: "Subscription revenue",
      help: "Income category for charges (by name).",
    },
    {
      key: "feeCategory",
      label: "Fee category",
      type: "text",
      required: false,
      default: "Payment processing fees",
      help: "Expense category for Stripe fees (by name).",
    },
    { key: "initialDays", label: "History to import", type: "number", required: false, default: 90, help: "Days of history the first sync reads (1–730)." },
  ],
  credentialsSchema,
  configSchema,
  requiresAccount: true,
  defaultSyncFrequency: "hourly",
  webhookSecretCredential: "webhookSigningSecret",
  webhookDocs: {
    signatureHeader: "stripe-signature",
    scheme: "Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of <t>.<raw body> with the endpoint signing secret>; 5-minute tolerance",
    events: [...WEBHOOK_EVENTS],
  },

  async validate({ credentials, http }) {
    try {
      const balance = (await stripeGet(http, credentials.secretKey, "/balance")).json<StripeBalance>();
      const currencies = [...balancesByCurrency(balance).keys()];
      return {
        ok: true,
        message: `Connected to Stripe${balance.livemode === false ? " (test mode)" : ""}${currencies.length ? ` · balance in ${currencies.join(", ")}` : ""}.`,
        details: { livemode: balance.livemode ?? null, currencies },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  suggestAccount({ validation, baseCurrency }) {
    const currencies = validation?.ok ? ((validation.details?.currencies as string[] | undefined) ?? []) : [];
    return {
      name: "Stripe balance",
      kind: "payment_processor",
      currency: currencies[0] ?? (baseCurrency === "BDT" ? "USD" : baseCurrency),
      provider: "stripe",
      openingBalance: 0,
    };
  },

  async fetch(ctx, params) {
    const nowSeconds = Math.floor(ctx.now.getTime() / 1000);
    const parsed = cursorSchema.safeParse(params.cursor);
    const state = parsed.success ? parsed.data : { createdGte: nowSeconds - ctx.config.initialDays * 86_400 };
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT), "created[gte]": String(state.createdGte) });
    query.append("expand[]", "data.source");
    if (state.startingAfter) query.set("starting_after", state.startingAfter);
    const body = (await stripeGet(ctx.http, ctx.credentials.secretKey, `/balance_transactions?${query}`)).json<{
      data?: StripeBalanceTransaction[];
      has_more?: boolean;
    }>();
    if (!Array.isArray(body.data)) throw new ConnectorError("Stripe returned an unexpected balance transaction list");
    const data = body.data;
    const maxCreated = data.reduce((max, bt) => Math.max(max, bt.created), state.maxCreated ?? 0) || undefined;
    const records: RawRecord[] = data.map((bt) => ({ __stripe: "balance_transaction", ...bt }));

    if (body.has_more && data.length) {
      const last = data[data.length - 1] as StripeBalanceTransaction;
      return { records, nextCursor: { createdGte: state.createdGte, startingAfter: last.id, maxCreated }, hasMore: true };
    }
    // Done: next time, start a little before the newest record seen.
    const resume = maxCreated ? maxCreated - OVERLAP_SECONDS : nowSeconds - 3_600;
    try {
      const balance = (await stripeGet(ctx.http, ctx.credentials.secretKey, "/balance")).json<StripeBalance>();
      const asOf = dayIn(nowSeconds, ctx.connection.timezone);
      for (const [currency, amount] of balancesByCurrency(balance)) records.push({ __stripe: "balance", currency, amount, asOf });
    } catch {
      // The balance is informational; a key without Balance access still syncs.
    }
    return { records, nextCursor: { createdGte: Math.max(state.createdGte, resume) }, hasMore: false };
  },

  normalize(raw, connection) {
    if (raw.__stripe === "balance") {
      return { kind: "balance", balance: raw.amount as number, currency: raw.currency as string, asOf: raw.asOf as string };
    }
    if (raw.__stripe === "balance_transaction") {
      return mapBalanceTransaction(raw as unknown as StripeBalanceTransaction, connection.config, connection.timezone);
    }
    return mapStripeEventObject(raw, connection.config, connection.timezone);
  },

  verifyWebhook({ headers, rawBody, secret, now }) {
    return verifyTimestampedHeader({ header: headers["stripe-signature"], rawBody, secret, now });
  },

  parseWebhook(rawBody) {
    const event = parseJsonObject(rawBody);
    const id = str(event.id);
    const type = str(event.type);
    if (!id || !type) throw new ConnectorError("A Stripe event needs `id` and `type`");
    const object = obj(obj(event.data)?.object);
    const records: RawRecord[] = [];
    if (object && type === "charge.succeeded") records.push({ __stripe: "charge", object });
    if (object && type === "charge.refunded") {
      const refunds = obj(object.refunds)?.data;
      const customer = customerOf(object);
      if (Array.isArray(refunds)) {
        for (const refund of refunds) if (obj(refund)) records.push({ __stripe: "refund", object: refund, customer });
      }
      if (!records.length) records.push({ __stripe: "refund", object: { id: object.id, created: object.created, currency: object.currency }, customer });
    }
    if (object && type === "payout.paid") records.push({ __stripe: "payout", object });
    return { eventId: id, eventType: type, records };
  },
});
