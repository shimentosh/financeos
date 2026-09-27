import { z } from "zod";
import { ASSET_KINDS, INVESTMENT_KINDS, LIABILITY_KINDS, LIABILITY_STATUSES, RECEIVABLE_KINDS, RECEIVABLE_STATUSES } from "../constants.ts";
import { dayString, listParam, nonNegativeMinor, optionalUuid, shortText } from "./common.ts";
import { liabilityPaymentInput } from "./planning.ts";

// Request shapes for the wealth API that the base contracts do not cover:
// list filters, selling an asset, and the payment options of a liability.

/** "true"/"false"/"1"/"0" from a query string (z.coerce.boolean treats "false" as true). */
export const booleanParam = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

export const assetQuery = z.object({
  status: z.enum(["owned", "sold", "disposed", "all"]).default("owned"),
  kind: z.enum(ASSET_KINDS).optional(),
  projectId: optionalUuid,
});
export type AssetQuery = z.input<typeof assetQuery>;

/**
 * Selling or disposing of an asset. `amount` is what it sold for (0 when
 * disposed of for nothing). With `proceedsAccountId` the proceeds are recorded
 * as money in to that account.
 */
export const assetSellInput = z.object({
  status: z.enum(["sold", "disposed"]).default("sold"),
  date: dayString,
  amount: nonNegativeMinor.default(0),
  proceedsAccountId: optionalUuid,
  note: shortText.nullish(),
});
export type AssetSellInput = z.input<typeof assetSellInput>;

export const investmentQuery = z.object({
  status: z.enum(["active", "closed", "all"]).default("active"),
  kind: z.enum(INVESTMENT_KINDS).optional(),
});
export type InvestmentQuery = z.input<typeof investmentQuery>;

export const liabilityQuery = z.object({
  /** Computed statuses: active, paid_off, overdue, cancelled. */
  status: listParam(z.enum(LIABILITY_STATUSES)),
  kind: listParam(z.enum(LIABILITY_KINDS)),
  projectId: optionalUuid,
  counterpartyId: optionalUuid,
});
export type LiabilityQuery = z.input<typeof liabilityQuery>;

export const payablesQuery = z.object({
  status: listParam(z.enum(LIABILITY_STATUSES)),
  projectId: optionalUuid,
  counterpartyId: optionalUuid,
  overdue: booleanParam.optional(),
});
export type PayablesQuery = z.input<typeof payablesQuery>;

/**
 * A liability payment. `recordAs` chooses how the principal part is booked:
 * `auto` books a payable (an unpaid bill) as an expense — the cost is
 * recognised when it is paid — and every other kind as a debt payment.
 */
export const liabilityPaymentRequest = liabilityPaymentInput
  .extend({ recordAs: z.enum(["auto", "debt_payment", "expense"]).default("auto") })
  .refine((value) => value.interest <= value.amount, { message: "Interest cannot be more than the payment", path: ["interest"] });
export type LiabilityPaymentRequest = z.input<typeof liabilityPaymentRequest>;

export const receivableQuery = z.object({
  /** Computed states: pending, partially_paid, paid, overdue, cancelled. */
  status: listParam(z.enum(RECEIVABLE_STATUSES)),
  kind: listParam(z.enum(RECEIVABLE_KINDS)),
  counterpartyId: optionalUuid,
  projectId: optionalUuid,
  overdue: booleanParam.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ReceivableQuery = z.input<typeof receivableQuery>;

export const netWorthHistoryQuery = z.object({
  months: z.coerce.number().int().min(1).max(60).default(12),
});

/** Deleting a record that money moved through: void those transactions too. */
export const removeLinkedQuery = z.object({
  voidLinked: booleanParam.default(false),
});
