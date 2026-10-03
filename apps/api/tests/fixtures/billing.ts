import { DEFAULT_PLANS, type PlanId, type PlanLimits } from "@financeos/core";
import {
  DEFAULT_STORED_CONFIG,
  encryptBillingSecret,
  forgetBillingConfig,
  type StoredBillingConfig,
  saveBillingConfig,
} from "../../src/modules/billing/billing-config.js";
import type { BillingFetch } from "../../src/modules/billing/http.js";

export type FetchCall = { url: string; method: string; body: string };

export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stands in for Stripe and SSLCommerz: answers from a handler, records every call. */
export class FakeFetch {
  calls: FetchCall[] = [];
  handler: (call: FetchCall) => Response | Promise<Response> = () => jsonResponse({ error: { message: "No handler" } }, 500);

  readonly fn: BillingFetch = async (url, init) => {
    const call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
    this.calls.push(call);
    return this.handler(call);
  };

  reset() {
    this.calls = [];
    this.handler = () => jsonResponse({ error: { message: "No handler" } }, 500);
  }

  /** The form fields of the last call to a URL containing `part`. */
  form(part: string): URLSearchParams {
    const call = [...this.calls].reverse().find((c) => c.url.includes(part));
    if (!call) throw new Error(`No call to ${part}`);
    return new URLSearchParams(call.method === "GET" ? (call.url.split("?")[1] ?? "") : call.body);
  }
}

type Options = {
  trial?: Partial<StoredBillingConfig["trial"]>;
  limits?: Partial<Record<PlanId, Partial<PlanLimits>>>;
  creditsPerUsd?: number;
  stripe?: { secretKey?: string; webhookSecret?: string };
  sslcommerz?: { storeId?: string; storePassword?: string; sandbox?: boolean };
  manual?: string;
};

/** Turns billing on (Admin → Billing) for a test, with optional limits and providers. */
export async function enableBilling(options: Options = {}) {
  const plans: StoredBillingConfig["plans"] = {};
  for (const [id, limits] of Object.entries(options.limits ?? {}) as Array<[PlanId, Partial<PlanLimits>]>) {
    plans[id] = { limits: { ...DEFAULT_PLANS[id].limits, ...limits } };
  }
  const stored: StoredBillingConfig = {
    ...DEFAULT_STORED_CONFIG,
    enabled: true,
    creditsPerUsd: options.creditsPerUsd ?? DEFAULT_STORED_CONFIG.creditsPerUsd,
    trial: { ...DEFAULT_STORED_CONFIG.trial, ...(options.trial ?? {}) },
    plans,
    providers: {
      stripe: {
        enabled: Boolean(options.stripe),
        secretKeyEncrypted: options.stripe?.secretKey ? encryptBillingSecret(options.stripe.secretKey) : null,
        webhookSecretEncrypted: options.stripe?.webhookSecret ? encryptBillingSecret(options.stripe.webhookSecret) : null,
      },
      sslcommerz: {
        enabled: Boolean(options.sslcommerz),
        storeId: options.sslcommerz?.storeId ?? null,
        storePasswordEncrypted: options.sslcommerz?.storePassword ? encryptBillingSecret(options.sslcommerz.storePassword) : null,
        sandbox: options.sslcommerz?.sandbox ?? true,
      },
      manual: { enabled: Boolean(options.manual), instructions: options.manual ?? null },
    },
  };
  await saveBillingConfig(stored, null);
  forgetBillingConfig();
  return stored;
}
