// Response shapes of /billing and /admin/billing. The canonical types live in
// @financeos/core (shared with the API); this file re-exports them.

export type {
  AdminBillingPayment,
  AdminBillingSummary,
  AdminBillingUser,
  AdminCreditsInput,
  AdminPlanInput,
  BillingConfigInput,
  BillingConfigView,
  BillingInterval,
  BillingOverview,
  BillingPaymentView,
  BillingPlansView,
  BillingProvider,
  BillingStatus,
  BillingTestResult,
  CheckoutInput,
  CreditPack,
  CreditSummary,
  PlanId,
  PlanLimits,
  PublicPlan,
} from "@financeos/core";

/** The body of an HTTP 402 `plan_limit` error. */
export type PlanLimitDetails = { limit: string; plan: string; used?: number; allowed?: number | null };

/** Fired on window when any request answers 402 plan_limit; the app shell shows the upgrade dialog. */
export const PLAN_LIMIT_EVENT = "ew:plan-limit";
export type PlanLimitEventDetail = { message: string; details: PlanLimitDetails | null };
