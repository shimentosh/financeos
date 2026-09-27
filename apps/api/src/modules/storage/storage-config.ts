import { type R2Jurisdiction, r2Endpoint, type StorageProvider } from "@expensewise/core";
import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformSettings } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { decryptSecret, encryptSecret } from "../integrations/crypto.js";
import type { S3Settings } from "./drivers.js";

export const STORAGE_SETTING_KEY = "storage";

/** Admin → Storage as saved in platform_setting. The secret is encrypted. */
export type StoredStorageConfig = {
  provider: StorageProvider;
  bucket: string;
  prefix: string | null;
  accessKeyId: string;
  secretAccessKeyEncrypted: string;
  accountId: string | null;
  jurisdiction: R2Jurisdiction | null;
  endpoint: string | null;
  region: string | null;
  forcePathStyle: boolean;
};

export type LoadedStorageConfig = {
  stored: StoredStorageConfig;
  /** Null when the secret cannot be decrypted; `problem` says why. */
  settings: S3Settings | null;
  problem: string | null;
  updatedAt: Date;
  updatedBy: string | null;
};

const AAD = "platform:storage";
export const encryptStorageSecret = (secret: string) => encryptSecret(secret, { aad: AAD });
export const decryptStorageSecret = (payload: string) => decryptSecret(payload, { aad: AAD });

/** The connection settings for a saved configuration and its secret in the clear. */
export function s3SettingsFor(stored: Omit<StoredStorageConfig, "secretAccessKeyEncrypted">, secretAccessKey: string): S3Settings {
  if (stored.provider === "r2") {
    return {
      endpoint: r2Endpoint(stored.accountId ?? "", stored.jurisdiction ?? "default"),
      region: "auto",
      bucket: stored.bucket,
      accessKeyId: stored.accessKeyId,
      secretAccessKey,
      // Path-style works for every bucket name, dots included.
      forcePathStyle: true,
      serverSideEncryption: false,
    };
  }
  return {
    endpoint: stored.endpoint,
    region: stored.region ?? "us-east-1",
    bucket: stored.bucket,
    accessKeyId: stored.accessKeyId,
    secretAccessKey,
    forcePathStyle: stored.forcePathStyle,
    serverSideEncryption: !stored.endpoint,
  };
}

export function resolveStored(row: { value: unknown; updatedAt: Date; updatedBy: string | null }): LoadedStorageConfig {
  const stored = row.value as StoredStorageConfig;
  try {
    const secret = decryptStorageSecret(stored.secretAccessKeyEncrypted);
    return { stored, settings: s3SettingsFor(stored, secret), problem: null, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  } catch {
    return {
      stored,
      settings: null,
      problem: "The saved secret access key can't be decrypted (was ENCRYPTION_KEY changed?). Paste it again and save.",
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }
}

/** The .env bucket (S3_*), or null when .env names none. */
export function envS3Settings(): S3Settings | null {
  if (!env.S3_BUCKET) return null;
  return {
    endpoint: env.S3_ENDPOINT || null,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID ?? null,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    // Unchanged from before Admin → Storage existed.
    serverSideEncryption: true,
  };
}

const logger = new Logger("Storage");
const TTL_MS = 30_000;
let cache: { value: LoadedStorageConfig | null; at: number } | null = null;

/**
 * The saved configuration, cached for 30 seconds so other processes (workers)
 * follow an admin's change without asking the database on every upload. A
 * database hiccup keeps the last value.
 */
export async function loadStorageConfig(options: { fresh?: boolean } = {}): Promise<LoadedStorageConfig | null> {
  if (!options.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, STORAGE_SETTING_KEY));
    const value = row ? resolveStored(row) : null;
    cache = { value, at: Date.now() };
    return value;
  } catch (error) {
    if (cache) {
      logger.warn(`Could not reload the storage settings; keeping the last ones: ${error instanceof Error ? error.message : String(error)}`);
      return cache.value;
    }
    throw error;
  }
}

export function forgetStorageConfig() {
  cache = null;
}
