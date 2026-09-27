CREATE TYPE "public"."account_kind" AS ENUM('bank', 'cash', 'mobile_wallet', 'card', 'digital_wallet', 'payment_processor', 'savings', 'loan', 'other');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'integration', 'ai', 'api');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('equipment', 'electronics', 'vehicle', 'property', 'land', 'jewelry', 'business_asset', 'other');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('owned', 'sold', 'disposed');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('monthly', 'quarterly', 'yearly', 'total');--> statement-breakpoint
CREATE TYPE "public"."capture_kind" AS ENUM('screenshot', 'receipt', 'text', 'voice', 'pdf', 'email');--> statement-breakpoint
CREATE TYPE "public"."capture_stage" AS ENUM('received', 'processing', 'suggested', 'confirmed', 'posted', 'failed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('expense', 'income');--> statement-breakpoint
CREATE TYPE "public"."commitment_frequency" AS ENUM('once', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."commitment_kind" AS ENUM('subscription', 'salary', 'payroll', 'rent', 'loan_payment', 'insurance', 'tax', 'utility', 'domain', 'hosting', 'software', 'contractor', 'education', 'income', 'custom');--> statement-breakpoint
CREATE TYPE "public"."commitment_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'syncing', 'error', 'needs_attention', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."copilot_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."counterparty_kind" AS ENUM('merchant', 'customer', 'vendor', 'person', 'employee', 'institution', 'other');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('full_time', 'part_time', 'contractor', 'intern');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('screenshot', 'receipt', 'statement', 'import', 'attachment', 'report', 'other');--> statement-breakpoint
CREATE TYPE "public"."goal_kind" AS ENUM('savings', 'emergency_fund', 'asset_purchase', 'business_capital', 'travel', 'investment', 'education', 'dream_asset', 'custom');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'achieved', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."import_format" AS ENUM('csv', 'xlsx', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('valid', 'invalid', 'duplicate', 'imported', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'mapped', 'previewed', 'importing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."inbox_kind" AS ENUM('duplicate', 'recurring_candidate', 'subscription_candidate', 'anomaly', 'integration_error', 'budget_warning', 'price_change', 'renewal', 'large_transaction', 'forecast_warning', 'receivable_overdue', 'observation');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('open', 'resolved', 'dismissed', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."interval_unit" AS ENUM('day', 'week', 'month', 'year');--> statement-breakpoint
CREATE TYPE "public"."investment_kind" AS ENUM('stock', 'mutual_fund', 'fixed_deposit', 'savings_certificate', 'bond', 'dps', 'gold', 'crypto', 'real_estate', 'business_equity', 'retirement', 'other');--> statement-breakpoint
CREATE TYPE "public"."investment_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."liability_kind" AS ENUM('loan', 'credit', 'personal_debt', 'business_debt', 'payable', 'mortgage', 'other');--> statement-breakpoint
CREATE TYPE "public"."liability_status" AS ENUM('active', 'paid_off', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."narrative_source" AS ENUM('ai', 'template');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('scheduled', 'paid', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'posted');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."rate_source" AS ENUM('manual', 'seed', 'api', 'transaction');--> statement-breakpoint
CREATE TYPE "public"."receivable_kind" AS ENUM('invoice', 'loan', 'other');--> statement-breakpoint
CREATE TYPE "public"."receivable_status" AS ENUM('pending', 'partially_paid', 'paid', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('weekly', 'monthly', 'quarterly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."rule_match" AS ENUM('all', 'any');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'success', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'active', 'renewal_due', 'renewed', 'cancellation_pending', 'cancelled', 'expired', 'paused');--> statement-breakpoint
CREATE TYPE "public"."sync_frequency" AS ENUM('manual', 'hourly', 'daily');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('initial', 'incremental', 'manual', 'scheduled', 'webhook', 'retry');--> statement-breakpoint
CREATE TYPE "public"."transaction_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('manual', 'screenshot', 'receipt', 'text', 'voice', 'csv', 'excel', 'pdf', 'integration', 'webhook', 'api', 'recurring', 'system');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('draft', 'pending', 'posted', 'void');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('expense', 'income', 'transfer', 'refund', 'adjustment', 'investment', 'asset_purchase', 'debt_payment', 'loan', 'equity');--> statement-breakpoint
CREATE TYPE "public"."trust_level" AS ENUM('trusted', 'review');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('received', 'processed', 'ignored', 'failed', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('personal', 'business');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"user_id" text,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "capture_kind" NOT NULL,
	"stage" "capture_stage" DEFAULT 'received' NOT NULL,
	"file_id" uuid,
	"input_text" text,
	"provider" text,
	"model" text,
	"extraction" jsonb,
	"error" text,
	"duration_ms" integer,
	"cost_usd" numeric(12, 6),
	"is_subscription" boolean DEFAULT false NOT NULL,
	"draft_transaction_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "copilot_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "copilot_role" NOT NULL,
	"content" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copilot_thread" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "inbox_kind" NOT NULL,
	"status" "inbox_status" DEFAULT 'open' NOT NULL,
	"severity" "severity" DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text NOT NULL,
	"snoozed_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "report_kind" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"title" text NOT NULL,
	"data" jsonb NOT NULL,
	"narrative" text,
	"narrative_source" "narrative_source" DEFAULT 'template' NOT NULL,
	"provider" text,
	"model" text,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"counterparty_id" uuid,
	"name" text NOT NULL,
	"title" text,
	"employment_type" "employment_type" DEFAULT 'full_time' NOT NULL,
	"salary" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"pay_day" integer DEFAULT 1 NOT NULL,
	"default_project_id" uuid,
	"account_id" uuid,
	"start_date" date,
	"end_date" date,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"gross" bigint NOT NULL,
	"deductions" bigint DEFAULT 0 NOT NULL,
	"net" bigint NOT NULL,
	"project_id" uuid,
	"account_id" uuid,
	"transaction_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "payroll_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"pay_date" date NOT NULL,
	"total_net" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) NOT NULL,
	"posted_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_run_period_unique" UNIQUE("workspace_id","period")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{read}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text,
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"source" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"kind" "file_kind" DEFAULT 'attachment' NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"workspace_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" "severity" DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"active_workspace_id" uuid,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"base_currency" varchar(3) DEFAULT 'BDT' NOT NULL,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid,
	"filename" text NOT NULL,
	"format" "import_format" NOT NULL,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"account_id" uuid,
	"headers" text[],
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb,
	"status" "import_row_status" DEFAULT 'valid' NOT NULL,
	"error" text,
	"duplicate_of_id" uuid,
	"transaction_id" uuid
);
--> statement-breakpoint
CREATE TABLE "integration_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"status" "connection_status" DEFAULT 'connected' NOT NULL,
	"credentials_encrypted" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"account_id" uuid,
	"project_id" uuid,
	"sync_frequency" "sync_frequency" DEFAULT 'daily' NOT NULL,
	"trust_level" "trust_level" DEFAULT 'review' NOT NULL,
	"sync_cursor" jsonb,
	"last_synced_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"error_message" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"records_total" integer DEFAULT 0 NOT NULL,
	"webhook_public_id" text,
	"webhook_secret_encrypted" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connection_webhook_public_id_unique" UNIQUE("webhook_public_id")
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" "sync_trigger" NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"records_found" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"error_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor_before" jsonb,
	"cursor_after" jsonb,
	"triggered_by" text
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"status" "webhook_event_status" DEFAULT 'received' NOT NULL,
	"payload" jsonb,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_event_unique" UNIQUE("connection_id","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "budget" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"period" "budget_period" DEFAULT 'monthly' NOT NULL,
	"amount" bigint NOT NULL,
	"category_id" uuid,
	"project_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date,
	"alert_threshold" integer DEFAULT 80 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "category_kind" NOT NULL,
	"parent_id" uuid,
	"icon" text,
	"color" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_name_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","kind","parent_id","name")
);
--> statement-breakpoint
CREATE TABLE "counterparty" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"kind" "counterparty_kind" DEFAULT 'merchant' NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"email" text,
	"phone" text,
	"default_category_id" uuid,
	"default_project_id" uuid,
	"default_account_id" uuid,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"date" date NOT NULL,
	"source" "rate_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"provider" text,
	"institution" text,
	"mask" text,
	"currency" varchar(3) NOT NULL,
	"opening_balance" bigint DEFAULT 0 NOT NULL,
	"opening_date" date NOT NULL,
	"credit_limit" bigint,
	"is_liability" boolean DEFAULT false NOT NULL,
	"include_in_net_worth" boolean DEFAULT true NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"color" text,
	"notes" text,
	"last_reconciled_at" timestamp with time zone,
	"last_reconciled_balance" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"base_amount" bigint NOT NULL,
	"date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"color" text,
	"description" text,
	"start_date" date,
	"end_date" date,
	"budget_amount" bigint,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match" "rule_match" DEFAULT 'all' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_processing" boolean DEFAULT false NOT NULL,
	"times_applied" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_attachment" (
	"transaction_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_attachment_transaction_id_file_id_pk" PRIMARY KEY("transaction_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"direction" "transaction_direction" NOT NULL,
	"status" "transaction_status" DEFAULT 'posted' NOT NULL,
	"account_id" uuid,
	"to_account_id" uuid,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"account_amount" bigint,
	"to_account_amount" bigint,
	"fx_rate" numeric(20, 10),
	"base_amount" bigint,
	"base_currency" varchar(3),
	"date" date NOT NULL,
	"occurred_at" timestamp with time zone,
	"merchant" text,
	"counterparty_id" uuid,
	"category_id" uuid,
	"project_id" uuid,
	"description" text,
	"notes" text,
	"reference" text,
	"source" "transaction_source" DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"external_id" text,
	"external_key" text,
	"connection_id" uuid,
	"attachment_file_id" uuid,
	"ai_confidence" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_basis" bigint,
	"liability_id" uuid,
	"receivable_id" uuid,
	"asset_id" uuid,
	"investment_id" uuid,
	"linked_transaction_id" uuid,
	"review_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	CONSTRAINT "transaction_amount_positive" CHECK ("transaction"."amount" > 0),
	CONSTRAINT "transaction_posted_complete" CHECK ("transaction"."status" <> 'posted' or ("transaction"."account_id" is not null and "transaction"."account_amount" is not null and "transaction"."base_amount" is not null)),
	CONSTRAINT "transaction_transfer_destination" CHECK ("transaction"."type" <> 'transfer' or "transaction"."status" <> 'posted' or ("transaction"."to_account_id" is not null and "transaction"."to_account_amount" is not null and "transaction"."to_account_id" <> "transaction"."account_id"))
);
--> statement-breakpoint
CREATE TABLE "commitment_occurrence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" "occurrence_status" DEFAULT 'scheduled' NOT NULL,
	"transaction_id" uuid,
	"paid_on" date,
	"paid_amount" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitment_occurrence_due_unique" UNIQUE("commitment_id","due_date")
);
--> statement-breakpoint
CREATE TABLE "commitment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "commitment_kind" NOT NULL,
	"direction" "transaction_direction" DEFAULT 'out' NOT NULL,
	"name" text NOT NULL,
	"counterparty_id" uuid,
	"payee" text,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"frequency" "commitment_frequency" NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"interval_unit" interval_unit,
	"start_date" date NOT NULL,
	"end_date" date,
	"next_due_date" date,
	"account_id" uuid,
	"category_id" uuid,
	"project_id" uuid,
	"liability_id" uuid,
	"auto_pay" boolean DEFAULT false NOT NULL,
	"status" "commitment_status" DEFAULT 'active' NOT NULL,
	"reminder_offsets" integer[],
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_contribution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"transaction_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "goal_kind" NOT NULL,
	"name" text NOT NULL,
	"target_amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"target_date" date,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"monthly_plan" bigint,
	"starting_amount" bigint DEFAULT 0 NOT NULL,
	"linked_account_id" uuid,
	"image_file_id" uuid,
	"icon" text,
	"notes" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"achieved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"plan_name" text,
	"purchase_date" date,
	"start_date" date,
	"trial_ends_on" date,
	"expiry_date" date,
	"cancellation_deadline" date,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"external_provider_id" text,
	"attachment_file_id" uuid,
	"cancelled_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_commitment_id_unique" UNIQUE("commitment_id")
);
--> statement-breakpoint
CREATE TABLE "asset_valuation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"value" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"purchase_price" bigint,
	"currency" varchar(3) NOT NULL,
	"purchase_date" date,
	"current_value" bigint NOT NULL,
	"valued_at" date,
	"owner" text,
	"project_id" uuid,
	"status" "asset_status" DEFAULT 'owned' NOT NULL,
	"sold_on" date,
	"sold_amount" bigint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_valuation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"investment_id" uuid NOT NULL,
	"value" bigint NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "investment_kind" NOT NULL,
	"institution" text,
	"currency" varchar(3) NOT NULL,
	"opened_on" date,
	"maturity_date" date,
	"interest_rate" numeric(7, 4),
	"opening_cost_basis" bigint DEFAULT 0 NOT NULL,
	"current_value" bigint,
	"valued_at" date,
	"status" "investment_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liability" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "liability_kind" NOT NULL,
	"name" text NOT NULL,
	"counterparty_id" uuid,
	"counterparty_name" text,
	"principal" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"opening_outstanding" bigint NOT NULL,
	"interest_rate" numeric(7, 4),
	"start_date" date,
	"due_date" date,
	"category_id" uuid,
	"project_id" uuid,
	"account_id" uuid,
	"status" "liability_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"external_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receivable" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "receivable_kind" DEFAULT 'invoice' NOT NULL,
	"counterparty_id" uuid,
	"counterparty_name" text NOT NULL,
	"title" text NOT NULL,
	"reference" text,
	"amount" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"status" "receivable_status" DEFAULT 'pending' NOT NULL,
	"project_id" uuid,
	"category_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_key" text,
	"connection_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture" ADD CONSTRAINT "capture_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_thread_id_copilot_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."copilot_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_thread" ADD CONSTRAINT "copilot_thread_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_thread" ADD CONSTRAINT "copilot_thread_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD CONSTRAINT "inbox_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_counterparty_id_counterparty_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_default_project_id_project_id_fk" FOREIGN KEY ("default_project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_run_id_payroll_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploaded_by_auth_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_active_workspace_id_workspace_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_default_category_id_category_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_default_project_id_project_id_fk" FOREIGN KEY ("default_project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_default_account_id_financial_account_id_fk" FOREIGN KEY ("default_account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_attachment" ADD CONSTRAINT "transaction_attachment_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_attachment" ADD CONSTRAINT "transaction_attachment_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_to_account_id_financial_account_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."financial_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_counterparty_id_counterparty_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_attachment_file_id_file_id_fk" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_liability_id_liability_id_fk" FOREIGN KEY ("liability_id") REFERENCES "public"."liability"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_receivable_id_receivable_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."receivable"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_investment_id_investment_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."investment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_linked_transaction_id_transaction_id_fk" FOREIGN KEY ("linked_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_occurrence" ADD CONSTRAINT "commitment_occurrence_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_occurrence" ADD CONSTRAINT "commitment_occurrence_commitment_id_commitment_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_occurrence" ADD CONSTRAINT "commitment_occurrence_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_counterparty_id_counterparty_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_liability_id_liability_id_fk" FOREIGN KEY ("liability_id") REFERENCES "public"."liability"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contribution" ADD CONSTRAINT "goal_contribution_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contribution" ADD CONSTRAINT "goal_contribution_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contribution" ADD CONSTRAINT "goal_contribution_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contribution" ADD CONSTRAINT "goal_contribution_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_linked_account_id_financial_account_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_commitment_id_commitment_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_attachment_file_id_file_id_fk" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_valuation" ADD CONSTRAINT "investment_valuation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_valuation" ADD CONSTRAINT "investment_valuation_investment_id_investment_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."investment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_counterparty_id_counterparty_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable" ADD CONSTRAINT "receivable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable" ADD CONSTRAINT "receivable_counterparty_id_counterparty_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparty"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable" ADD CONSTRAINT "receivable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable" ADD CONSTRAINT "receivable_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable" ADD CONSTRAINT "receivable_connection_id_integration_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_workspace_idx" ON "ai_usage" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "capture_workspace_idx" ON "capture" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "copilot_message_thread_idx" ON "copilot_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "copilot_thread_user_idx" ON "copilot_thread" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_item_dedupe_idx" ON "inbox_item" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "inbox_item_workspace_status_idx" ON "inbox_item" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "report_workspace_idx" ON "report" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "employee_workspace_idx" ON "employee" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "payroll_item_run_idx" ON "payroll_item" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "api_key_workspace_idx" ON "api_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "domain_event_pending_idx" ON "domain_event" USING btree ("created_at") WHERE processed_at is null;--> statement-breakpoint
CREATE INDEX "domain_event_workspace_idx" ON "domain_event" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "file_workspace_sha_idx" ON "file" USING btree ("workspace_id","sha256");--> statement-breakpoint
CREATE INDEX "job_status_run_at_idx" ON "job" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupe_active_idx" ON "job" USING btree ("dedupe_key") WHERE dedupe_key is not null and status in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_idx" ON "notification" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_unique" ON "workspace_member" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_member_user_idx" ON "workspace_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "import_batch_workspace_idx" ON "import_batch" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "import_row_batch_idx" ON "import_row" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "integration_connection_workspace_idx" ON "integration_connection" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_run_connection_idx" ON "sync_run" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_run_workspace_idx" ON "sync_run" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "webhook_event_workspace_idx" ON "webhook_event" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "budget_workspace_idx" ON "budget" USING btree ("workspace_id","active");--> statement-breakpoint
CREATE INDEX "category_workspace_idx" ON "category" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_name_unique" ON "counterparty" USING btree ("workspace_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rate_unique" ON "exchange_rate" USING btree ("workspace_id","from_currency","to_currency","date");--> statement-breakpoint
CREATE INDEX "financial_account_workspace_idx" ON "financial_account" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "ledger_entry_account_date_idx" ON "ledger_entry" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "ledger_entry_workspace_date_idx" ON "ledger_entry" USING btree ("workspace_id","date");--> statement-breakpoint
CREATE INDEX "ledger_entry_transaction_idx" ON "ledger_entry" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "project_workspace_idx" ON "project" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "rule_workspace_idx" ON "rule" USING btree ("workspace_id","enabled","priority");--> statement-breakpoint
CREATE INDEX "transaction_workspace_date_idx" ON "transaction" USING btree ("workspace_id","date");--> statement-breakpoint
CREATE INDEX "transaction_workspace_status_idx" ON "transaction" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "transaction_workspace_type_date_idx" ON "transaction" USING btree ("workspace_id","type","date");--> statement-breakpoint
CREATE INDEX "transaction_account_date_idx" ON "transaction" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "transaction_category_date_idx" ON "transaction" USING btree ("category_id","date");--> statement-breakpoint
CREATE INDEX "transaction_project_date_idx" ON "transaction" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "transaction_counterparty_idx" ON "transaction" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "transaction_workspace_source_idx" ON "transaction" USING btree ("workspace_id","source");--> statement-breakpoint
CREATE INDEX "transaction_workspace_created_idx" ON "transaction" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "transaction_workspace_reference_idx" ON "transaction" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "transaction_connection_idx" ON "transaction" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_external_key_idx" ON "transaction" USING btree ("workspace_id","external_key") WHERE external_key is not null;--> statement-breakpoint
CREATE INDEX "commitment_occurrence_workspace_idx" ON "commitment_occurrence" USING btree ("workspace_id","status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "commitment_occurrence_transaction_idx" ON "commitment_occurrence" USING btree ("transaction_id") WHERE transaction_id is not null;--> statement-breakpoint
CREATE INDEX "commitment_workspace_due_idx" ON "commitment" USING btree ("workspace_id","status","next_due_date");--> statement-breakpoint
CREATE INDEX "commitment_workspace_kind_idx" ON "commitment" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "commitment_project_idx" ON "commitment" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "goal_contribution_goal_idx" ON "goal_contribution" USING btree ("goal_id","date");--> statement-breakpoint
CREATE INDEX "goal_workspace_idx" ON "goal" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "subscription_workspace_idx" ON "subscription" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "asset_valuation_asset_date_idx" ON "asset_valuation" USING btree ("asset_id","date");--> statement-breakpoint
CREATE INDEX "asset_workspace_idx" ON "asset" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "investment_valuation_investment_date_idx" ON "investment_valuation" USING btree ("investment_id","date");--> statement-breakpoint
CREATE INDEX "investment_workspace_idx" ON "investment" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "liability_workspace_idx" ON "liability" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "liability_external_key_idx" ON "liability" USING btree ("workspace_id","external_key") WHERE external_key is not null;--> statement-breakpoint
CREATE INDEX "receivable_workspace_status_idx" ON "receivable" USING btree ("workspace_id","status","due_date");--> statement-breakpoint
CREATE INDEX "receivable_project_idx" ON "receivable" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receivable_external_key_idx" ON "receivable" USING btree ("workspace_id","external_key") WHERE external_key is not null;