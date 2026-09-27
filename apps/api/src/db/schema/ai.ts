import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, decimal, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { files, workspaces } from "./core.js";
import { captureKind, captureStage, copilotRole, inboxKind, inboxStatus, narrativeSource, reportKind, severity } from "./enums.js";
import type { InboxData } from "./types.js";

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

/**
 * One piece of input — a screenshot, a receipt, a sentence, a recording — on
 * its way to becoming transactions. The extraction is kept as the model
 * returned it, so a suggestion can always be traced back to what was read.
 */
export const captures = pgTable(
  "capture",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: captureKind("kind").notNull(),
    stage: captureStage("stage").notNull().default("received"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    inputText: text("input_text"),
    provider: text("provider"),
    model: text("model"),
    extraction: jsonb("extraction").$type<Record<string, unknown>>(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    costUsd: decimal("cost_usd", 12, 6),
    isSubscription: boolean("is_subscription").notNull().default(false),
    draftTransactionIds: uuid("draft_transaction_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    processedAt: ts("processed_at"),
    confirmedAt: ts("confirmed_at"),
  },
  (t) => [index("capture_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/** Every model call: what it cost, how long it took, whether it worked. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: pk(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: decimal("cost_usd", 12, 6).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * Things that need a decision: possible duplicates, recurring charges,
 * anomalies, failed syncs, budget warnings, price changes. Each item carries
 * the ids of the records behind it, so nothing has to be taken on trust.
 */
export const inboxItems = pgTable(
  "inbox_item",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: inboxKind("kind").notNull(),
    status: inboxStatus("status").notNull().default("open"),
    severity: severity("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    data: jsonb("data").$type<InboxData>().notNull().default({}),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    dedupeKey: text("dedupe_key").notNull(),
    snoozedUntil: ts("snoozed_until"),
    resolvedAt: ts("resolved_at"),
    resolvedBy: text("resolved_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inbox_item_dedupe_idx").on(t.workspaceId, t.dedupeKey),
    index("inbox_item_workspace_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);

/**
 * A generated report. `data` is the structured snapshot computed from the
 * ledger; `narrative` explains it and may only restate numbers from `data`.
 */
export const reports = pgTable(
  "report",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: reportKind("kind").notNull(),
    periodStart: day("period_start").notNull(),
    periodEnd: day("period_end").notNull(),
    title: text("title").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    narrative: text("narrative"),
    narrativeSource: narrativeSource("narrative_source").notNull().default("template"),
    provider: text("provider"),
    model: text("model"),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("report_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const copilotThreads = pgTable(
  "copilot_thread",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("copilot_thread_user_idx").on(t.workspaceId, t.userId)],
);

export const copilotMessages = pgTable(
  "copilot_message",
  {
    id: pk(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => copilotThreads.id, { onDelete: "cascade" }),
    role: copilotRole("role").notNull(),
    content: text("content").notNull(),
    /** Tool calls, the query plans behind them, and source links. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("copilot_message_thread_idx").on(t.threadId, t.createdAt)],
);
