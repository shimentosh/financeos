import { Inject, Injectable, Logger } from "@nestjs/common";
import { count, eq } from "drizzle-orm";
import { notFound } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { files, transactions, workspaceMembers, workspaces } from "../../db/schema/index.js";
import { backendOf, StorageService } from "../storage/storage.service.js";
import { PlatformAuditService } from "../system/platform-audit.service.js";

export type DeletionActor = { userId: string | null; email?: string | null; ip?: string | null; reason: "workspace_deleted" | "account_deleted" | "admin" };

/**
 * Deletes a workspace and everything in it: every financial record (the
 * workspace foreign keys cascade), and the stored files, which live outside
 * the database. Recorded in the platform audit log, since the workspace's own
 * log goes with it. Callers check who may do this; this only does it.
 */
@Injectable()
export class WorkspaceDeletionService {
  private readonly logger = new Logger("WorkspaceDeletion");

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
  ) {}

  async delete(workspaceId: string, actor: DeletionActor) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) throw notFound("Workspace");
    const stored = await db.select({ key: files.storageKey, storageBackend: files.storageBackend }).from(files).where(eq(files.workspaceId, workspaceId));
    const [[members], [records]] = await Promise.all([
      db.select({ value: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
      db.select({ value: count() }).from(transactions).where(eq(transactions.workspaceId, workspaceId)),
    ]);

    await db.transaction(async (tx) => {
      await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await this.platformAudit.record(
        {
          actorId: actor.userId,
          actorEmail: actor.email ?? null,
          action: "workspace.deleted",
          targetType: "workspace",
          targetId: workspaceId,
          details: {
            name: workspace.name,
            kind: workspace.kind,
            reason: actor.reason,
            members: members?.value ?? 0,
            transactions: records?.value ?? 0,
            files: stored.length,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    // The rows are gone; objects that can't be removed now are only orphans, never readable again.
    let removed = 0;
    for (const file of stored) {
      try {
        await (await this.storage.driver(backendOf(file))).remove(file.key);
        removed++;
      } catch (error) {
        this.logger.warn(`Could not remove ${file.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { deleted: true, files: stored.length, filesRemoved: removed };
  }
}
