import { z } from "zod";
import { currencyCode, dayString, longText, nonNegativeMinor, optionalUuid, positiveMinor, shortText, uuid } from "./common.ts";

// ------------------------------------------------------------------ payroll

export const employeeInput = z.object({
  name: z.string().trim().min(1).max(120),
  title: shortText.nullish(),
  employmentType: z.enum(["full_time", "part_time", "contractor", "intern"]).default("full_time"),
  salary: positiveMinor,
  currency: currencyCode,
  payDay: z.number().int().min(1).max(28).default(1),
  defaultProjectId: optionalUuid,
  accountId: optionalUuid,
  startDate: dayString.nullish(),
  endDate: dayString.nullish(),
  notes: longText.nullish(),
});
export const employeeUpdate = employeeInput.partial().extend({ status: z.enum(["active", "inactive"]).optional() });

export const payrollRunInput = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM"),
  payDate: dayString,
});
export const payrollItemUpdate = z.object({
  gross: positiveMinor.optional(),
  deductions: nonNegativeMinor.optional(),
  projectId: optionalUuid,
  accountId: optionalUuid,
  note: shortText.nullish(),
});

// ------------------------------------------------------------- integrations

export const connectInput = z.object({
  provider: z.string().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  credentials: z.record(z.string(), z.string()).default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  accountId: optionalUuid,
  projectId: optionalUuid,
  syncFrequency: z.enum(["manual", "hourly", "daily"]).default("daily"),
  trustLevel: z.enum(["trusted", "review"]).default("review"),
});
export type ConnectInput = z.input<typeof connectInput>;
export const connectionUpdate = connectInput.partial().omit({ provider: true });

export const importMappingInput = z.object({
  accountId: uuid,
  mapping: z.object({
    date: z.string().optional(),
    description: z.string().optional(),
    merchant: z.string().optional(),
    amount: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    currency: z.string().optional(),
    category: z.string().optional(),
    reference: z.string().optional(),
    type: z.string().optional(),
  }),
  options: z
    .object({
      dateFormat: z.enum(["auto", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "DD.MM.YYYY"]).default("auto"),
      amountSign: z.enum(["negative_is_expense", "positive_is_expense"]).default("negative_is_expense"),
      defaultCurrency: currencyCode.optional(),
      defaultCategoryId: optionalUuid,
      defaultProjectId: optionalUuid,
      skipRows: z.number().int().min(0).max(50).default(0),
    })
    .default({ dateFormat: "auto", amountSign: "negative_is_expense", skipRows: 0 }),
});

export const apiKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.enum(["read", "write"]))
    .min(1)
    .default(["read"]),
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
});

// ----------------------------------------------------------------------- ai

export const textCaptureInput = z.object({
  text: z.string().trim().min(2).max(4000),
  kind: z.enum(["text", "voice"]).default("text"),
});

export const confirmCaptureInput = z.object({
  transactions: z
    .array(
      z.object({
        id: uuid,
        type: z.enum(["expense", "income", "transfer", "refund", "investment", "asset_purchase", "debt_payment", "loan", "equity", "adjustment"]),
        direction: z.enum(["in", "out"]).optional(),
        accountId: uuid,
        toAccountId: optionalUuid,
        amount: positiveMinor,
        currency: currencyCode,
        accountAmount: positiveMinor.nullish(),
        toAccountAmount: positiveMinor.nullish(),
        date: dayString,
        merchant: shortText.nullish(),
        categoryId: optionalUuid,
        projectId: optionalUuid,
        description: shortText.nullish(),
        reference: shortText.nullish(),
        notes: longText.nullish(),
      }),
    )
    .min(1),
  /** Create subscription tracking for a detected subscription. */
  subscription: z
    .object({
      provider: shortText,
      planName: shortText.nullish(),
      billingCycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly", "custom"]),
      nextRenewalDate: dayString,
      expiryDate: dayString.nullish(),
      cancellationDeadline: dayString.nullish(),
      autoRenew: z.boolean().default(true),
      renewalAmount: positiveMinor.optional(),
    })
    .nullish(),
  /** Remember this merchant → category for next time. */
  rememberMerchant: z.boolean().default(true),
});
export type ConfirmCaptureInput = z.input<typeof confirmCaptureInput>;

export const reportGenerateInput = z.object({
  kind: z.enum(["weekly", "monthly", "quarterly", "custom"]),
  from: dayString.optional(),
  to: dayString.optional(),
  withNarrative: z.boolean().default(true),
});

export const inboxActionInput = z.object({
  action: z.enum(["resolve", "dismiss", "snooze", "reopen"]),
  snoozeDays: z.number().int().min(1).max(90).optional(),
});
