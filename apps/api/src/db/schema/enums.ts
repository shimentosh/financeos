import {
  ACCOUNT_KINDS,
  ASSET_KINDS,
  ASSET_STATUSES,
  BUDGET_PERIODS,
  CATEGORY_KINDS,
  COMMITMENT_KINDS,
  COMMITMENT_STATUSES,
  COUNTERPARTY_KINDS,
  DIRECTIONS,
  FREQUENCIES,
  GOAL_KINDS,
  GOAL_STATUSES,
  INBOX_KINDS,
  INTERVAL_UNITS,
  INVESTMENT_KINDS,
  LIABILITY_KINDS,
  LIABILITY_STATUSES,
  MEMBER_ROLES,
  OCCURRENCE_STATUSES,
  PRIORITIES,
  PROJECT_STATUSES,
  RECEIVABLE_KINDS,
  RECEIVABLE_STATUSES,
  SEVERITIES,
  SUBSCRIPTION_STATUSES,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  WORKSPACE_KINDS,
} from "@financeos/core";
import { pgEnum } from "drizzle-orm/pg-core";

// Every enum lives here, with no table imports, so schema modules can reference
// each other's tables without an import cycle reaching an enum too early. The
// values come from @financeos/core: schema, API contracts and UI share them.

export const workspaceKind = pgEnum("workspace_kind", WORKSPACE_KINDS);
export const memberRole = pgEnum("member_role", MEMBER_ROLES);
export const accountKind = pgEnum("account_kind", ACCOUNT_KINDS);
export const accountStatus = pgEnum("account_status", ["active", "archived"]);
export const categoryKind = pgEnum("category_kind", CATEGORY_KINDS);
export const counterpartyKind = pgEnum("counterparty_kind", COUNTERPARTY_KINDS);
export const projectStatus = pgEnum("project_status", PROJECT_STATUSES);

export const transactionType = pgEnum("transaction_type", TRANSACTION_TYPES);
export const transactionDirection = pgEnum("transaction_direction", DIRECTIONS);
/**
 * draft: suggested (AI, rule, import) and awaiting the user's confirmation.
 * pending: waiting on something else (a large amount, an unvalidated import).
 * posted: in the ledger. void: reversed; kept for the audit trail.
 * Only posted transactions have ledger entries.
 */
export const transactionStatus = pgEnum("transaction_status", TRANSACTION_STATUSES);
export const transactionSource = pgEnum("transaction_source", TRANSACTION_SOURCES);

export const fileKind = pgEnum("file_kind", ["screenshot", "receipt", "statement", "import", "attachment", "report", "other"]);
export const rateSource = pgEnum("rate_source", ["manual", "seed", "api", "transaction"]);
export const ruleMatch = pgEnum("rule_match", ["all", "any"]);
export const budgetPeriod = pgEnum("budget_period", BUDGET_PERIODS);

export const commitmentKind = pgEnum("commitment_kind", COMMITMENT_KINDS);
export const commitmentFrequency = pgEnum("commitment_frequency", FREQUENCIES);
export const intervalUnit = pgEnum("interval_unit", INTERVAL_UNITS);
export const commitmentStatus = pgEnum("commitment_status", COMMITMENT_STATUSES);
export const subscriptionStatus = pgEnum("subscription_status", SUBSCRIPTION_STATUSES);
export const occurrenceStatus = pgEnum("occurrence_status", OCCURRENCE_STATUSES);

export const receivableKind = pgEnum("receivable_kind", RECEIVABLE_KINDS);
export const receivableStatus = pgEnum("receivable_status", RECEIVABLE_STATUSES);
export const liabilityKind = pgEnum("liability_kind", LIABILITY_KINDS);
export const liabilityStatus = pgEnum("liability_status", LIABILITY_STATUSES);
export const assetKind = pgEnum("asset_kind", ASSET_KINDS);
export const assetStatus = pgEnum("asset_status", ASSET_STATUSES);
export const investmentKind = pgEnum("investment_kind", INVESTMENT_KINDS);
export const investmentStatus = pgEnum("investment_status", ["active", "closed"]);

export const goalKind = pgEnum("goal_kind", GOAL_KINDS);
export const goalStatus = pgEnum("goal_status", GOAL_STATUSES);
export const priority = pgEnum("priority", PRIORITIES);

export const employmentType = pgEnum("employment_type", ["full_time", "part_time", "contractor", "intern"]);
export const employeeStatus = pgEnum("employee_status", ["active", "inactive"]);
export const payrollRunStatus = pgEnum("payroll_run_status", ["draft", "posted"]);

export const connectionStatus = pgEnum("connection_status", ["connected", "syncing", "error", "needs_attention", "disconnected"]);
export const syncFrequency = pgEnum("sync_frequency", ["manual", "hourly", "daily"]);
export const trustLevel = pgEnum("trust_level", ["trusted", "review"]);
export const syncTrigger = pgEnum("sync_trigger", ["initial", "incremental", "manual", "scheduled", "webhook", "retry"]);
export const syncStatus = pgEnum("sync_status", ["running", "succeeded", "partial", "failed"]);
export const webhookEventStatus = pgEnum("webhook_event_status", ["received", "processed", "ignored", "failed", "duplicate"]);

export const importFormat = pgEnum("import_format", ["csv", "xlsx", "pdf"]);
export const importStatus = pgEnum("import_status", ["uploaded", "mapped", "previewed", "importing", "completed", "failed", "cancelled"]);
export const importRowStatus = pgEnum("import_row_status", ["valid", "invalid", "duplicate", "imported", "skipped"]);

export const captureKind = pgEnum("capture_kind", ["screenshot", "receipt", "text", "voice", "pdf", "email"]);
export const captureStage = pgEnum("capture_stage", ["received", "processing", "suggested", "confirmed", "posted", "failed", "discarded"]);

export const inboxKind = pgEnum("inbox_kind", INBOX_KINDS);
export const inboxStatus = pgEnum("inbox_status", ["open", "resolved", "dismissed", "snoozed"]);
export const severity = pgEnum("severity", SEVERITIES);

export const reportKind = pgEnum("report_kind", ["weekly", "monthly", "quarterly", "custom"]);
export const narrativeSource = pgEnum("narrative_source", ["ai", "template"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "dead"]);
export const actorType = pgEnum("actor_type", ["user", "system", "integration", "ai", "api"]);
export const copilotRole = pgEnum("copilot_role", ["user", "assistant"]);
