import { type AnyPgColumn, boolean, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { files, workspaces } from "./core.js";
import {
  connectionStatus,
  importFormat,
  importRowStatus,
  importStatus,
  syncFrequency,
  syncStatus,
  syncTrigger,
  trustLevel,
  webhookEventStatus,
} from "./enums.js";
import { financialAccounts, projects } from "./ledger.js";
import type { ConnectionConfig, ImportMapping, ImportOptions, SyncErrorDetail } from "./types.js";

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

/**
 * One connected external system. Provider-specific behaviour lives in the
 * connector; this row holds only its state, configuration and (encrypted)
 * credentials.
 */
export const integrationConnections = pgTable(
  "integration_connection",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    status: connectionStatus("status").notNull().default("connected"),
    /** AES-256-GCM ciphertext. Never sent to the browser. */
    credentialsEncrypted: text("credentials_encrypted"),
    config: jsonb("config").$type<ConnectionConfig>().notNull().default({}),
    /** Where records land when the source does not name an account. */
    accountId: uuid("account_id").references((): AnyPgColumn => financialAccounts.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    syncFrequency: syncFrequency("sync_frequency").notNull().default("daily"),
    /** `trusted` posts records directly; `review` stages them as drafts. */
    trustLevel: trustLevel("trust_level").notNull().default("review"),
    syncCursor: jsonb("sync_cursor"),
    lastSyncedAt: ts("last_synced_at"),
    lastSuccessAt: ts("last_success_at"),
    lastErrorAt: ts("last_error_at"),
    errorMessage: text("error_message"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    recordsTotal: integer("records_total").notNull().default(0),
    /** The unguessable id in this connection's webhook URL. */
    webhookPublicId: text("webhook_public_id").unique(),
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("integration_connection_workspace_idx").on(t.workspaceId)],
);

export const syncRuns = pgTable(
  "sync_run",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    trigger: syncTrigger("trigger").notNull(),
    status: syncStatus("status").notNull().default("running"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    recordsFound: integer("records_found").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    errorDetails: jsonb("error_details").$type<SyncErrorDetail[]>().notNull().default([]),
    cursorBefore: jsonb("cursor_before"),
    cursorAfter: jsonb("cursor_after"),
    triggeredBy: text("triggered_by"),
  },
  (t) => [index("sync_run_connection_idx").on(t.connectionId, t.startedAt), index("sync_run_workspace_idx").on(t.workspaceId, t.startedAt)],
);

export const webhookEvents = pgTable(
  "webhook_event",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    status: webhookEventStatus("status").notNull().default("received"),
    payload: jsonb("payload"),
    error: text("error"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    // Idempotency: a provider retrying the same event is recognised.
    unique("webhook_event_unique").on(t.connectionId, t.providerEventId),
    index("webhook_event_workspace_idx").on(t.workspaceId, t.receivedAt),
  ],
);

export const importBatches = pgTable(
  "import_batch",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    format: importFormat("format").notNull(),
    status: importStatus("status").notNull().default("uploaded"),
    accountId: uuid("account_id").references(() => financialAccounts.id, {
      onDelete: "set null",
    }),
    headers: text("headers").array(),
    mapping: jsonb("mapping").$type<ImportMapping>().notNull().default({}),
    options: jsonb("options").$type<ImportOptions>().notNull().default({}),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    invalidRows: integer("invalid_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("import_batch_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const importRows = pgTable(
  "import_row",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    normalized: jsonb("normalized").$type<Record<string, unknown>>(),
    status: importRowStatus("status").notNull().default("valid"),
    error: text("error"),
    duplicateOfId: uuid("duplicate_of_id"),
    transactionId: uuid("transaction_id"),
  },
  (t) => [index("import_row_batch_idx").on(t.batchId, t.rowNumber)],
);
