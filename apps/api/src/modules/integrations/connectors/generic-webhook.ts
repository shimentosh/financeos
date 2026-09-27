import { today } from "@expensewise/core";
import { type CanonicalRecordInput, inboundWebhookEvent } from "@expensewise/core/contracts/integrations-extra";
import { z } from "zod";
import { randomBase62 } from "../crypto.js";
import { parseJsonObject } from "./demo-payments.js";
import { signExpenseWise, verifyExpenseWiseSignature } from "./signatures.js";
import { ConnectorError, defineConnector, type RawRecord } from "./types.js";

/**
 * "Custom webhook": your app POSTs `{ id, type, data }` to the connection's
 * URL, signed with its secret. `id` makes delivery idempotent; `data` uses
 * the public API's snake_case fields.
 */

export const EXPENSEWISE_SIGNATURE_HEADER = "x-expensewise-signature";
export const EXPENSEWISE_TIMESTAMP_HEADER = "x-expensewise-timestamp";

const configSchema = z.object({}).loose();

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export function normalizeInboundEvent(raw: RawRecord): CanonicalRecordInput {
  const parsed = inboundWebhookEvent.safeParse(raw);
  if (!parsed.success) throw new ConnectorError(`Invalid event: ${describeIssues(parsed.error)}`);
  const event = parsed.data;
  const data = event.data;
  const common = {
    externalId: data.external_id ?? event.id,
    amount: data.amountMinor,
    currency: data.currency,
    date: data.date,
    occurredAt: data.occurred_at ?? null,
    description: data.description ?? null,
    categoryHint: data.category ?? null,
    reference: data.reference ?? null,
    metadata: { ...data.metadata, eventId: event.id },
  };
  if (event.type === "revenue") {
    const revenue = event.data;
    return {
      kind: "revenue",
      ...common,
      source: revenue.source ?? null,
      customer: revenue.customer ?? null,
      product: revenue.product ?? null,
      project: revenue.project ?? null,
    };
  }
  if (event.type === "expense") {
    const expense = event.data;
    return { kind: "expense", ...common, vendor: expense.vendor ?? null, project: expense.project ?? null };
  }
  const transaction = event.data;
  return {
    kind: "transaction",
    ...common,
    type: transaction.type,
    direction: transaction.direction,
    counterparty: transaction.counterparty ?? null,
    projectHint: transaction.project ?? null,
  };
}

export const genericWebhookConnector = defineConnector<Record<string, unknown>, Record<string, string>>({
  id: "generic_webhook",
  displayName: "Custom webhook",
  category: "custom",
  description:
    "Let your own app push revenue, expenses and transactions the moment they happen: POST signed JSON events to a private URL. Duplicate deliveries are ignored.",
  icon: "webhook",
  capabilities: { sync: false, webhook: true, import: false, testConnection: false },
  credentialFields: [],
  configFields: [],
  credentialsSchema: z
    .object({})
    .loose()
    .transform(() => ({}) as Record<string, string>),
  configSchema,
  requiresAccount: false,
  defaultSyncFrequency: "manual",
  webhookDocs: {
    signatureHeader: EXPENSEWISE_SIGNATURE_HEADER,
    scheme:
      "x-expensewise-timestamp: <unix seconds>; x-expensewise-signature: sha256=<hex HMAC-SHA256 of <timestamp>.<raw body> with the webhook secret>; 5-minute tolerance. Body: { id, type: transaction | revenue | expense, data }",
    events: ["transaction", "revenue", "expense"],
  },

  normalize: (raw) => normalizeInboundEvent(raw),

  verifyWebhook({ headers, rawBody, secret, now }) {
    return verifyExpenseWiseSignature({
      signature: headers[EXPENSEWISE_SIGNATURE_HEADER],
      timestamp: headers[EXPENSEWISE_TIMESTAMP_HEADER],
      rawBody,
      secret,
      now,
    });
  },

  parseWebhook(rawBody) {
    const body = parseJsonObject(rawBody);
    const parsed = inboundWebhookEvent.safeParse(body);
    if (!parsed.success) throw new ConnectorError(`Invalid event: ${describeIssues(parsed.error)}`);
    return { eventId: parsed.data.id, eventType: parsed.data.type, records: [body] };
  },

  buildTestEvent({ connection, secret, now }) {
    const token = randomBase62(8);
    const body = {
      id: `evt_test_${token}`,
      type: "revenue",
      data: {
        amount: connection.baseCurrency === "BDT" ? 250_000 : 2_500,
        currency: connection.baseCurrency,
        date: today(connection.timezone, now),
        customer: "Test customer",
        product: "Test order",
        description: "Test event from Expense Wise",
        metadata: { test: true },
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const { timestamp, signature } = signExpenseWise(secret, rawBody, now);
    return {
      eventType: "revenue",
      rawBody,
      headers: { "content-type": "application/json", [EXPENSEWISE_TIMESTAMP_HEADER]: timestamp, [EXPENSEWISE_SIGNATURE_HEADER]: signature },
    };
  },
});
