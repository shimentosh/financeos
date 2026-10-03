import { resolve } from "node:path";
import {
  type StorageBackend,
  type StorageConfigInput,
  type StorageConfigParsed,
  type StorageConfigTestInput,
  type StorageConfigView,
  type StorageSavedView,
  type StorageTestResult,
  storageConfigInput,
  storageConfigTestInput,
  uuidv7,
} from "@financeos/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { count, desc, eq, sql } from "drizzle-orm";
import { conflict, unprocessable } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { files, jobs, platformSettings, users } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { maskSecret } from "../integrations/crypto.js";
import { JobsService } from "../system/jobs.service.js";
import { type Driver, describeStorageError, LocalDriver, S3Driver, type S3Settings } from "./drivers.js";
import { defaultBackend, notOn, STORAGE_COPY_JOB, StorageService, withPrefix } from "./storage.service.js";
import {
  decryptStorageSecret,
  encryptStorageSecret,
  envS3Settings,
  forgetStorageConfig,
  type LoadedStorageConfig,
  loadStorageConfig,
  STORAGE_SETTING_KEY,
  type StoredStorageConfig,
  s3SettingsFor,
} from "./storage-config.js";

const host = (url: string | null) => {
  if (!url) return "AWS S3";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function savedLabel(stored: StoredStorageConfig) {
  return stored.provider === "r2"
    ? {
        label: "Cloudflare R2",
        location: `${stored.bucket}${stored.prefix ? `/${stored.prefix}` : ""} · account …${(stored.accountId ?? "").slice(-6)}${stored.jurisdiction === "eu" ? " (EU)" : ""}`,
      }
    : { label: "S3-compatible bucket", location: `${stored.bucket}${stored.prefix ? `/${stored.prefix}` : ""} · ${host(stored.endpoint)}` };
}

function envLabel() {
  const settings = envS3Settings();
  return env.STORAGE_DRIVER === "s3" && settings
    ? { label: "Bucket from the server's .env", location: `${settings.bucket} · ${host(settings.endpoint)}` }
    : { label: "This server's disk", location: resolve(process.cwd(), env.STORAGE_LOCAL_DIR) };
}

/**
 * Admin → Storage: where the whole installation keeps receipts and files —
 * Cloudflare R2 or any S3-compatible bucket — instead of the server's .env.
 * The secret is encrypted at rest and never returned.
 */
@Injectable()
export class StorageAdminService {
  private readonly logger = new Logger("StorageConfig");

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  private labelFor(backend: StorageBackend, saved: LoadedStorageConfig | null) {
    if (backend === "admin") return saved ? savedLabel(saved.stored) : { label: "Removed Admin → Storage bucket", location: "no longer configured" };
    if (backend === "env") {
      const settings = envS3Settings();
      return { label: "Bucket from the server's .env", location: settings ? `${settings.bucket} · ${host(settings.endpoint)}` : "S3_BUCKET is no longer set" };
    }
    return { label: "This server's disk", location: resolve(process.cwd(), env.STORAGE_LOCAL_DIR) };
  }

  async view(): Promise<StorageConfigView> {
    const saved = await loadStorageConfig({ fresh: true });
    const activeBackend: StorageBackend = saved ? "admin" : defaultBackend();
    const [grouped, [elsewhere], [lastCopy]] = await Promise.all([
      db
        .select({ backend: files.storageBackend, count: count(), bytes: sql<string>`coalesce(sum(${files.size}), 0)` })
        .from(files)
        .groupBy(files.storageBackend),
      db.select({ value: count() }).from(files).where(notOn(activeBackend)),
      db.select().from(jobs).where(eq(jobs.type, STORAGE_COPY_JOB)).orderBy(desc(jobs.createdAt)).limit(1),
    ]);

    const totals = new Map<StorageBackend, { count: number; bytes: number }>();
    for (const row of grouped) {
      const backend = row.backend ?? defaultBackend();
      const before = totals.get(backend) ?? { count: 0, bytes: 0 };
      totals.set(backend, { count: before.count + row.count, bytes: before.bytes + Number(row.bytes) });
    }
    totals.set(activeBackend, totals.get(activeBackend) ?? { count: 0, bytes: 0 });

    let updatedBy: string | null = null;
    if (saved?.updatedBy) {
      const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, saved.updatedBy));
      updatedBy = user ? user.name || user.email : null;
    }
    const progress = (lastCopy?.result ?? lastCopy?.payload ?? {}) as { copied?: number; failed?: number; errors?: string[] };
    return {
      active: { backend: activeBackend, ...this.labelFor(activeBackend, saved) },
      source: saved ? "admin" : "env",
      saved: saved ? this.savedView(saved.stored) : null,
      problem: saved?.problem ?? null,
      env: { driver: env.STORAGE_DRIVER, ...envLabel() },
      files: [...totals.entries()].map(([backend, total]) => ({
        backend,
        ...this.labelFor(backend, saved),
        count: total.count,
        bytes: total.bytes,
        active: backend === activeBackend,
        readable: backend === "local" || (backend === "env" ? envS3Settings() !== null : Boolean(saved?.settings)),
      })),
      elsewhere: elsewhere?.value ?? 0,
      copy: lastCopy
        ? {
            status: lastCopy.status,
            copied: Number(progress.copied ?? 0),
            failed: Number(progress.failed ?? 0),
            updatedAt: (lastCopy.finishedAt ?? lastCopy.lockedAt ?? lastCopy.createdAt).toISOString(),
            error: lastCopy.lastError ?? progress.errors?.[0] ?? null,
          }
        : null,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
      updatedBy,
    };
  }

  private savedView(stored: StoredStorageConfig): StorageSavedView {
    let masked: string | null = null;
    try {
      masked = maskSecret(decryptStorageSecret(stored.secretAccessKeyEncrypted));
    } catch {
      masked = null;
    }
    return {
      provider: stored.provider,
      bucket: stored.bucket,
      prefix: stored.prefix,
      accessKeyId: stored.accessKeyId,
      secretAccessKey: { set: masked !== null, masked },
      accountId: stored.accountId,
      jurisdiction: stored.jurisdiction,
      endpoint: stored.endpoint,
      region: stored.region,
      forcePathStyle: stored.forcePathStyle,
    };
  }

  /**
   * The stored form of an input and its secret in the clear. An omitted secret
   * keeps the saved one only while the provider and key ID stay the same.
   */
  private async toStored(input: StorageConfigParsed): Promise<{ stored: StoredStorageConfig; secret: string }> {
    const existing = await loadStorageConfig({ fresh: true });
    let secret = input.secretAccessKey ?? null;
    if (!secret && existing?.settings && existing.stored.provider === input.provider && existing.stored.accessKeyId === input.accessKeyId) {
      secret = existing.settings.secretAccessKey;
    }
    if (!secret) throw unprocessable("Paste the secret access key", "storage_secret_required");
    const stored: StoredStorageConfig =
      input.provider === "r2"
        ? {
            provider: "r2",
            bucket: input.bucket,
            prefix: input.prefix || null,
            accessKeyId: input.accessKeyId,
            secretAccessKeyEncrypted: encryptStorageSecret(secret),
            accountId: input.accountId,
            jurisdiction: input.jurisdiction,
            endpoint: null,
            region: null,
            forcePathStyle: true,
          }
        : {
            provider: "s3",
            bucket: input.bucket,
            prefix: input.prefix || null,
            accessKeyId: input.accessKeyId,
            secretAccessKeyEncrypted: encryptStorageSecret(secret),
            accountId: null,
            jurisdiction: null,
            endpoint: input.endpoint || null,
            region: input.region,
            forcePathStyle: input.forcePathStyle,
          };
    return { stored, secret };
  }

  /** Writes, reads back and deletes a small object: the three things uploads need. */
  private async probe(driver: Driver, prefix: string | null, describe: (error: unknown) => string): Promise<StorageTestResult> {
    const started = Date.now();
    const key = withPrefix(prefix, `.financeos-check/${uuidv7()}.txt`);
    const body = Buffer.from(`FinanceOS storage check ${new Date().toISOString()}`);
    const checks: StorageTestResult["checks"] = [];
    const step = async (name: StorageTestResult["checks"][number]["name"], run: () => Promise<string>) => {
      try {
        checks.push({ name, ok: true, message: await run() });
        return true;
      } catch (error) {
        checks.push({ name, ok: false, message: describe(error) });
        return false;
      }
    };
    const wrote = await step("write", async () => {
      await driver.put(key, body, "text/plain");
      return "Saved a small test file";
    });
    if (wrote) {
      await step("read", async () => {
        const back = await driver.get(key);
        if (!back.equals(body)) throw new Error("The file read back differs from the one saved");
        return "Read it back unchanged";
      });
      await step("delete", async () => {
        await driver.remove(key);
        return "Deleted it again";
      });
    }
    const ok = checks.length === 3 && checks.every((check) => check.ok);
    return {
      ok,
      message: ok ? "Storage works: files can be saved, opened and deleted" : (checks.find((check) => !check.ok)?.message ?? "The test failed"),
      latencyMs: Date.now() - started,
      checks,
    };
  }

  private async probeS3(settings: S3Settings, prefix: string | null, provider: "r2" | "s3" | undefined) {
    const driver = new S3Driver(settings);
    try {
      return await this.probe(driver, prefix, (error) => describeStorageError(error, { bucket: settings.bucket, endpoint: settings.endpoint, provider }));
    } finally {
      driver.destroy();
    }
  }

  /** Tests a draft before it is saved, or whatever storage is in use now. */
  async test(raw: StorageConfigTestInput): Promise<StorageTestResult> {
    const input = storageConfigTestInput.parse(raw);
    if (input.draft) {
      const { stored, secret } = await this.toStored(input.draft);
      return this.probeS3(s3SettingsFor(stored, secret), stored.prefix, stored.provider);
    }
    const saved = await loadStorageConfig({ fresh: true });
    if (saved) {
      if (!saved.settings) return { ok: false, message: saved.problem ?? "The saved settings can't be used", latencyMs: 0, checks: [] };
      return this.probeS3(saved.settings, saved.stored.prefix, saved.stored.provider);
    }
    const settings = envS3Settings();
    if (defaultBackend() === "env" && settings) return this.probeS3(settings, null, undefined);
    return this.probe(new LocalDriver(env.STORAGE_LOCAL_DIR), null, (error) => describeStorageError(error, { bucket: "", endpoint: null }));
  }

  async update(raw: StorageConfigInput, userId: string): Promise<StorageConfigView> {
    const { stored, secret } = await this.toStored(storageConfigInput.parse(raw));
    // Never save a bucket uploads would fail against.
    const result = await this.probeS3(s3SettingsFor(stored, secret), stored.prefix, stored.provider);
    if (!result.ok) throw unprocessable(result.message, "storage_test_failed", result);
    const value = stored as unknown as Record<string, unknown>;
    await db
      .insert(platformSettings)
      .values({ key: STORAGE_SETTING_KEY, value, updatedBy: userId })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
    forgetStorageConfig();
    this.logger.log(`Storage changed by ${userId}: ${stored.provider} · ${stored.bucket}`);
    return this.view();
  }

  /** Back to the server's .env. Refused while files live only in the saved bucket, unless forced. */
  async reset(userId: string, force = false): Promise<StorageConfigView> {
    const [stranded] = await db.select({ value: count() }).from(files).where(eq(files.storageBackend, "admin"));
    if ((stranded?.value ?? 0) > 0 && !force) {
      throw conflict(
        `${stranded?.value} files are stored in this bucket and won't open without these settings. Copy them back to the server's storage first, or remove the settings anyway.`,
        "storage_files_stranded",
        { files: stranded?.value },
      );
    }
    await db.delete(platformSettings).where(eq(platformSettings.key, STORAGE_SETTING_KEY));
    forgetStorageConfig();
    this.logger.log(`Storage reset to the server's .env by ${userId}`);
    return this.view();
  }

  /** Copies every file stored elsewhere into the active storage, in the background. */
  async copyToActive(userId: string): Promise<StorageConfigView> {
    const target = await this.storage.target();
    const [pending] = await db.select({ value: count() }).from(files).where(notOn(target.backend));
    if (!pending?.value) throw conflict("Every file is already there", "nothing_to_copy");
    await this.jobs.enqueue(STORAGE_COPY_JOB, { requestedBy: userId, copied: 0, failed: 0 }, { dedupeKey: STORAGE_COPY_JOB, maxAttempts: 3 });
    this.logger.log(`Copy of ${pending.value} files to ${target.backend} requested by ${userId}`);
    return this.view();
  }
}
