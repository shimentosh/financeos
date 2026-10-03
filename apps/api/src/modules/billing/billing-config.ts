import {
  type BillingInterval,
  type CreditPack,
  DEFAULT_CREDIT_PACKS,
  DEFAULT_CREDITS_PER_USD,
  DEFAULT_PLAN_PRICES,
  DEFAULT_PLANS,
  PLAN_IDS,
  type PlanId,
  type PlanLimits,
  type PublicPlan,
  TRIAL_DAYS,
  TRIAL_PLAN,
} from "@financeos/core";
import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformSettings } from "../../db/schema/index.js";
import { decryptSecret, encryptSecret } from "../integrations/crypto.js";

export const BILLING_SETTING_KEY = "billing";
const AAD = "platform:billing";
export const encryptBillingSecret = (secret: string) => encryptSecret(secret, { aad: AAD });
export const decryptBillingSecret = (payload: string) => decryptSecret(payload, { aad: AAD });

type Price = PublicPlan["prices"][number];

/** Admin → Billing as saved in platform_setting. Secrets are encrypted. */
export type StoredBillingConfig = {
  enabled: boolean;
  creditsPerUsd: number;
  trial: { enabled: boolean; days: number; plan: PlanId };
  plans: Partial<Record<PlanId, { limits?: PlanLimits; prices?: Price[] }>>;
  creditPacks: CreditPack[];
  providers: {
    stripe: { enabled: boolean; secretKeyEncrypted: string | null; webhookSecretEncrypted: string | null };
    sslcommerz: { enabled: boolean; storeId: string | null; storePasswordEncrypted: string | null; sandbox: boolean };
    manual: { enabled: boolean; instructions: string | null };
  };
};

/** The configuration in effect, defaults filled in and secrets in the clear (server-side only). */
export type BillingConfig = {
  enabled: boolean;
  creditsPerUsd: number;
  trial: { enabled: boolean; days: number; plan: PlanId };
  plans: Record<PlanId, PublicPlan>;
  creditPacks: CreditPack[];
  stripe: { enabled: boolean; secretKey: string | null; webhookSecret: string | null };
  sslcommerz: { enabled: boolean; storeId: string | null; storePassword: string | null; sandbox: boolean };
  manual: { enabled: boolean; instructions: string | null };
  /** Secrets that could not be decrypted (ENCRYPTION_KEY changed). */
  problems: string[];
  stored: StoredBillingConfig | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export const DEFAULT_STORED_CONFIG: StoredBillingConfig = {
  enabled: false,
  creditsPerUsd: DEFAULT_CREDITS_PER_USD,
  trial: { enabled: true, days: TRIAL_DAYS, plan: TRIAL_PLAN },
  plans: {},
  creditPacks: DEFAULT_CREDIT_PACKS,
  providers: {
    stripe: { enabled: false, secretKeyEncrypted: null, webhookSecretEncrypted: null },
    sslcommerz: { enabled: false, storeId: null, storePasswordEncrypted: null, sandbox: true },
    manual: { enabled: false, instructions: null },
  },
};

function open(payload: string | null | undefined, label: string, problems: string[]): string | null {
  if (!payload) return null;
  try {
    return decryptBillingSecret(payload);
  } catch {
    problems.push(`The saved ${label} can't be decrypted (was ENCRYPTION_KEY changed?). Paste it again and save.`);
    return null;
  }
}

/** Fills the defaults into whatever is saved (older saves may miss newer fields). */
export function resolveBillingConfig(row: { value: unknown; updatedAt: Date; updatedBy: string | null } | null): BillingConfig {
  const raw = (row?.value ?? {}) as Partial<StoredBillingConfig>;
  const providers = (raw.providers ?? {}) as Partial<StoredBillingConfig["providers"]>;
  const stored: StoredBillingConfig = {
    enabled: raw.enabled === true,
    creditsPerUsd: Number.isFinite(raw.creditsPerUsd) && Number(raw.creditsPerUsd) > 0 ? Number(raw.creditsPerUsd) : DEFAULT_CREDITS_PER_USD,
    trial: { ...DEFAULT_STORED_CONFIG.trial, ...(raw.trial ?? {}) },
    plans: raw.plans ?? {},
    creditPacks: Array.isArray(raw.creditPacks) ? raw.creditPacks : DEFAULT_CREDIT_PACKS,
    providers: {
      stripe: { ...DEFAULT_STORED_CONFIG.providers.stripe, ...(providers.stripe ?? {}) },
      sslcommerz: { ...DEFAULT_STORED_CONFIG.providers.sslcommerz, ...(providers.sslcommerz ?? {}) },
      manual: { ...DEFAULT_STORED_CONFIG.providers.manual, ...(providers.manual ?? {}) },
    },
  };
  const problems: string[] = [];
  const plans = Object.fromEntries(
    PLAN_IDS.map((id) => {
      const override = stored.plans[id];
      const plan: PublicPlan = {
        ...DEFAULT_PLANS[id],
        limits: { ...DEFAULT_PLANS[id].limits, ...(override?.limits ?? {}) },
        prices: override?.prices ?? DEFAULT_PLAN_PRICES[id],
      };
      return [id, plan];
    }),
  ) as Record<PlanId, PublicPlan>;
  const stripeKey = open(stored.providers.stripe.secretKeyEncrypted, "Stripe secret key", problems);
  const stripeWebhook = open(stored.providers.stripe.webhookSecretEncrypted, "Stripe webhook signing secret", problems);
  const sslPassword = open(stored.providers.sslcommerz.storePasswordEncrypted, "SSLCommerz store password", problems);
  return {
    enabled: stored.enabled,
    creditsPerUsd: stored.creditsPerUsd,
    trial: stored.trial,
    plans,
    creditPacks: stored.creditPacks,
    stripe: { enabled: stored.providers.stripe.enabled, secretKey: stripeKey, webhookSecret: stripeWebhook },
    sslcommerz: {
      enabled: stored.providers.sslcommerz.enabled,
      storeId: stored.providers.sslcommerz.storeId,
      storePassword: sslPassword,
      sandbox: stored.providers.sslcommerz.sandbox !== false,
    },
    manual: { enabled: stored.providers.manual.enabled, instructions: stored.providers.manual.instructions },
    problems,
    stored: row ? stored : null,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/** Which checkout providers can take a payment right now. */
export function readyProviders(config: BillingConfig) {
  return {
    stripe: config.stripe.enabled && Boolean(config.stripe.secretKey),
    sslcommerz: config.sslcommerz.enabled && Boolean(config.sslcommerz.storeId && config.sslcommerz.storePassword),
    manual: config.manual.enabled,
  };
}

/** Every currency any plan or credit pack is priced in. */
export function currenciesOf(config: BillingConfig): string[] {
  const set = new Set<string>();
  for (const plan of Object.values(config.plans)) for (const price of plan.prices) set.add(price.currency);
  for (const pack of config.creditPacks) for (const price of pack.prices) set.add(price.currency);
  return [...set].sort();
}

export function priceFor(config: BillingConfig, plan: PlanId, interval: BillingInterval, currency: string) {
  return config.plans[plan].prices.find((price) => price.interval === interval && price.currency === currency.toUpperCase()) ?? null;
}

const logger = new Logger("Billing");
const TTL_MS = 30_000;
let cache: { value: BillingConfig; at: number } | null = null;

/**
 * The saved configuration, cached for 30 seconds so every instance and worker
 * follows an admin's change without reading the database on each request. A
 * database hiccup keeps the last value.
 */
export async function loadBillingConfig(options: { fresh?: boolean } = {}): Promise<BillingConfig> {
  if (!options.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, BILLING_SETTING_KEY));
    const value = resolveBillingConfig(row ?? null);
    cache = { value, at: Date.now() };
    return value;
  } catch (error) {
    if (cache) {
      logger.warn(`Could not reload the billing settings; keeping the last ones: ${error instanceof Error ? error.message : String(error)}`);
      return cache.value;
    }
    throw error;
  }
}

export function forgetBillingConfig() {
  cache = null;
}

export async function saveBillingConfig(stored: StoredBillingConfig, userId: string | null) {
  const value = stored as unknown as Record<string, unknown>;
  await db
    .insert(platformSettings)
    .values({ key: BILLING_SETTING_KEY, value, updatedBy: userId })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  forgetBillingConfig();
}
