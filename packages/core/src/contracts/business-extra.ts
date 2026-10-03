import { z } from "zod";
import { dayString, uuid } from "./common.ts";
import { employeeInput } from "./operations.ts";

// Request shapes for the business API that the base contracts do not cover.

const PRESETS = [
  "this_month",
  "last_month",
  "last_30_days",
  "last_90_days",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "last_12_months",
  "all_time",
] as const;

/**
 * A reporting range: explicit `from`/`to`, or a preset. Project finance
 * defaults to the project's whole life; revenue to the last 12 months.
 */
export const financeRangeQuery = z
  .object({
    from: dayString.optional(),
    to: dayString.optional(),
    preset: z.enum(PRESETS).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, { message: "`from` must be on or before `to`", path: ["from"] });
export type FinanceRangeQuery = z.input<typeof financeRangeQuery>;

/** An employee, optionally with a monthly payroll commitment on their pay day. */
export const employeeCreateInput = employeeInput.extend({
  createSalaryCommitment: z.boolean().default(false),
});
export type EmployeeCreateInput = z.input<typeof employeeCreateInput>;

export const employeeQuery = z.object({
  status: z.enum(["active", "inactive", "all"]).default("all"),
  /** Only the people whose cost belongs to this project. */
  projectId: uuid.optional(),
});

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a month as YYYY-MM");

/** Pays one employee for one month, with the proof of payment. */
export const employeePayInput = z.object({
  period,
  paidOn: dayString,
  /** Minor units in the employee's salary currency; defaults to their salary. */
  amount: z.number().int().positive().optional(),
  /** Defaults to the employee's own "paid from" account. */
  accountId: uuid.nullish(),
  attachmentFileIds: z.array(uuid).min(1, "Attach the payment screenshot").max(10),
  note: z.string().trim().max(500).nullish(),
});
export type EmployeePayInput = z.input<typeof employeePayInput>;

export const employeeUnpayInput = z.object({ period });
