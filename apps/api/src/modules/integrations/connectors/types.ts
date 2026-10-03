import type { CanonicalRecordInput, ConnectorCategory, SyncTrigger } from "@financeos/core/contracts/integrations-extra";
import type { z } from "zod";
import type { HttpClient } from "./http.js";

/** A provider's own record, exactly as fetched or received. Only its connector reads it. */
export type RawRecord = Record<string, unknown>;

export type FieldType = "text" | "password" | "url" | "select" | "json" | "number" | "boolean" | "account";

/**
 * How the connect form renders one credential or config field. `account`
 * is a picker of the workspace's financial accounts (the value is its id).
 */
export type FieldSpec = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  help?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
};

export type ConnectorCapabilities = {
  /** Pulls records on a schedule or on demand (`fetch`). */
  sync: boolean;
  /** Receives signed webhook events (`verifyWebhook` + `parseWebhook`). */
  webhook: boolean;
  /** Imports files (statements) rather than connecting to a system. */
  import: boolean;
  /** Credentials can be checked before saving (`validate`). */
  testConnection: boolean;
};

/** What a connector knows about the connection it works for. Never includes secrets. */
export type ConnectionInfo = {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  accountId: string | null;
  projectId: string | null;
  createdAt: Date;
  timezone: string;
  baseCurrency: string;
};

export type ValidateResult =
  | { ok: true; message: string; details?: Record<string, unknown>; suggestedAccount?: SuggestedAccount }
  | { ok: false; message: string };

/** An account the connection can create when the user did not choose one. */
export type SuggestedAccount = {
  name: string;
  kind: "bank" | "mobile_wallet" | "digital_wallet" | "payment_processor";
  currency: string;
  provider: string;
  openingBalance?: number;
  openingDate?: string;
};

export type FetchContext<Config, Credentials> = {
  connection: ConnectionInfo;
  config: Config;
  credentials: Credentials;
  http: HttpClient;
  /** The clock; injectable so demo feeds and tests are deterministic. */
  now: Date;
  /** Private network targets are allowed only outside production when the config opts in. */
  allowPrivateNetwork: boolean;
};

export type FetchParams = {
  /** Where the previous page (or the previous sync) stopped; null the first time. */
  cursor: unknown;
  /** The last successful sync, for sources that filter by time. */
  since: Date | null;
  trigger: SyncTrigger;
};

export type FetchPage = {
  records: RawRecord[];
  /** Saved once this page is committed; the next page (or next sync) starts here. */
  nextCursor: unknown;
  hasMore: boolean;
};

export type WebhookRequest = {
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  secret: string;
  now: Date;
};

export type ParsedWebhook = {
  eventId: string;
  eventType: string;
  records: RawRecord[];
};

export type BuiltTestEvent = {
  headers: Record<string, string>;
  rawBody: Buffer;
  eventType: string;
};

/** Thrown by connectors for expected failures (bad credentials, HTTP errors); the message is shown. */
export class ConnectorError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.retryable = options.retryable ?? false;
  }
}

/**
 * A provider. Everything provider-specific lives in its connector; the sync
 * engine, webhooks and API only talk to this interface.
 *
 * `normalize` may return one canonical record, several (a Stripe charge is
 * revenue plus a fee), a `skip` record with a reason, or null to ignore the
 * raw record silently.
 */
export interface Connector<Config = Record<string, unknown>, Credentials = Record<string, string>> {
  id: string;
  displayName: string;
  category: ConnectorCategory;
  description: string;
  /** A lucide icon name. */
  icon: string;
  website?: string;
  capabilities: ConnectorCapabilities;
  credentialFields: FieldSpec[];
  configFields: FieldSpec[];
  credentialsSchema: z.ZodType<Credentials>;
  configSchema: z.ZodType<Config>;
  /** Records need an account to post; when none is chosen `suggestAccount` may create one. */
  requiresAccount: boolean;
  defaultSyncFrequency: "manual" | "hourly" | "daily";
  /** Upper bound on pages per sync run; more pages continue in a follow-up run. */
  maxPagesPerRun?: number;
  /** Credential field holding a provider-issued webhook signing secret (overrides the generated one). */
  webhookSecretCredential?: string;
  /** Shown on the webhook setup screen. */
  webhookDocs?: { signatureHeader: string; scheme: string; events: string[] };

  suggestAccount?(input: {
    credentials: Credentials;
    config: Config;
    validation?: ValidateResult;
    baseCurrency: string;
    today: string;
  }): SuggestedAccount | null;
  validate?(input: {
    credentials: Credentials;
    config: Config;
    http: HttpClient;
    now: Date;
    allowPrivateNetwork: boolean;
    connection?: ConnectionInfo;
  }): Promise<ValidateResult>;
  fetch?(ctx: FetchContext<Config, Credentials>, params: FetchParams): Promise<FetchPage>;
  normalize(raw: RawRecord, connection: ConnectionInfo & { config: Config }): CanonicalRecordInput | CanonicalRecordInput[] | null;
  verifyWebhook?(request: WebhookRequest): boolean;
  parseWebhook?(rawBody: Buffer, headers: Record<string, string | undefined>): ParsedWebhook;
  buildTestEvent?(input: { connection: ConnectionInfo & { config: Config }; secret: string; now: Date; eventType?: string }): BuiltTestEvent;
}

// biome-ignore lint/suspicious/noExplicitAny: the registry holds connectors of every config shape.
export type AnyConnector = Connector<any, any>;

export function defineConnector<Config, Credentials>(connector: Connector<Config, Credentials>): AnyConnector {
  return connector as AnyConnector;
}

/** Catalogue metadata for providers that are planned but not built. */
export type ComingSoonEntry = {
  id: string;
  displayName: string;
  category: ConnectorCategory;
  description: string;
  icon: string;
  website?: string;
  capabilities: ConnectorCapabilities;
};
