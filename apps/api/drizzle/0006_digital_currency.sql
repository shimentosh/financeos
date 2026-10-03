ALTER TYPE "public"."account_kind" ADD VALUE 'crypto_wallet';--> statement-breakpoint
ALTER TABLE "employee" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "payroll_run" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "base_currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "base_currency" SET DEFAULT 'BDT';--> statement-breakpoint
ALTER TABLE "exchange_rate" ALTER COLUMN "from_currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "exchange_rate" ALTER COLUMN "to_currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "financial_account" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "ledger_entry" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "base_currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "commitment_occurrence" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "commitment" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "goal" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "billing_payment" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "investment" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "liability" ALTER COLUMN "currency" SET DATA TYPE varchar(5);--> statement-breakpoint
ALTER TABLE "receivable" ALTER COLUMN "currency" SET DATA TYPE varchar(5);