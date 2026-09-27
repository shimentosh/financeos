import { z } from "zod";

/**
 * Where a file's bytes live. `local` is this server's disk, `env` the
 * S3-compatible bucket named in the server's .env, `admin` the bucket saved
 * in Admin → Storage. Each file row remembers its own, so changing storage
 * never strands the files uploaded before.
 */
export const STORAGE_BACKENDS = ["local", "env", "admin"] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

/** What Admin → Storage can save: Cloudflare R2, or any other S3-compatible store. */
export const STORAGE_PROVIDERS = ["r2", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/** R2 data-location jurisdictions; each has its own endpoint. */
export const R2_JURISDICTIONS = ["default", "eu"] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

/** Accepts the bare account ID or the whole S3 API URL copied from the Cloudflare dashboard. */
export function r2AccountId(value: string): string {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/([a-f0-9]{32})\.(?:[a-z]+\.)?r2\.cloudflarestorage\.com/i)?.[1];
  return (fromUrl ?? trimmed).toLowerCase();
}

export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction = "default"): string {
  return `https://${accountId}.${jurisdiction === "eu" ? "eu." : ""}r2.cloudflarestorage.com`;
}

// Bucket naming rules shared by S3 and R2: lowercase letters, digits, dots and hyphens.
const bucket = z
  .string()
  .trim()
  .min(3, "Bucket names are at least 3 characters")
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Use the bucket's exact name: lowercase letters, digits, dots and hyphens");
const accessKeyId = z.string().trim().min(8, "Paste the whole access key ID").max(128);
/** A new secret replaces the stored one; omitted keeps it (only while the key ID stays the same). */
const secretAccessKey = z.string().trim().min(8, "Paste the whole secret access key").max(256).optional();
const prefix = z
  .string()
  .trim()
  .max(100)
  .regex(/^[\w.\-/]*$/, "Letters, digits, dots, hyphens, underscores and slashes only")
  .transform((value) => value.replace(/^\/+|\/+$/g, ""))
  .nullish();

export const storageConfigInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("r2"),
    accountId: z
      .string()
      .transform(r2AccountId)
      .pipe(z.string().regex(/^[a-f0-9]{32}$/, "The account ID is 32 characters (0-9, a-f): Cloudflare dashboard → R2 → Account details")),
    jurisdiction: z.enum(R2_JURISDICTIONS).default("default"),
    bucket,
    accessKeyId,
    secretAccessKey,
    /** Optional folder inside the bucket, so one bucket can hold several installations. */
    prefix,
  }),
  z.object({
    provider: z.literal("s3"),
    /** Empty for AWS S3 itself; the endpoint URL for MinIO, Backblaze B2, Wasabi, DigitalOcean Spaces… */
    endpoint: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .nullish(),
    region: z.string().trim().min(1).max(40).default("us-east-1"),
    bucket,
    accessKeyId,
    secretAccessKey,
    /** Path-style addressing, which MinIO and most self-hosted stores need. */
    forcePathStyle: z.boolean().default(false),
    prefix,
  }),
]);
export type StorageConfigInput = z.input<typeof storageConfigInput>;
export type StorageConfigParsed = z.output<typeof storageConfigInput>;

/** Tests the saved settings, or a draft before it is saved. */
export const storageConfigTestInput = z.object({ draft: storageConfigInput.optional() });
export type StorageConfigTestInput = z.input<typeof storageConfigTestInput>;

export type StorageTestResult = {
  ok: boolean;
  message: string;
  latencyMs: number;
  checks: Array<{ name: "write" | "read" | "delete"; ok: boolean; message: string }>;
};

/** A saved configuration as the admin screen shows it: never the secret, only its last four characters. */
export type StorageSavedView = {
  provider: StorageProvider;
  bucket: string;
  prefix: string | null;
  accessKeyId: string;
  secretAccessKey: { set: boolean; masked: string | null };
  /** R2 only. */
  accountId: string | null;
  jurisdiction: R2Jurisdiction | null;
  /** S3 only. */
  endpoint: string | null;
  region: string | null;
  forcePathStyle: boolean;
};

export type StorageConfigView = {
  /** Where new uploads go right now. */
  active: { backend: StorageBackend; label: string; location: string };
  source: "admin" | "env";
  saved: StorageSavedView | null;
  /** Why the saved settings are not in use, when they are not (a secret that no longer decrypts). */
  problem: string | null;
  env: { driver: "local" | "s3"; label: string; location: string };
  /** Files by where they are stored. */
  files: Array<{ backend: StorageBackend; label: string; location: string; count: number; bytes: number; active: boolean; readable: boolean }>;
  /** Files stored anywhere other than the active backend. */
  elsewhere: number;
  copy: { status: "queued" | "running" | "succeeded" | "failed" | "dead"; copied: number; failed: number; updatedAt: string; error: string | null } | null;
  updatedAt: string | null;
  updatedBy: string | null;
};
