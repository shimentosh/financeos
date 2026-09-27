import { z } from "zod";
import { uuid } from "./common.ts";

/**
 * Billing for the hosted service. Billing is optional: a self-hosted install
 * leaves it off and everyone is unlimited. When an admin turns it on (Admin →
 * Billing), every user is on a plan — the plan covers all workspaces they own —
 * and AI use is paid for in credits.
 */
export const PLAN_IDS = ["free", "pro", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const BILLING_STATUSES = ["trialing", "active", "past_due", "canceled", "expired"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** Stripe for cards worldwide, SSLCommerz for Bangladesh (bKash, Nagad, cards), manual for bank or bKash transfers an admin records. */
export const BILLING_PROVIDERS = ["stripe", "sslcommerz", "manual"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "canceled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_PURPOSES = ["plan", "credits"] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/**
 * AI credits. `usage` debits (negative), everything else adds. Usage is taken
 * from the plan's monthly `allowance` first, then from the purchased `balance`
 * (which never expires).
 */
export const CREDIT_KINDS = ["usage", "purchase", "grant", "adjustment", "refund"] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];
export const CREDIT_SOURCES = ["allowance", "balance"] as const;
export type CreditSource = (typeof CREDIT_SOURCES)[number];

/** 1 credit = US$0.01 of model cost by default; every AI call costs at least 1 credit. */
export const DEFAULT_CREDITS_PER_USD = 100;
export const TRIAL_DAYS = 14;
export const TRIAL_PLAN: PlanId = "pro";

export type PlanLimits = {
  /** Workspaces the user may own (their personal and company workspace count). null = unlimited. */
  workspaces: number | null;
  /** People per workspace, the owner included. */
  membersPerWorkspace: number | null;
  /** Files across every workspace the user owns. */
  storageBytes: number | null;
  aiCreditsPerMonth: number;
  /** API keys and the MCP endpoint for AI agents. */
  apiAccess: boolean;
  /** Bank, wallet and app connections. */
  integrations: boolean;
};

export type PlanDefinition = {
  id: PlanId;
  name: string;
  tagline: string;
  limits: PlanLimits;
  highlights: string[];
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** The plans and their default limits; an admin can change limits and prices in Admin → Billing. */
export const DEFAULT_PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Your own money, tracked properly.",
    limits: { workspaces: 2, membersPerWorkspace: 2, storageBytes: 250 * MB, aiCreditsPerMonth: 50, apiAccess: false, integrations: false },
    highlights: ["Personal and business workspace", "Unlimited transactions", "Receipts and invoices (250 MB)", "50 AI credits a month"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For freelancers and busy households.",
    limits: { workspaces: 5, membersPerWorkspace: 5, storageBytes: 5 * GB, aiCreditsPerMonth: 1_000, apiAccess: true, integrations: true },
    highlights: ["5 workspaces, 5 people each", "1,000 AI credits a month", "Bank, wallet and app connections", "API and AI agents (MCP)", "5 GB of receipts"],
  },
  business: {
    id: "business",
    name: "Business",
    tagline: "For small companies and their accountants.",
    limits: { workspaces: 20, membersPerWorkspace: 25, storageBytes: 50 * GB, aiCreditsPerMonth: 5_000, apiAccess: true, integrations: true },
    highlights: ["20 workspaces, 25 people each", "5,000 AI credits a month", "Everything in Pro", "50 GB of receipts", "Priority support"],
  },
};

/** What a self-hosted install without billing allows: everything. */
export const UNLIMITED_LIMITS: PlanLimits = {
  workspaces: null,
  membersPerWorkspace: null,
  storageBytes: null,
  aiCreditsPerMonth: Number.MAX_SAFE_INTEGER,
  apiAccess: true,
  integrations: true,
};

/** A plan as the public pricing page shows it. Prices are minor units in each currency. */
export type PublicPlan = PlanDefinition & {
  prices: Array<{ interval: BillingInterval; currency: string; amount: number }>;
};

/** A pack of AI credits bought once; they never expire. */
export type CreditPack = { id: string; credits: number; prices: Array<{ currency: string; amount: number }> };

export const checkoutInput = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("plan"),
    plan: z.enum(["pro", "business"]),
    interval: z.enum(BILLING_INTERVALS),
    provider: z.enum(["stripe", "sslcommerz"]),
    currency: z.string().length(3).optional(),
  }),
  z.object({
    purpose: z.literal("credits"),
    packId: z.string().min(1).max(40),
    provider: z.enum(["stripe", "sslcommerz"]),
    currency: z.string().length(3).optional(),
  }),
]);
export type CheckoutInput = z.input<typeof checkoutInput>;

/** Admin: put a user on a plan (a manual payment, a gift) or add credits. */
export const adminPlanInput = z.object({
  plan: z.enum(PLAN_IDS),
  status: z.enum(["trialing", "active", "canceled"]).default("active"),
  /** When the plan ends; null keeps it until changed. */
  periodEnd: z.iso.datetime({ offset: true }).nullish(),
  note: z.string().trim().max(300).nullish(),
});
export const adminCreditsInput = z.object({
  credits: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0, "Enter a number of credits"),
  note: z.string().trim().min(2).max(300),
});
export const adminUserRef = z.object({ userId: z.string().min(1).max(64) });
export const billingPaymentRef = z.object({ paymentId: uuid });

// ------------------------------------------------------------------ defaults

/** Default prices (minor units) until an admin sets their own: US$5 / ৳600 a month for Pro. */
export const DEFAULT_PLAN_PRICES: Record<PlanId, PublicPlan["prices"]> = {
  free: [],
  pro: [
    { interval: "month", currency: "USD", amount: 500 },
    { interval: "year", currency: "USD", amount: 5_000 },
    { interval: "month", currency: "BDT", amount: 60_000 },
    { interval: "year", currency: "BDT", amount: 600_000 },
  ],
  business: [
    { interval: "month", currency: "USD", amount: 1_500 },
    { interval: "year", currency: "USD", amount: 15_000 },
    { interval: "month", currency: "BDT", amount: 180_000 },
    { interval: "year", currency: "BDT", amount: 1_800_000 },
  ],
};

export const DEFAULT_CREDIT_PACKS: CreditPack[] = [
  {
    id: "credits-500",
    credits: 500,
    prices: [
      { currency: "USD", amount: 500 },
      { currency: "BDT", amount: 60_000 },
    ],
  },
  {
    id: "credits-2500",
    credits: 2_500,
    prices: [
      { currency: "USD", amount: 2_000 },
      { currency: "BDT", amount: 240_000 },
    ],
  },
];

/** Days a plan stays usable after a renewal payment fails. */
export const PAST_DUE_GRACE_DAYS = 7;

/** The Stripe events the webhook handles; select these when adding the endpoint in Stripe. */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

// ------------------------------------------------------------ admin config

const limitCount = z.number().int().min(0).max(1_000_000).nullable();
export const planLimitsInput = z.object({
  workspaces: limitCount,
  membersPerWorkspace: limitCount,
  storageBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  aiCreditsPerMonth: z.number().int().min(0).max(100_000_000),
  apiAccess: z.boolean(),
  integrations: z.boolean(),
});
const priceCurrency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter currency code")
  .transform((code) => code.toUpperCase());
export const planPriceInput = z.object({
  interval: z.enum(BILLING_INTERVALS),
  currency: priceCurrency,
  amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const creditPackInput = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and dashes"),
  credits: z.number().int().min(1).max(100_000_000),
  prices: z
    .array(z.object({ currency: priceCurrency, amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }))
    .min(1)
    .max(10),
});
/** A secret field: omitted keeps the saved value, an empty string removes it. */
const secretInput = z.string().trim().max(500).optional();

export const billingConfigInput = z.object({
  enabled: z.boolean(),
  creditsPerUsd: z.number().int().min(1).max(100_000).default(DEFAULT_CREDITS_PER_USD),
  trial: z.object({
    enabled: z.boolean(),
    days: z.number().int().min(1).max(90),
    plan: z.enum(["pro", "business"]),
  }),
  plans: z.object({
    free: z.object({ limits: planLimitsInput, prices: z.array(planPriceInput).max(20).default([]) }),
    pro: z.object({ limits: planLimitsInput, prices: z.array(planPriceInput).max(20) }),
    business: z.object({ limits: planLimitsInput, prices: z.array(planPriceInput).max(20) }),
  }),
  creditPacks: z.array(creditPackInput).max(10),
  providers: z.object({
    stripe: z.object({ enabled: z.boolean(), secretKey: secretInput, webhookSecret: secretInput }),
    sslcommerz: z.object({
      enabled: z.boolean(),
      storeId: z.string().trim().max(100).nullish(),
      storePassword: secretInput,
      sandbox: z.boolean(),
    }),
    manual: z.object({ enabled: z.boolean(), instructions: z.string().trim().max(2000).nullish() }),
  }),
});
export type BillingConfigInput = z.input<typeof billingConfigInput>;
export type BillingConfigParsed = z.output<typeof billingConfigInput>;

export const billingTestInput = z.object({ provider: z.enum(["stripe", "sslcommerz"]) });
export type BillingTestInput = z.input<typeof billingTestInput>;
export type BillingTestResult = { ok: boolean; message: string };

export const adminBillingUsersQuery = z.object({ q: z.string().trim().max(120).optional() });
export const adminBillingPaymentsQuery = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  provider: z.enum(BILLING_PROVIDERS).optional(),
  userId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** A payment received outside the app (bank transfer, bKash), recorded with a plan change or a credit grant. */
export const manualPaymentInput = z.object({
  amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currency: priceCurrency,
  reference: z.string().trim().min(1).max(120),
});
export const adminPlanWithPaymentInput = adminPlanInput.extend({
  interval: z.enum(BILLING_INTERVALS).nullish(),
  payment: manualPaymentInput.nullish(),
});
export type AdminPlanInput = z.input<typeof adminPlanWithPaymentInput>;
export const adminCreditsWithPaymentInput = adminCreditsInput.extend({ payment: manualPaymentInput.nullish() });
export type AdminCreditsInput = z.input<typeof adminCreditsWithPaymentInput>;

// ------------------------------------------------------------------- views

export type SecretView = { set: boolean; masked: string | null };

/** Admin → Billing as the admin sees it. Secrets appear masked, never in the clear. */
export type BillingConfigView = {
  enabled: boolean;
  creditsPerUsd: number;
  trial: { enabled: boolean; days: number; plan: PlanId };
  plans: Record<PlanId, { name: string; limits: PlanLimits; prices: PublicPlan["prices"] }>;
  defaults: { plans: Record<PlanId, PlanLimits>; prices: Record<PlanId, PublicPlan["prices"]>; creditPacks: CreditPack[] };
  creditPacks: CreditPack[];
  providers: {
    stripe: { enabled: boolean; ready: boolean; secretKey: SecretView; webhookSecret: SecretView; webhookUrl: string; events: string[] };
    sslcommerz: {
      enabled: boolean;
      ready: boolean;
      storeId: string | null;
      storePassword: SecretView;
      sandbox: boolean;
      ipnUrl: string;
    };
    manual: { enabled: boolean; instructions: string | null };
  };
  problems: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

/** GET /billing/plans: the public pricing page. */
export type BillingPlansView = {
  enabled: boolean;
  plans: PublicPlan[];
  creditPacks: CreditPack[];
  providers: { stripe: boolean; sslcommerz: boolean; manual: boolean };
  currencies: string[];
  trial: { enabled: boolean; days: number; plan: PlanId };
  creditsPerUsd: number;
};

export type CreditSummary = {
  /** The plan's credits for this period. */
  allowance: number;
  usedThisPeriod: number;
  remainingAllowance: number;
  /** Bought or granted credits; they never expire. */
  balance: number;
  periodStart: string;
  periodEnd: string;
};

export type BillingPaymentView = {
  id: string;
  provider: BillingProvider;
  providerRef: string;
  purpose: PaymentPurpose;
  plan: PlanId | null;
  interval: BillingInterval | null;
  credits: number | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paidAt: string | null;
  receiptUrl: string | null;
  createdAt: string;
  note: string | null;
};

/** GET /billing: the signed-in user's plan, usage and payments. */
export type BillingOverview = {
  enabled: boolean;
  plan: PlanId | "unlimited";
  planName: string;
  status: BillingStatus;
  provider: BillingProvider | null;
  interval: BillingInterval | null;
  trial: { active: boolean; endsAt: string | null; daysLeft: number | null };
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Past due: the plan stays usable until then. */
  graceEndsAt: string | null;
  /** A card subscription the billing portal can manage. */
  hasStripeSubscription: boolean;
  limits: PlanLimits;
  usage: { workspacesOwned: number; storageBytes: number; credits: CreditSummary | null };
  payments: BillingPaymentView[];
  manualInstructions: string | null;
  providers: { stripe: boolean; sslcommerz: boolean; manual: boolean };
  plans: PublicPlan[];
  creditPacks: CreditPack[];
  currencies: string[];
};

export type AdminBillingUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  plan: PlanId;
  status: BillingStatus;
  provider: BillingProvider | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  workspacesOwned: number;
  credits: { remainingAllowance: number; balance: number } | null;
};

export type AdminBillingPayment = BillingPaymentView & { userId: string; userEmail: string | null; userName: string | null };

export type AdminBillingSummary = {
  enabled: boolean;
  subscriptions: { free: number; pro: number; business: number; trialing: number; pastDue: number };
  /** Monthly recurring revenue from paid plans, per currency (yearly prices divided by 12). */
  mrr: Array<{ currency: string; amount: number }>;
  revenue30d: Array<{ currency: string; amount: number; payments: number }>;
  credits30d: { sold: number; granted: number; used: number };
};
