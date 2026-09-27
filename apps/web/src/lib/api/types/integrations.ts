import type { TransactionType } from "@expensewise/core";
import type { ApiKeyScope, ConnectorCategory, SyncStatus, SyncTrigger } from "@expensewise/core/contracts/integrations-extra";
import type { TransactionListItem } from "@/lib/api/types";

// Response shapes of the integrations endpoints: /integrations, /sync-runs,
// /webhooks, /imports, /api-keys and the public API. Request contracts live
// in @expensewise/core/contracts/integrations-extra.

export type { ApiKeyScope, ConnectorCategory, SyncStatus, SyncTrigger };

export type FieldType = "text" | "password" | "url" | "select" | "json" | "number" | "boolean" | "account";

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

export type Capabilities = { sync: boolean; webhook: boolean; import: boolean; testConnection: boolean };
export type SyncFrequency = "manual" | "hourly" | "daily";
export type TrustLevel = "trusted" | "review";

export type CatalogEntry = {
  provider: string;
  displayName: string;
  category: ConnectorCategory;
  description: string;
  icon: string;
  website: string | null;
  available: boolean;
  connectable: boolean;
  href: string | null;
  capabilities: Capabilities;
  requiresAccount: boolean;
  createsAccount: boolean;
  defaultSyncFrequency: SyncFrequency | null;
  credentialFields: FieldSpec[];
  configFields: FieldSpec[];
  webhook: { signatureHeader: string; scheme: string; events: string[] } | null;
};

export type ConnectionStatus = "connected" | "syncing" | "error" | "needs_attention" | "disconnected";
export type ConnectionHealth = "healthy" | "syncing" | "pending" | "stale" | "degraded" | "failing" | "disconnected";

export type ConnectionWebhook = {
  url: string | null;
  hasSecret: boolean;
  secretSource: "generated" | "provider";
  providerSecretSet: boolean | null;
  signatureHeader: string | null;
  scheme: string | null;
  events: string[];
  supportsTestEvent: boolean;
};

export type Connection = {
  id: string;
  provider: string;
  name: string;
  displayName: string;
  category: ConnectorCategory;
  icon: string;
  status: ConnectionStatus;
  health: ConnectionHealth;
  capabilities: Capabilities;
  accountId: string | null;
  accountName: string | null;
  accountCurrency: string | null;
  projectId: string | null;
  projectName: string | null;
  syncFrequency: SyncFrequency;
  trustLevel: TrustLevel;
  config: Record<string, unknown>;
  credentials: Array<{ key: string; label: string; set: boolean; masked: string | null }>;
  credentialsReadable: boolean;
  webhook: ConnectionWebhook | null;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  errorMessage: string | null;
  consecutiveFailures: number;
  recordsTotal: number;
  createdAt: string;
  updatedAt: string;
};

export type RunSummary = {
  id: string;
  connectionId: string;
  connectionName: string | null;
  provider: string | null;
  trigger: SyncTrigger;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  recordsFound: number;
  created: number;
  updated: number;
  skipped: number;
  duplicates: number;
  errors: number;
  needsReview: number;
  message: string | null;
  triggeredBy: string | null;
};

export type RunBalance = {
  accountId: string | null;
  balance: number;
  currency: string | null;
  asOf: string | null;
  bookBalance: number | null;
  difference: number | null;
};

export type RunDetail = RunSummary & {
  errorDetails: Array<{ externalId: string | null; message: string }>;
  skippedDetails: Array<{ externalId: string | null; message: string }>;
  reviewDetails: Array<{ externalId: string | null; message: string; transactionId: string | null }>;
  balances: RunBalance[];
  cursorBefore: unknown;
  cursorAfter: unknown;
};

export type WebhookEventView = {
  id: string;
  providerEventId: string | null;
  eventType: string;
  signatureValid: boolean;
  status: "received" | "processed" | "ignored" | "failed" | "duplicate";
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
};

export type ConnectionDetail = Connection & {
  stats: { transactions: { total: number; posted: number; draft: number; pending: number; void: number }; receivables: number };
  latestBalances: RunBalance[];
  recentRuns: RunSummary[];
  recentWebhookEvents: WebhookEventView[];
};

/** Shown once, when a webhook endpoint is created or rotated. */
export type WebhookReveal = { url: string; secret: string; secretSource: "generated" | "provider"; signatureHeader: string | null };

export type ConnectResult = {
  connection: Connection;
  webhook: WebhookReveal | null;
  initialSyncRunId: string | null;
  createdAccount: { id: string; name: string; currency: string } | null;
  validation: { ok: boolean; message: string } | null;
};

export type UpdateResult = { connection: Connection; webhook: WebhookReveal | null };
export type TestResult = { ok: boolean; message: string; details: Record<string, unknown> | null; checkedAt: string };
export type SyncStart = { runId: string | null; status: "queued" | "already_running" };
export type RemoveResult = { deleted: boolean; disconnected: boolean; reason: string | null; connection: Connection | null };
export type WebhookTestResult = {
  eventType: string;
  delivery: { status: "received" | "duplicate"; eventId: string; webhookEventId: string | null };
  processing: { status: WebhookEventView["status"]; run: RunDetail | null } | null;
};

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type RecordsPage = Page<TransactionListItem>;

// ------------------------------------------------------------------ imports

export type ImportStatus = "uploaded" | "mapped" | "previewed" | "importing" | "completed" | "failed" | "cancelled";
export type ImportRowStatus = "valid" | "invalid" | "duplicate" | "imported" | "skipped";

export type ImportMapping = Partial<
  Record<"date" | "description" | "merchant" | "amount" | "debit" | "credit" | "currency" | "category" | "reference" | "type" | "balance", string>
>;

export type DateFormat = "auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" | "DD-MM-YYYY" | "DD.MM.YYYY";
export type AmountSign = "negative_is_expense" | "positive_is_expense";

export type ImportOptions = {
  dateFormat?: DateFormat;
  amountSign?: AmountSign;
  defaultCurrency?: string;
  defaultCategoryId?: string | null;
  defaultProjectId?: string | null;
  skipRows?: number;
  sheet?: string;
};

export type ImportBatch = {
  id: string;
  filename: string;
  format: "csv" | "xlsx" | "pdf";
  status: ImportStatus;
  fileId: string | null;
  accountId: string | null;
  accountName: string | null;
  headers: string[];
  mapping: ImportMapping;
  options: ImportOptions;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ImportCounts = Record<ImportRowStatus, number>;
export type SampleRow = { rowNumber: number; raw: Record<string, string> };
export type SuggestedOptions = { dateFormat: DateFormat; amountSign: AmountSign; skipRows: number };

export type ImportUpload = {
  batch: ImportBatch;
  suggestedMapping: ImportMapping;
  suggestedOptions: SuggestedOptions;
  sampleRows: SampleRow[];
  detected: { headerRow: number; delimiter: string | null; sheet: string | null; sheets: string[]; sameFileAs: string | null };
};

export type ImportDetail = {
  batch: ImportBatch;
  suggestedMapping: ImportMapping;
  suggestedOptions: SuggestedOptions;
  sampleRows: SampleRow[];
  counts: ImportCounts;
};

export type NormalizedRow = {
  type: TransactionType;
  direction: "in" | "out";
  amount: number;
  signedAmount: number;
  currency: string;
  date: string;
  description: string | null;
  merchant: string | null;
  reference: string | null;
  categoryId: string | null;
  categoryHint: string | null;
  defaultCategoryId: string | null;
  projectId: string | null;
  balance: number | null;
  accountId: string;
  externalId: string;
  duplicateScore?: number;
  duplicateReasons?: string[];
};

export type ImportRow = {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  normalized: NormalizedRow | null;
  status: ImportRowStatus;
  error: string | null;
  duplicateOfId: string | null;
  transactionId: string | null;
};

export type ImportRowsPage = Page<ImportRow> & { counts: ImportCounts };
export type ImportSummary = { imported: number; drafts: number; skipped: number; duplicates: number; failed: number };
export type ImportCommitResult = { batch: ImportBatch; summary: ImportSummary | null; queued: boolean };

// ------------------------------------------------------------------ API keys

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  status: "active" | "revoked" | "expired";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  createdBy: string | null;
};

export type ApiKeyCreated = { apiKey: ApiKey; key: string };
