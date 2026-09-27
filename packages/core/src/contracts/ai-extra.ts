import { z } from "zod";
import { INBOX_KINDS, type InboxKind, type Severity, type TransactionSource, type TransactionStatus, type TransactionType } from "../constants.ts";
import { currencyCode, dayString, longText, optionalUuid, positiveMinor, shortText, uuid } from "./common.ts";
import { confirmCaptureInput } from "./operations.ts";

// Contracts for the AI module: capture review, the AI Inbox, AI usage. Request
// schemas validate bodies and queries; the types below are the JSON shapes the
// API returns, shared with the web app.

const booleanParam = z.union([z.boolean(), z.enum(["true", "false", "1", "0"])]).transform((value) => value === true || value === "true" || value === "1");

// ------------------------------------------------------------------ captures

export const CAPTURE_UPLOAD_KINDS = ["screenshot", "receipt", "pdf"] as const;
export type CaptureUploadKind = (typeof CAPTURE_UPLOAD_KINDS)[number];

export const CAPTURE_KINDS = ["screenshot", "receipt", "text", "voice", "pdf", "email"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/**
 * received → processing → suggested (or failed) → confirmed (a person posted
 * it) / posted (auto-posted, high confidence) / discarded.
 */
export const CAPTURE_STAGES = ["received", "processing", "suggested", "confirmed", "posted", "failed", "discarded"] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];

/** Multipart fields sent with POST /captures (besides `file`). */
export const captureUploadFields = z.object({
  kind: z.enum(CAPTURE_UPLOAD_KINDS).optional(),
});

export const captureListQuery = z.object({
  stage: z
    .union([z.array(z.enum(CAPTURE_STAGES)), z.string()])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : value.split(",").filter(Boolean)))
    .pipe(z.array(z.enum(CAPTURE_STAGES)).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type CaptureListQuery = z.input<typeof captureListQuery>;

const confirmItem = confirmCaptureInput.shape.transactions.element;

/**
 * POST /captures/:id/confirm. A superset of `confirmCaptureInput`:
 * - an item with `id` confirms that draft (edited values win);
 * - an item without `id` is entered by hand (the file could not be read) and
 *   is posted with the capture's file attached;
 * - drafts of the capture that are not listed are discarded;
 * - `subscription`: an object creates subscription tracking linked to the
 *   posted expense, `null` declines, omitted = decide later (an AI Inbox item);
 * - `allowDuplicates`: confirm even though matching transactions exist.
 */
export const captureConfirmInput = confirmCaptureInput.extend({
  transactions: z
    .array(confirmItem.extend({ id: uuid.optional() }))
    .min(1)
    .max(50),
  allowDuplicates: z.boolean().default(false),
});
export type CaptureConfirmInput = z.input<typeof captureConfirmInput>;

export const captureRetryInput = z.object({
  /** Process even when the same file was captured before. */
  force: z.boolean().default(false),
  /** Queue it for the worker instead of waiting for the result. */
  background: z.boolean().default(false),
});

// --------------------------------------------------------------------- inbox

export const INBOX_STATUSES = ["open", "snoozed", "resolved", "dismissed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const inboxQuery = z.object({
  kind: z
    .union([z.array(z.enum(INBOX_KINDS)), z.string()])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : value.split(",").filter(Boolean)))
    .pipe(z.array(z.enum(INBOX_KINDS)).optional()),
  /** `open` includes snoozed items whose snooze has ended. */
  status: z.enum([...INBOX_STATUSES, "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type InboxQuery = z.input<typeof inboxQuery>;

/** POST /inbox/:id/duplicate — `first`/`second` are data.transactionIds[0]/[1]. */
export const inboxDuplicateInput = z.object({
  keep: z.enum(["both", "first", "second"]),
});

/** POST /inbox/:id/track — turn a recurring/subscription candidate into tracking. */
export const inboxTrackInput = z.object({
  kind: z.enum(["subscription", "commitment"]),
  name: shortText.optional(),
  amount: positiveMinor.optional(),
  currency: currencyCode.optional(),
  billingCycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly", "custom"]).optional(),
  nextRenewalDate: dayString.optional(),
  accountId: optionalUuid,
  categoryId: optionalUuid,
  projectId: optionalUuid,
  autoRenew: z.boolean().optional(),
  notes: longText.nullish(),
});
export type InboxTrackInput = z.input<typeof inboxTrackInput>;

export const uncategorizedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Posted in the last N days. */
  days: z.coerce.number().int().min(1).max(730).default(90),
  /** Ask the model for suggestions rules and merchant memory cannot make. */
  suggest: booleanParam.default(true),
});
export type UncategorizedQuery = z.input<typeof uncategorizedQuery>;

export const uncategorizedApplyInput = z.object({
  items: z
    .array(
      z.object({
        transactionId: uuid,
        categoryId: uuid,
        projectId: optionalUuid,
      }),
    )
    .min(1)
    .max(200),
});
export type UncategorizedApplyInput = z.input<typeof uncategorizedApplyInput>;

// ------------------------------------------------------------------ AI usage

export const aiUsageQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM")
    .optional(),
});

// ============================================================ response types

export type ConfidenceSource = "rule" | "merchant" | "ai" | "parser" | "user";
export type ConfidenceField =
  | "amount"
  | "currency"
  | "date"
  | "time"
  | "merchant"
  | "reference"
  | "type"
  | "category"
  | "account"
  | "project"
  | "workspace"
  | "subscription";

export type AiConfidenceView = {
  /** The weakest required field (amount, currency, date, type, account). */
  overall: number;
  fields: Partial<Record<ConfidenceField, number>>;
  sources?: Partial<Record<ConfidenceField, ConfidenceSource>>;
  model?: string;
};

export type BillingCycle = "monthly" | "quarterly" | "half_yearly" | "yearly" | "custom";

export type SubscriptionSuggestion = {
  provider: string;
  planName: string | null;
  billingCycle: BillingCycle | null;
  purchaseDate: string | null;
  startDate: string | null;
  nextRenewalDate: string | null;
  /** True when the renewal date was computed from the cycle, not read. */
  renewalDateEstimated: boolean;
  expiryDate: string | null;
  cancellationDeadline: string | null;
  /** null: the document does not say. */
  autoRenew: boolean | null;
  /** Minor units of `currency`. */
  renewalAmount: number | null;
  currency: string | null;
  confidence: number;
  source: "ai" | "heuristic";
  /** Which draft (index in `drafts`) is the purchase. */
  transactionIndex: number;
};

export type DuplicateCandidateView = {
  transactionId: string;
  score: number;
  exact: boolean;
  reasons: string[];
  transaction: {
    id: string;
    status: TransactionStatus;
    type: TransactionType;
    date: string;
    amount: number;
    currency: string;
    merchant: string | null;
    reference: string | null;
    accountId: string | null;
    source: TransactionSource;
  };
};

export type SuggestedRef = {
  id: string;
  name: string;
  source: ConfidenceSource;
  confidence: number;
};

export type CaptureDraftView = {
  transaction: {
    id: string;
    status: TransactionStatus;
    type: TransactionType;
    direction: "in" | "out";
    amount: number;
    currency: string;
    baseAmount: number | null;
    baseCurrency: string | null;
    date: string;
    occurredAt: string | null;
    merchant: string | null;
    counterpartyId: string | null;
    description: string | null;
    reference: string | null;
    accountId: string | null;
    accountName: string | null;
    categoryId: string | null;
    categoryName: string | null;
    projectId: string | null;
    projectName: string | null;
    reviewReason: string | null;
  };
  confidence: AiConfidenceView | null;
  /** Required fields that are absent: amount, date, account, type. */
  missing: ConfidenceField[];
  /** Fields present but below 0.8 confidence: show them for confirmation. */
  lowConfidence: ConfidenceField[];
  suggestions: {
    category: SuggestedRef | null;
    project: SuggestedRef | null;
    account: SuggestedRef | null;
    /** When the account is ambiguous: the accounts it could be. */
    accountCandidates: Array<{ id: string; name: string }>;
    /** Names the model/parser proposed that match nothing in the workspace. */
    unmatchedCategoryName: string | null;
    unmatchedProjectName: string | null;
  };
  extracted: {
    paymentMethod: string | null;
    fee: number | null;
    lineItems: Array<{
      description: string;
      amount: number | null;
      quantity: number | null;
    }>;
    notes: string[];
    ruleIds: string[];
  };
  duplicates: DuplicateCandidateView[];
  suggestedWorkspace: {
    kind: "personal" | "business";
    confidence: number;
    workspaceId: string | null;
    workspaceName: string | null;
  } | null;
  subscription: SubscriptionSuggestion | null;
};

export type CaptureView = {
  capture: {
    id: string;
    kind: CaptureKind;
    stage: CaptureStage;
    fileId: string | null;
    /** `/api/files/:fileId`, served inline for images and PDFs. */
    fileUrl: string | null;
    file: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
    } | null;
    inputText: string | null;
    /** How it was read: model, deterministic parser, nothing (manual entry), or not at all (duplicate file). */
    method: "ai" | "parser" | "manual" | "duplicate" | null;
    provider: string | null;
    model: string | null;
    /** Why the model was not used or did not help (budget, disabled, refusal...). */
    fallbackReason: string | null;
    error: string | null;
    /** A failed capture that is worth retrying (temporary provider problem). */
    retryable: boolean;
    durationMs: number | null;
    costUsd: number;
    isSubscription: boolean;
    notes: string[];
    createdAt: string;
    processedAt: string | null;
    confirmedAt: string | null;
  };
  /** The same file was captured before. */
  duplicateOf: {
    captureId: string;
    fileId: string;
    stage: CaptureStage;
    capturedAt: string;
    transactionIds: string[];
  } | null;
  drafts: CaptureDraftView[];
  /** Transactions the model saw but could not read an amount for. */
  unresolved: Array<{
    index: number;
    merchant: string | null;
    date: string | null;
    reason: string;
  }>;
  subscription: SubscriptionSuggestion | null;
  /** Transactions posted from this capture (after confirm or auto-post). */
  postedTransactionIds: string[];
};

export type CaptureListItem = {
  id: string;
  kind: CaptureKind;
  stage: CaptureStage;
  fileId: string | null;
  inputText: string | null;
  method: CaptureView["capture"]["method"];
  draftCount: number;
  isSubscription: boolean;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
};

export type CaptureConfirmResult = {
  capture: CaptureView;
  postedTransactionIds: string[];
  discardedTransactionIds: string[];
  subscription:
    | { status: "created"; subscriptionId: string; commitmentId: string }
    | { status: "failed"; message: string; inboxItemId: string | null }
    | { status: "deferred"; inboxItemId: string | null }
    | { status: "declined" }
    | { status: "none" };
};

export type InboxItemView = {
  id: string;
  kind: InboxKind;
  status: InboxStatus;
  severity: Severity;
  title: string;
  body: string | null;
  data: Record<string, unknown> & { transactionIds?: string[]; href?: string };
  entityType: string | null;
  entityId: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the UI can offer for this item. */
  actions: Array<
    | "resolve"
    | "dismiss"
    | "snooze"
    | "reopen"
    | "keep_both"
    | "keep_first"
    | "keep_second"
    | "track_subscription"
    | "track_commitment"
    | "view_transactions"
    | "open_capture"
  >;
};

export type InboxDraftView = {
  id: string;
  status: TransactionStatus;
  type: TransactionType;
  direction: "in" | "out";
  amount: number;
  currency: string;
  date: string;
  merchant: string | null;
  description: string | null;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  source: TransactionSource;
  reviewReason: string | null;
  confidence: AiConfidenceView | null;
  missing: ConfidenceField[];
  captureId: string | null;
  createdAt: string;
};

/** Every open item is counted in exactly one bucket, so the values add up to the inbox badge. */
export type InboxSummary = {
  /** Draft + pending transactions. */
  needsReview: number;
  /** Posted income/expense without a category in the last 90 days. */
  uncategorized: number;
  duplicates: number;
  /** Recurring and subscription candidates. */
  recurring: number;
  /** Anomalies and unusually large transactions. */
  anomalies: number;
  integrationErrors: number;
  /** Budget, forecast, price-change, renewal and overdue warnings. */
  warnings: number;
  observations: number;
};

export type InboxView = {
  summary: InboxSummary;
  drafts: InboxDraftView[];
  items: InboxItemView[];
};

export type UncategorizedItemView = {
  transaction: {
    id: string;
    type: TransactionType;
    direction: "in" | "out";
    amount: number;
    currency: string;
    baseAmount: number | null;
    date: string;
    merchant: string | null;
    description: string | null;
    counterpartyId: string | null;
    accountName: string | null;
    projectId: string | null;
  };
  suggestion: {
    categoryId: string;
    categoryName: string;
    projectId: string | null;
    projectName: string | null;
    source: ConfidenceSource;
    confidence: number;
  } | null;
};

export type UncategorizedView = {
  items: UncategorizedItemView[];
  total: number;
  ai: { used: boolean; reason: string | null; costUsd: number };
};

/** "credits": billing is on and the workspace owner has no AI credits left. */
export type AiUnavailableReason = "not_configured" | "disabled" | "budget" | "credits";

export type AiStatusView = {
  configured: boolean;
  provider: string;
  model: string | null;
  /** The workspace has AI turned on (settings.aiEnabled). */
  enabled: boolean;
  /** Configured, enabled and under budget right now. */
  available: boolean;
  reason: AiUnavailableReason | null;
  budget: {
    limitUsd: number | null;
    spentUsd: number;
    remainingUsd: number | null;
    source: "workspace" | "default";
  };
  spentThisMonth: number;
  /** The owner's AI credits when billing is on; null when this installation is not billed. */
  credits?: { allowance: number; remainingAllowance: number; balance: number; remaining: number; periodEnd: string } | null;
  features: {
    extraction: boolean;
    classification: boolean;
    narratives: boolean;
    copilot: boolean;
    textParser: boolean;
    duplicateDetection: boolean;
    recurringDetection: boolean;
    anomalyDetection: boolean;
  };
};

export type AiUsageReportView = {
  month: string;
  totals: {
    /** Every recorded call, including ones blocked before reaching the provider. */
    calls: number;
    /** Calls that reached the provider. */
    providerCalls: number;
    ok: number;
    errors: number;
    refusals: number;
    /** Blocked by the budget or because AI is off. */
    blocked: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    avgLatencyMs: number | null;
  };
  byFeature: Array<{
    feature: string;
    calls: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byModel: Array<{
    provider: string;
    model: string;
    calls: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byStatus: Record<string, number>;
  daily: Array<{ date: string; calls: number; costUsd: number }>;
  budget: AiStatusView["budget"] & { percentUsed: number | null };
  recent: Array<{
    id: string;
    feature: string;
    provider: string;
    model: string;
    status: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number | null;
    error: string | null;
    createdAt: string;
  }>;
};
