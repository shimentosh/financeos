import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../env.js";

/**
 * Secrets at rest (integration credentials, webhook signing secrets) are
 * AES-256-GCM encrypted with ENCRYPTION_KEY: a random 12-byte IV per value and
 * the 16-byte auth tag, so any tampering fails decryption instead of yielding
 * garbage. The optional associated data binds a ciphertext to its row, so a
 * value copied into another connection does not decrypt there.
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>` (base64url parts). The version prefix
 * lets the scheme change later without guessing what a stored value is.
 *
 * Rotation: new values are always sealed with ENCRYPTION_KEY; decryption tries
 * ENCRYPTION_KEY, then each key in ENCRYPTION_KEY_PREVIOUS. After changing the
 * key, list the old one there and run `pnpm --filter @financeos/api
 * rotate-keys` to re-seal every stored secret; then the old key can go.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretDecryptionError extends Error {
  constructor(message = "The stored secret could not be decrypted") {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

let cachedKey: Buffer | null = null;
let cachedPrevious: Buffer[] | null = null;

/** ENCRYPTION_KEY (validated at boot by env.ts). */
function environmentKey(): Buffer {
  if (cachedKey) return cachedKey;
  const key = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be base64 of exactly 32 bytes");
  cachedKey = key;
  return key;
}

/** Comma-separated base64 keys (ENCRYPTION_KEY_PREVIOUS), each exactly 32 bytes. */
export function parseKeyList(value: string | undefined | null): Buffer[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const key = Buffer.from(part, "base64");
      if (key.length !== 32) throw new Error(`ENCRYPTION_KEY_PREVIOUS entry ${index + 1} must be base64 of exactly 32 bytes`);
      return key;
    });
}

/** Every key a stored secret may be sealed with: the current one first, then earlier ones. */
export function decryptionKeys(): Buffer[] {
  const current = environmentKey();
  cachedPrevious ??= parseKeyList(env.ENCRYPTION_KEY_PREVIOUS).filter((key) => !key.equals(current));
  return [current, ...cachedPrevious];
}

export function encryptSecret(plaintext: string, options: { aad?: string; key?: Buffer } = {}): string {
  const key = options.key ?? environmentKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (options.aad) cipher.setAAD(Buffer.from(options.aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

/**
 * Decrypts with the first key that opens the value. `keyIndex` says which:
 * 0 is the first key given (the current one), anything higher means the value
 * still needs re-sealing with the current key.
 */
export function decryptWithKeys(payload: string, keys: Buffer[], aad?: string): { plaintext: string; keyIndex: number } {
  const parts = payload.split(":");
  if (parts.length !== 4) throw new SecretDecryptionError("Unrecognised secret format");
  const [version, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  if (version !== VERSION) throw new SecretDecryptionError(`Unsupported secret version ${version}`);
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptionError("Corrupted secret");
  const data = Buffer.from(dataPart, "base64url");
  for (const [keyIndex, key] of keys.entries()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return { plaintext: Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"), keyIndex };
    } catch {
      // Wrong key (or tampered value): try the next one.
    }
  }
  throw new SecretDecryptionError();
}

export function decryptSecret(payload: string, options: { aad?: string; key?: Buffer } = {}): string {
  return decryptWithKeys(payload, options.key ? [options.key] : decryptionKeys(), options.aad).plaintext;
}

export function encryptJson(value: Record<string, string>, options: { aad?: string; key?: Buffer } = {}): string {
  return encryptSecret(JSON.stringify(value), options);
}

export function decryptJson(payload: string, options: { aad?: string; key?: Buffer } = {}): Record<string, string> {
  const parsed = JSON.parse(decryptSecret(payload, options)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SecretDecryptionError("Corrupted secret");
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random bytes as base62 (no padding, URL- and copy-paste-safe). */
export function randomBase62(bytes = 32): string {
  let value = BigInt(`0x${randomBytes(bytes).toString("hex")}`);
  const length = Math.ceil((bytes * 8) / Math.log2(62));
  let out = "";
  while (value > 0n) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out.padStart(length, "0");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time string comparison (false for different lengths). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** How a stored credential is shown: never the value, at most its last four characters. */
export function maskSecret(value: string): string {
  if (value.length >= 16) return `••••${value.slice(-4)}`;
  return "••••••••";
}
