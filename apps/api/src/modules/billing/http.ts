/**
 * How billing reaches Stripe and SSLCommerz: plain `fetch`, injected so tests
 * can answer with fixtures instead of the network.
 */
export type BillingFetch = (url: string, init?: RequestInit) => Promise<Response>;

export const BILLING_FETCH = Symbol("BILLING_FETCH");

export const defaultBillingFetch: BillingFetch = (url, init) => fetch(url, { signal: AbortSignal.timeout(20_000), ...init });

/** Stripe's form encoding: nested objects and arrays as `a[b][0][c]=…`. */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, `${key}[${index}]`);
      return;
    }
    if (typeof value === "object") {
      for (const [child, inner] of Object.entries(value as Record<string, unknown>)) walk(inner, key ? `${key}[${child}]` : child);
      return;
    }
    out.append(key, String(value));
  };
  walk(params, "");
  return out.toString();
}
