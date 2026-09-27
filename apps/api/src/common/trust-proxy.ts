/**
 * TRUST_PROXY → Express's "trust proxy" setting, which decides what
 * `request.ip` is (rate limits, audit records, sessions):
 *
 * - `"1"`, `"2"`, …  trust that many reverse-proxy hops (the web server's /api
 *                    proxy is one; add one for a load balancer in front of it);
 * - `"true"`         trust every X-Forwarded-For entry (only behind a proxy
 *                    that overwrites the header);
 * - `"false"`/`"0"`  trust nothing: the socket address is the client;
 * - anything else    a comma-separated list of addresses/subnets or Express's
 *                    names (`loopback`, `linklocal`, `uniquelocal`).
 */
export function parseTrustProxy(value: string | undefined | null): boolean | number | string[] {
  const raw = (value ?? "").trim();
  if (raw === "") return 1;
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return hops === 0 ? false : hops;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
