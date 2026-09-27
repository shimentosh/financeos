import { z } from "zod";
import { isDay } from "../dates.ts";

export const dayString = z.string().refine(isDay, "Expected a date as YYYY-MM-DD");
export const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter currency code")
  .transform((code) => code.toUpperCase());
/** Minor units, strictly positive. */
export const positiveMinor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Minor units, may be zero or negative (balances, adjustments). */
export const signedMinor = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const nonNegativeMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uuid = z.uuid();
export const optionalUuid = z.uuid().nullish();
/** Receipts and invoices uploaded through /files, linked to the transaction a request records. */
export const attachmentFileIds = z.array(uuid).max(10).optional();
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^\d+(\.\d{1,10})?$/.test(value) && Number(value) > 0, "Expected a positive decimal");
export const shortText = z.string().trim().max(200);
export const longText = z.string().trim().max(5000);

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Comma-separated or repeated query values as an array. */
export const listParam = <O>(item: z.ZodType<O, string>) =>
  z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : value.split(",").filter(Boolean)))
    .pipe(z.array(item).optional());

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type ApiError = {
  statusCode: number;
  error: string;
  message: string;
  issues?: Array<{ path: string; message: string }>;
};
