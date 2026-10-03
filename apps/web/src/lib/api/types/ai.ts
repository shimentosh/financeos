// Response shapes of the AI endpoints: /captures, /inbox, /ai/status,
// /ai/usage. The canonical types live in @financeos/core (shared with the
// API); this file re-exports them and adds the few shapes only the web uses.

export type {
  AiConfidenceView,
  AiStatusView,
  AiUsageReportView,
  BillingCycle,
  CaptureConfirmResult,
  CaptureDraftView,
  CaptureKind,
  CaptureListItem,
  CaptureStage,
  CaptureView,
  ConfidenceField,
  ConfidenceSource,
  DuplicateCandidateView,
  InboxDraftView,
  InboxItemView,
  InboxStatus,
  InboxSummary,
  InboxView,
  SubscriptionSuggestion,
  SuggestedRef,
  UncategorizedItemView,
  UncategorizedView,
} from "@financeos/core/contracts/ai-extra";

import type { CaptureListItem, InboxItemView } from "@financeos/core/contracts/ai-extra";

/** GET /captures */
export type CapturePage = { items: CaptureListItem[]; total: number; page: number; pageSize: number };

/** POST /inbox/:id/duplicate */
export type DuplicateResolution = { item: InboxItemView; voidedTransactionId: string | null };

/** POST /inbox/:id/track */
export type TrackResult = {
  item: InboxItemView;
  kind: "subscription" | "commitment";
  subscriptionId: string | null;
  commitmentId: string;
  purchaseTransactionId: string | null;
};

/** POST /inbox/uncategorized/apply and POST /transactions/bulk */
export type BulkResult = { updated?: number; changed?: number; failures: Array<{ transactionId?: string; id?: string; message: string }> };

/** The body of a 409 `possible_duplicate` from POST /captures/:id/confirm. */
export type DuplicateConflict = {
  index: number;
  matches: Array<{
    transactionId: string;
    score: number;
    exact: boolean;
    reasons: string[];
    date: string;
    amount: number;
    currency: string;
    merchant: string | null;
  }>;
};

/** Which inbox buckets a summary tile filters to. */
export type InboxShow = "all" | "drafts" | "uncategorized" | "duplicates" | "recurring" | "anomalies" | "integrations" | "warnings";
