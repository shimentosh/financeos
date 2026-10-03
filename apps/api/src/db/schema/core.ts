import type { StorageBackend } from "@financeos/core";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { createdAt, currency, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { actorType, fileKind, jobStatus, memberRole, severity, workspaceKind } from "./enums.js";
import type { UserPreferences, WorkspaceSettings } from "./types.js";

/**
 * The isolation boundary. Every financial row carries a workspace id and every
 * query filters by the workspace resolved from the session, never from input.
 */
export const workspaces = pgTable("workspace", {
  id: pk(),
  name: text("name").notNull(),
  kind: workspaceKind("kind").notNull(),
  baseCurrency: currency("base_currency").notNull().default("BDT"),
  timezone: text("timezone").notNull().default("Asia/Dhaka"),
  /** 1 = January. Bangladesh's fiscal year starts in July (7). */
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMembers = pgTable(
  "workspace_member",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workspace_member_unique").on(t.workspaceId, t.userId), index("workspace_member_user_idx").on(t.userId)],
);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  activeWorkspaceId: uuid("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  preferences: jsonb("preferences").$type<UserPreferences>().notNull().default({}),
  updatedAt: updatedAt(),
});

/**
 * Metadata for an object in storage. The bytes live in object storage; this
 * row is what access checks run against.
 */
export const files = pgTable(
  "file",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    /** Where the bytes are; null for files saved before this was recorded (the .env driver). */
    storageBackend: text("storage_backend").$type<StorageBackend>(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    kind: fileKind("kind").notNull().default("attachment"),
    uploadedBy: text("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("file_workspace_sha_idx").on(t.workspaceId, t.sha256)],
);

export const auditLogs = pgTable(
  "audit_log",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorType: actorType("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    source: text("source"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt), index("audit_log_entity_idx").on(t.entityType, t.entityId)],
);

export const apiKeys = pgTable(
  "api_key",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters of the key, shown so a key can be recognised. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the full key. The key itself is shown once and never stored. */
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default(sql`'{read}'::text[]`),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_key_workspace_idx").on(t.workspaceId)],
);

/** Fixed-window counters, shared by every app instance through the database. */
export const rateLimits = pgTable("rate_limit", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

/**
 * The job queue. Workers claim rows with FOR UPDATE SKIP LOCKED, so any number
 * of workers can run against one database.
 */
export const jobs = pgTable(
  "job",
  {
    id: pk(),
    type: text("type").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    /** At most one queued or running job per key. */
    dedupeKey: text("dedupe_key"),
    result: jsonb("result"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("job_status_run_at_idx").on(t.status, t.runAt),
    uniqueIndex("job_dedupe_active_idx").on(t.dedupeKey).where(sql`dedupe_key is not null and status in ('queued', 'running')`),
  ],
);

/**
 * The outbox for domain events (transaction.created, integration.synced, ...),
 * written in the same database transaction as the change they describe.
 */
export const domainEvents = pgTable(
  "domain_event",
  {
    id: pk(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actorId: text("actor_id"),
    createdAt: createdAt(),
    processedAt: ts("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    index("domain_event_pending_idx").on(t.createdAt).where(sql`processed_at is null`),
    index("domain_event_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const notifications = pgTable(
  "notification",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    severity: severity("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    /** One notification per user per key: reminders never repeat themselves. */
    dedupeKey: text("dedupe_key").notNull(),
    readAt: ts("read_at"),
    emailedAt: ts("emailed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notification_dedupe_idx").on(t.userId, t.dedupeKey), index("notification_user_idx").on(t.userId, t.readAt, t.createdAt)],
);

/**
 * Settings for the whole installation, changed by platform admins (the AI provider,
 * for one). Secrets inside `value` are stored encrypted, never in plain text.
 */
export const platformSettings = pgTable("platform_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});
