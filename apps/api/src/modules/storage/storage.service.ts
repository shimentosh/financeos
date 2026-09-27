import { createHash } from "node:crypto";
import { type StorageBackend, uuidv7 } from "@expensewise/core";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, gt, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { assertFound, badRequest, DomainError } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { files } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../system/audit.service.js";
import { JobsService } from "../system/jobs.service.js";
import { type Driver, describeStorageError, LocalDriver, S3Driver, type S3Settings } from "./drivers.js";
import { envS3Settings, loadStorageConfig } from "./storage-config.js";

export type FileKind = (typeof files.$inferSelect)["kind"];
export type FileRow = typeof files.$inferSelect;

/** Uploads accepted anywhere in the app. SVG and HTML are refused: they can carry script. */
export const ALLOWED_TYPES: Record<string, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"],
  pdf: ["application/pdf"],
  sheet: ["text/csv", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain"],
};
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export const STORAGE_COPY_JOB = "storage.copy";

/** Where files saved before storage was recorded per file live: the .env driver. */
export const defaultBackend = (): StorageBackend => (env.STORAGE_DRIVER === "s3" ? "env" : "local");
export const backendOf = (row: Pick<FileRow, "storageBackend">): StorageBackend => row.storageBackend ?? defaultBackend();

/** Files stored anywhere but `target` (a null backend counts as the .env driver). */
export function notOn(target: StorageBackend): SQL {
  return target === defaultBackend()
    ? (and(isNotNull(files.storageBackend), ne(files.storageBackend, target)) as SQL)
    : (or(isNull(files.storageBackend), ne(files.storageBackend, target)) as SQL);
}

const unavailable = (message: string) => new DomainError(503, message, "storage_unavailable");

/**
 * Receipts, screenshots and statements live in object storage; PostgreSQL
 * keeps only their metadata, which is what every access check reads.
 *
 * New files go to the bucket saved in Admin → Storage when there is one,
 * otherwise to the .env driver. Each file row records where its bytes went,
 * so files keep opening after storage changes, and a background job can copy
 * the older ones across.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger("Storage");
  private local: LocalDriver | null = null;
  private envBucket: S3Driver | null = null;
  private adminBucket: { signature: string; driver: S3Driver } | null = null;

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit() {
    this.jobs.register(STORAGE_COPY_JOB, (payload) => this.copyBatch(payload));
  }

  /** Where new uploads go, and the folder prefix for their keys. */
  async target(): Promise<{ backend: StorageBackend; prefix: string | null }> {
    const saved = await loadStorageConfig();
    if (saved) {
      if (!saved.settings) throw unavailable(`File storage isn't working: ${saved.problem} (Admin → Storage)`);
      return { backend: "admin", prefix: saved.stored.prefix };
    }
    return { backend: defaultBackend(), prefix: null };
  }

  /** The driver for one backend; throws a plain explanation when it is no longer set up. */
  async driver(backend: StorageBackend): Promise<Driver> {
    if (backend === "local") {
      this.local ??= new LocalDriver(env.STORAGE_LOCAL_DIR);
      return this.local;
    }
    if (backend === "env") {
      const settings = envS3Settings();
      if (!settings) throw unavailable("This file is in the bucket named in the server's .env (S3_BUCKET), which is no longer set");
      this.envBucket ??= new S3Driver(settings);
      return this.envBucket;
    }
    const saved = await loadStorageConfig();
    if (!saved)
      throw unavailable("This file is in the bucket that was set up in Admin → Storage, which has since been removed. Save those settings again to open it");
    if (!saved.settings) throw unavailable(`File storage isn't working: ${saved.problem}`);
    const signature = JSON.stringify(saved.settings);
    if (this.adminBucket?.signature !== signature) {
      this.adminBucket?.driver.destroy();
      this.adminBucket = { signature, driver: new S3Driver(saved.settings) };
    }
    return this.adminBucket.driver;
  }

  private settingsFor(backend: StorageBackend): (Pick<S3Settings, "bucket" | "endpoint"> & { provider?: "r2" | "s3" }) | null {
    if (backend === "env") {
      const settings = envS3Settings();
      return settings ? { bucket: settings.bucket, endpoint: settings.endpoint } : null;
    }
    return null;
  }

  private async fail(backend: StorageBackend, action: string, error: unknown): Promise<never> {
    if (error instanceof DomainError) throw error;
    let context = this.settingsFor(backend);
    if (backend === "admin") {
      const saved = await loadStorageConfig();
      context = saved?.settings ? { bucket: saved.settings.bucket, endpoint: saved.settings.endpoint, provider: saved.stored.provider } : null;
    }
    const message = describeStorageError(error, context ?? { bucket: "", endpoint: null });
    this.logger.warn(`${action} failed on ${backend}: ${message}`);
    throw unavailable(`Couldn't ${action}: ${message}`);
  }

  async save(
    ctx: WorkspaceContext,
    upload: { buffer: Buffer; filename: string; contentType: string },
    kind: FileKind,
    allowed: string[] = [...(ALLOWED_TYPES.image ?? []), ...(ALLOWED_TYPES.pdf ?? [])],
    exec: Executor = db,
  ): Promise<FileRow & { duplicateOf: string | null }> {
    if (!upload.buffer.length) throw badRequest("The file is empty");
    if (upload.buffer.length > MAX_UPLOAD_BYTES) throw badRequest("Files can be at most 12 MB", "file_too_large");
    const contentType = upload.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!allowed.includes(contentType)) throw badRequest(`Unsupported file type ${contentType || "(unknown)"}`, "unsupported_type");
    // The plan's storage covers every workspace the owner has (HTTP 402 when full).
    await this.entitlements.assertStorage(ctx.workspaceId, upload.buffer.length);

    const sha256 = createHash("sha256").update(upload.buffer).digest("hex");
    // The same bytes uploaded again (the same screenshot twice) is a strong
    // duplicate signal for the capture pipeline.
    const [previous] = await exec
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.workspaceId, ctx.workspaceId), eq(files.sha256, sha256)))
      .limit(1);

    const safeName = upload.filename.replace(/[^\w.\- ]+/g, "_").slice(-120) || "upload";
    const target = await this.target();
    const key = withPrefix(target.prefix, `${ctx.workspaceId}/${kind}/${uuidv7()}-${safeName}`);
    const driver = await this.driver(target.backend);
    await driver.put(key, upload.buffer, contentType).catch((error) => this.fail(target.backend, "save the file", error));
    const [row] = await exec
      .insert(files)
      .values({
        workspaceId: ctx.workspaceId,
        storageKey: key,
        storageBackend: target.backend,
        filename: safeName,
        contentType,
        size: upload.buffer.length,
        sha256,
        kind,
        uploadedBy: ctx.userId,
      })
      .returning();
    return { ...(row as FileRow), duplicateOf: previous?.id ?? null };
  }

  async meta(ctx: Pick<WorkspaceContext, "workspaceId">, id: string, exec: Executor = db): Promise<FileRow> {
    const [row] = await exec
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "File");
  }

  /** Reads a file, but only through its workspace. */
  async read(ctx: Pick<WorkspaceContext, "workspaceId">, id: string): Promise<{ file: FileRow; body: Buffer }> {
    const file = await this.meta(ctx, id);
    const backend = backendOf(file);
    const driver = await this.driver(backend);
    const body = await driver.get(file.storageKey).catch((error) => this.fail(backend, "open the file", error));
    return { file, body };
  }

  async remove(ctx: WorkspaceContext, id: string) {
    const file = await this.meta(ctx, id);
    await db.transaction(async (tx) => {
      await tx.delete(files).where(eq(files.id, id));
      await this.audit.record(tx, ctx, { action: "file.deleted", entityType: "file", entityId: id, before: file });
    });
    // The row is gone either way; a bucket that can't be reached leaves an orphan, not an error.
    try {
      await (await this.driver(backendOf(file))).remove(file.storageKey);
    } catch (error) {
      this.logger.warn(`Could not delete ${file.storageKey}: ${describeStorageError(error, { bucket: "", endpoint: null })}`);
    }
  }

  /**
   * One run of the copy job: moves files stored anywhere but the current
   * target there, oldest first, for about a minute, then queues the next run.
   * The originals are left where they were.
   */
  async copyBatch(payload: Record<string, unknown>) {
    const target = await this.target();
    const destination = await this.driver(target.backend);
    const started = Date.now();
    let after = typeof payload.after === "string" ? payload.after : null;
    let copied = Number(payload.copied ?? 0);
    let failed = Number(payload.failed ?? 0);
    const errors = Array.isArray(payload.errors) ? (payload.errors as string[]).slice(0, 5) : [];

    while (Date.now() - started < 60_000) {
      const rows = await db
        .select()
        .from(files)
        .where(and(notOn(target.backend), after ? gt(files.id, after) : undefined))
        .orderBy(asc(files.id))
        .limit(25);
      if (!rows.length) {
        this.logger.log(`Copied ${copied} files to ${target.backend}${failed ? ` (${failed} failed)` : ""}`);
        return { done: true, target: target.backend, copied, failed, errors };
      }
      for (const row of rows) {
        after = row.id;
        const source = backendOf(row);
        try {
          const body = await (await this.driver(source)).get(row.storageKey);
          const key = withPrefix(target.prefix, row.storageKey);
          await destination.put(key, body, row.contentType);
          await db
            .update(files)
            .set({ storageKey: key, storageBackend: target.backend })
            .where(and(eq(files.id, row.id), eq(files.storageKey, row.storageKey)));
          copied++;
        } catch (error) {
          failed++;
          if (errors.length < 5)
            errors.push(`${row.filename}: ${error instanceof DomainError ? error.message : describeStorageError(error, { bucket: "", endpoint: null })}`);
        }
      }
    }
    // Out of time: carry on in a fresh job so no single run holds a worker for long.
    await this.jobs.enqueue(STORAGE_COPY_JOB, { after, copied, failed, errors }, { dedupeKey: `${STORAGE_COPY_JOB}:${after}` });
    return { done: false, target: target.backend, copied, failed, errors };
  }
}

/** A key inside the configured folder, without doubling it. */
export function withPrefix(prefix: string | null, key: string): string {
  if (!prefix) return key;
  return key.startsWith(`${prefix}/`) ? key : `${prefix}/${key}`;
}
