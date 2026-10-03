import { hmacSha256Hex, safeEqual } from "../crypto.js";

/** Five minutes either way: old enough for clock skew, too short for a replay to matter. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** `t=1690000000,v1=abc…,v1=def…` → timestamp and every v1 signature. */
export function parseSignatureHeader(header: string | undefined): { timestamp: number | null; signatures: string[] } {
  const signatures: string[] = [];
  let timestamp: number | null = null;
  for (const part of (header ?? "").split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=").trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

function withinTolerance(timestamp: number, now: Date, toleranceSeconds: number): boolean {
  return Math.abs(Math.floor(now.getTime() / 1000) - timestamp) <= toleranceSeconds;
}

/**
 * The Stripe-style scheme: HMAC-SHA256 of `${t}.${rawBody}` with the signing
 * secret, compared in constant time against any `v1` value, and `t` within
 * the tolerance of now.
 */
export function verifyTimestampedHeader(input: { header: string | undefined; rawBody: Buffer; secret: string; now: Date; toleranceSeconds?: number }): boolean {
  if (!input.secret) return false;
  const { timestamp, signatures } = parseSignatureHeader(input.header);
  if (timestamp === null || !signatures.length) return false;
  if (!withinTolerance(timestamp, input.now, input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = hmacSha256Hex(input.secret, Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), input.rawBody]));
  return signatures.some((signature) => safeEqual(signature, expected));
}

export function signTimestampedHeader(secret: string, rawBody: Buffer, now: Date): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]));
  return `t=${timestamp},v1=${signature}`;
}

/**
 * The FinanceOS scheme for custom apps: `x-financeos-timestamp: <unix
 * seconds>` and `x-financeos-signature: sha256=<hex>` where hex is
 * HMAC-SHA256 of `${timestamp}.${rawBody}` with the connection's secret.
 */
export function verifyFinanceOSSignature(input: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
  secret: string;
  now: Date;
}): boolean {
  if (!input.secret || !input.signature || !input.timestamp || !/^\d{1,12}$/.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  if (!withinTolerance(timestamp, input.now, SIGNATURE_TOLERANCE_SECONDS)) return false;
  const match = input.signature.trim().match(/^sha256=([0-9a-f]{64})$/i);
  if (!match?.[1]) return false;
  const expected = hmacSha256Hex(input.secret, Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), input.rawBody]));
  return safeEqual(match[1].toLowerCase(), expected);
}

export function signFinanceOS(secret: string, rawBody: Buffer, now: Date): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = `sha256=${hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))}`;
  return { timestamp, signature };
}
