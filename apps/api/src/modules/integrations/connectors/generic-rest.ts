import { TRANSACTION_TYPES, type TransactionType } from "@financeos/core";
import type { CanonicalRecordInput } from "@financeos/core/contracts/integrations-extra";
import { z } from "zod";
import { assertSafeUrl, DEFAULT_TIMEOUT_MS, type HttpClient } from "./http.js";
import { type ConnectionInfo, ConnectorError, defineConnector, type RawRecord } from "./types.js";
import { getPath, parseDateValue, parseSignedAmount, textAt } from "./values.js";

/**
 * "Custom API": pulls JSON from the user's own apps. Each endpoint says where
 * the list is (`itemsPath`), how it pages, and which dot paths hold the
 * fields. Requests are SSRF-guarded, time out after 15 s, and a sync reads at
 * most 50 pages.
 */

export const GENERIC_REST_MAX_PAGES = 50;

const dotPath = z
  .string()
  .trim()
  .max(200)
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, "Use a dot path such as data.items or amount.value");

const mappingSchema = z.object({
  externalId: dotPath,
  amount: dotPath.optional(),
  amountUnit: z.enum(["major", "minor"]).default("major"),
  currency: dotPath.optional(),
  date: dotPath.optional(),
  description: dotPath.optional(),
  counterparty: dotPath.optional(),
  category: dotPath.optional(),
  project: dotPath.optional(),
  type: dotPath.optional(),
  direction: dotPath.optional(),
  reference: dotPath.optional(),
  /** Receivables and projects. */
  name: dotPath.optional(),
  code: dotPath.optional(),
  dueDate: dotPath.optional(),
  status: dotPath.optional(),
});

const paginationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("page"),
    pageParam: z.string().trim().min(1).max(40).default("page"),
    sizeParam: z.string().trim().max(40).optional(),
    pageSize: z.number().int().min(1).max(1000).default(100),
    startPage: z.number().int().min(0).default(1),
  }),
  z.object({
    type: z.literal("cursor"),
    /** Dot path of the next cursor in the response; empty or missing ends paging. */
    cursorPath: dotPath,
    cursorParam: z.string().trim().min(1).max(40).default("cursor"),
  }),
]);

const endpointSchema = z
  .object({
    path: z.string().trim().min(1).max(300),
    entity: z.enum(["transaction", "revenue", "expense", "project", "receivable"]),
    method: z.literal("GET").default("GET"),
    itemsPath: z.string().trim().max(200).default(""),
    query: z.record(z.string(), z.string().max(300)).default({}),
    /** Query parameter that receives the last successful sync time (ISO 8601). */
    sinceParam: z.string().trim().max(40).optional(),
    pagination: paginationSchema.default({ type: "none" }),
    mapping: mappingSchema,
    defaults: z
      .object({
        currency: z
          .string()
          .regex(/^[A-Za-z]{3}$/)
          .optional(),
        type: z.enum(TRANSACTION_TYPES).optional(),
      })
      .default({}),
  })
  .superRefine((endpoint, ctx) => {
    const needsAmount = endpoint.entity !== "project";
    if (needsAmount && !endpoint.mapping.amount) ctx.addIssue({ code: "custom", path: ["mapping", "amount"], message: "Map the amount field" });
    if (needsAmount && !endpoint.mapping.date) ctx.addIssue({ code: "custom", path: ["mapping", "date"], message: "Map the date field" });
    if (endpoint.entity === "project" && !endpoint.mapping.name && !endpoint.mapping.description) {
      ctx.addIssue({ code: "custom", path: ["mapping", "name"], message: "Map the project name" });
    }
    if (/^[a-z]+:/i.test(endpoint.path) || endpoint.path.startsWith("//")) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "The path is relative to the base URL" });
    }
  });

const configSchema = z
  .object({
    baseUrl: z.url({ protocol: /^https?$/ }).max(500),
    auth: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("none") }),
        z.object({ type: z.literal("bearer") }),
        z.object({
          type: z.literal("header"),
          name: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9-]{1,60}$/, "A header name such as X-Api-Key"),
        }),
        z.object({ type: z.literal("basic") }),
      ])
      .default({ type: "none" }),
    endpoints: z.array(endpointSchema).min(1).max(10),
    allowPrivateNetwork: z.boolean().optional(),
  })
  .loose();
export type GenericRestConfig = z.output<typeof configSchema>;
type Endpoint = GenericRestConfig["endpoints"][number];

const credentialsSchema = z.object({
  /** Bearer token, header value, or basic-auth password. */
  token: z.string().max(4000).optional(),
  username: z.string().max(200).optional(),
});
type Credentials = z.output<typeof credentialsSchema>;

const cursorSchema = z.object({
  endpoint: z.number().int().min(0),
  page: z.number().int().min(0).optional(),
  cursor: z.string().optional(),
  since: z.string().nullable().optional(),
  startedAt: z.string(),
});
const restingSchema = z.object({ lastCompletedAt: z.string() });

function authHeaders(config: GenericRestConfig, credentials: Credentials): Record<string, string> {
  const token = credentials.token ?? "";
  switch (config.auth.type) {
    case "bearer":
      if (!token) throw new ConnectorError("Add the bearer token in the credentials");
      return { Authorization: `Bearer ${token}` };
    case "header":
      if (!token) throw new ConnectorError(`Add the value for the ${config.auth.name} header in the credentials`);
      return { [config.auth.name]: token };
    case "basic":
      return { Authorization: `Basic ${Buffer.from(`${credentials.username ?? ""}:${token}`).toString("base64")}` };
    default:
      return {};
  }
}

function endpointUrl(config: GenericRestConfig, endpoint: Endpoint, params: Record<string, string>): string {
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const url = new URL(endpoint.path.replace(/^\/+/, ""), base);
  const baseHost = new URL(config.baseUrl).host;
  if (url.host !== baseHost) throw new ConnectorError("Endpoint paths must stay on the base URL's host");
  for (const [key, value] of Object.entries({ ...endpoint.query, ...params })) url.searchParams.set(key, value);
  return url.toString();
}

async function fetchEndpointPage(input: {
  http: HttpClient;
  config: GenericRestConfig;
  credentials: Credentials;
  endpoint: Endpoint;
  page?: number;
  cursor?: string;
  since?: string | null;
  allowPrivateNetwork: boolean;
}): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const { endpoint } = input;
  const params: Record<string, string> = {};
  if (endpoint.pagination.type === "page") {
    params[endpoint.pagination.pageParam] = String(input.page ?? endpoint.pagination.startPage);
    if (endpoint.pagination.sizeParam) params[endpoint.pagination.sizeParam] = String(endpoint.pagination.pageSize);
  }
  if (endpoint.pagination.type === "cursor" && input.cursor) params[endpoint.pagination.cursorParam] = input.cursor;
  if (endpoint.sinceParam && input.since) params[endpoint.sinceParam] = input.since;
  const url = endpointUrl(input.config, endpoint, params);
  assertSafeUrl(url, { allowPrivateNetwork: input.allowPrivateNetwork });
  const response = await input.http({
    method: "GET",
    url,
    headers: { Accept: "application/json", ...authHeaders(input.config, input.credentials) },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowPrivateNetwork: input.allowPrivateNetwork,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ConnectorError(
      `${endpoint.path} answered HTTP ${response.status}${response.status === 401 || response.status === 403 ? " (check the credentials)" : ""}`,
      {
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
  const body = response.json<unknown>();
  const items = getPath(body, endpoint.itemsPath);
  if (!Array.isArray(items)) {
    throw new ConnectorError(`${endpoint.path}: ${endpoint.itemsPath ? `"${endpoint.itemsPath}"` : "the response"} is not a list`);
  }
  const next = endpoint.pagination.type === "cursor" ? getPath(body, endpoint.pagination.cursorPath) : null;
  return { items, nextCursor: typeof next === "string" || typeof next === "number" ? String(next) || null : null };
}

const TYPE_WORDS: Record<string, TransactionType> = {
  income: "income",
  revenue: "income",
  sale: "income",
  sales: "income",
  credit: "income",
  deposit: "income",
  expense: "expense",
  cost: "expense",
  purchase: "expense",
  bill: "expense",
  debit: "expense",
  payment: "expense",
  refund: "refund",
  transfer: "transfer",
};

function typeFrom(value: string | null): TransactionType | null {
  if (!value) return null;
  const word = value.toLowerCase().trim();
  if ((TRANSACTION_TYPES as readonly string[]).includes(word)) return word as TransactionType;
  return TYPE_WORDS[word] ?? null;
}

function directionFrom(value: string | null): "in" | "out" | null {
  if (!value) return null;
  const word = value.toLowerCase().trim();
  if (["in", "credit", "cr", "inflow", "incoming", "received"].includes(word)) return "in";
  if (["out", "debit", "dr", "outflow", "outgoing", "sent", "paid"].includes(word)) return "out";
  return null;
}

/** Maps one item with its endpoint's dot paths. Throws with a message naming the missing field. */
export function mapGenericItem(item: unknown, endpoint: Endpoint, connection: ConnectionInfo): CanonicalRecordInput {
  const m = endpoint.mapping;
  const externalId = textAt(item, m.externalId);
  if (!externalId) throw new ConnectorError(`Missing external id at "${m.externalId}"`);
  const description = textAt(item, m.description);
  const metadata = { endpoint: endpoint.path };

  if (endpoint.entity === "project") {
    const name = textAt(item, m.name, 80) ?? description?.slice(0, 80);
    if (!name) throw new ConnectorError(`Project ${externalId} has no name at "${m.name ?? m.description}"`);
    return { kind: "project", externalId, name, code: textAt(item, m.code, 16), description, metadata };
  }

  const currency = (textAt(item, m.currency) ?? endpoint.defaults.currency ?? connection.baseCurrency).toUpperCase();
  const rawAmount = m.amount ? getPath(item, m.amount) : undefined;
  const signed = parseSignedAmount(rawAmount, currency, m.amountUnit);
  if (signed === null || signed === 0) throw new ConnectorError(`Record ${externalId}: no usable amount at "${m.amount}"`);
  const amount = Math.abs(signed);
  const when = parseDateValue(m.date ? getPath(item, m.date) : undefined, connection.timezone);
  if (!when) throw new ConnectorError(`Record ${externalId}: no usable date at "${m.date}"`);
  const counterparty = textAt(item, m.counterparty);
  const category = textAt(item, m.category);
  const project = textAt(item, m.project);
  const reference = textAt(item, m.reference);

  switch (endpoint.entity) {
    case "revenue":
      return {
        kind: "revenue",
        externalId,
        amount,
        currency,
        date: when.day,
        occurredAt: when.occurredAt,
        customer: counterparty,
        project,
        description,
        categoryHint: category,
        reference,
        source: connection.name,
        metadata,
      };
    case "expense":
      return {
        kind: "expense",
        externalId,
        amount,
        currency,
        date: when.day,
        occurredAt: when.occurredAt,
        vendor: counterparty,
        project,
        description,
        categoryHint: category,
        reference,
        metadata,
      };
    case "receivable": {
      const statusText = textAt(item, m.status)?.toLowerCase() ?? "";
      const status = /paid|settled|closed/.test(statusText) ? "paid" : /void|cancel/.test(statusText) ? "cancelled" : "pending";
      const due = m.dueDate ? parseDateValue(getPath(item, m.dueDate), connection.timezone) : null;
      return {
        kind: "receivable",
        externalId,
        customer: counterparty ?? "Unknown customer",
        title: description ?? `Invoice ${reference ?? externalId}`,
        reference,
        amount,
        currency,
        issueDate: when.day,
        dueDate: due?.day ?? null,
        status,
        project,
        metadata,
      };
    }
    default: {
      const type = typeFrom(textAt(item, m.type)) ?? endpoint.defaults.type ?? (signed < 0 ? "expense" : "income");
      const direction =
        directionFrom(textAt(item, m.direction)) ??
        (type === "refund" || type === "adjustment" || type === "loan" || type === "equity" || type === "investment" || type === "debt_payment"
          ? signed < 0
            ? "out"
            : "in"
          : undefined);
      return {
        kind: "transaction",
        externalId,
        type,
        direction,
        amount,
        currency,
        date: when.day,
        occurredAt: when.occurredAt,
        description,
        counterparty,
        categoryHint: category,
        projectHint: project,
        reference,
        metadata,
      };
    }
  }
}

const EXAMPLE_ENDPOINTS = JSON.stringify(
  [
    {
      path: "/api/orders",
      entity: "revenue",
      itemsPath: "data.items",
      pagination: { type: "cursor", cursorPath: "data.next_cursor", cursorParam: "cursor" },
      mapping: {
        externalId: "id",
        amount: "total",
        amountUnit: "major",
        currency: "currency",
        date: "paid_at",
        description: "product.name",
        counterparty: "customer.name",
        project: "project_code",
      },
      defaults: { currency: "USD" },
    },
  ],
  null,
  2,
);

export const genericRestConnector = defineConnector<GenericRestConfig, Credentials>({
  id: "generic_rest",
  displayName: "Custom API",
  category: "custom",
  description:
    "Pull transactions, revenue, expenses, projects or invoices from your own app's JSON API. Map fields with dot paths; paging, auth and incremental sync included.",
  icon: "plug",
  capabilities: { sync: true, webhook: false, import: false, testConnection: true },
  credentialFields: [
    {
      key: "token",
      label: "Token / API key",
      type: "password",
      required: false,
      help: "Bearer token, the value of your API key header, or the basic-auth password.",
    },
    { key: "username", label: "Username (basic auth)", type: "text", required: false },
  ],
  configFields: [
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.yourapp.com", help: "Public https URL of your API." },
    {
      key: "auth",
      label: "Authentication",
      type: "json",
      required: false,
      default: { type: "none" },
      placeholder: '{ "type": "bearer" }',
      help: 'One of {"type":"none"}, {"type":"bearer"}, {"type":"header","name":"X-Api-Key"} or {"type":"basic"}. Secrets go in the credential fields.',
    },
    {
      key: "endpoints",
      label: "Endpoints",
      type: "json",
      required: true,
      placeholder: EXAMPLE_ENDPOINTS,
      help: "Up to 10 endpoints. entity: transaction | revenue | expense | project | receivable. pagination: none | page (pageParam, sizeParam, pageSize, startPage) | cursor (cursorPath, cursorParam). mapping holds dot paths; amountUnit is major (12.50) or minor (1250).",
    },
  ],
  credentialsSchema,
  configSchema,
  requiresAccount: false,
  defaultSyncFrequency: "daily",
  maxPagesPerRun: GENERIC_REST_MAX_PAGES,

  async validate({ credentials, config, http, allowPrivateNetwork, connection }) {
    const info: ConnectionInfo = connection ?? {
      id: "test",
      workspaceId: "test",
      name: "Custom API",
      provider: "generic_rest",
      accountId: null,
      projectId: null,
      createdAt: new Date(),
      timezone: "Asia/Dhaka",
      baseCurrency: "BDT",
    };
    const summary: Array<{ path: string; items: number; mapped: number; firstError: string | null }> = [];
    try {
      for (const endpoint of config.endpoints) {
        const { items } = await fetchEndpointPage({ http, config, credentials, endpoint, allowPrivateNetwork });
        let mapped = 0;
        let firstError: string | null = null;
        for (const item of items.slice(0, 20)) {
          try {
            mapGenericItem(item, endpoint, info);
            mapped++;
          } catch (error) {
            firstError ??= error instanceof Error ? error.message : String(error);
          }
        }
        summary.push({ path: endpoint.path, items: items.length, mapped, firstError });
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const problems = summary.filter((s) => s.firstError);
    return {
      ok: true,
      message: problems.length
        ? `Reached the API, but some records do not map: ${problems.map((p) => `${p.path}: ${p.firstError}`).join("; ")}`
        : `Reached the API: ${summary.map((s) => `${s.path} returned ${s.items} records`).join(", ")}.`,
      details: { endpoints: summary },
    };
  },

  async fetch(ctx, params) {
    const allowPrivateNetwork = ctx.allowPrivateNetwork;
    const resting = restingSchema.safeParse(params.cursor);
    const active = cursorSchema.safeParse(params.cursor);
    const state = active.success
      ? active.data
      : { endpoint: 0, since: resting.success ? resting.data.lastCompletedAt : (params.since?.toISOString() ?? null), startedAt: ctx.now.toISOString() };
    const endpoint = ctx.config.endpoints[state.endpoint];
    if (!endpoint) return { records: [], nextCursor: { lastCompletedAt: state.startedAt }, hasMore: false };

    const { items, nextCursor } = await fetchEndpointPage({
      http: ctx.http,
      config: ctx.config,
      credentials: ctx.credentials,
      endpoint,
      page: "page" in state ? state.page : undefined,
      cursor: "cursor" in state ? state.cursor : undefined,
      since: state.since,
      allowPrivateNetwork,
    });
    const records: RawRecord[] = items.map((item) => ({ endpoint: state.endpoint, item }));

    let samePage = false;
    let next: z.infer<typeof cursorSchema> = { endpoint: state.endpoint + 1, since: state.since, startedAt: state.startedAt };
    if (endpoint.pagination.type === "page" && items.length > 0) {
      const full = !endpoint.pagination.sizeParam || items.length >= endpoint.pagination.pageSize;
      if (full) {
        next = { ...state, page: ("page" in state && state.page !== undefined ? state.page : endpoint.pagination.startPage) + 1 };
        samePage = true;
      }
    }
    if (endpoint.pagination.type === "cursor" && nextCursor && nextCursor !== ("cursor" in state ? state.cursor : undefined) && items.length > 0) {
      next = { ...state, cursor: nextCursor };
      samePage = true;
    }
    if (!samePage && state.endpoint + 1 >= ctx.config.endpoints.length) {
      return { records, nextCursor: { lastCompletedAt: state.startedAt }, hasMore: false };
    }
    return { records, nextCursor: next, hasMore: true };
  },

  normalize(raw, connection) {
    const endpoint = connection.config.endpoints[Number(raw.endpoint)];
    if (!endpoint) throw new ConnectorError("The endpoint for this record is no longer configured");
    return mapGenericItem(raw.item, endpoint, connection);
  },
});
