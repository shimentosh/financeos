import { Injectable } from "@nestjs/common";
import { desc, ilike } from "drizzle-orm";
import { db, type Executor } from "../../db/index.js";
import { platformAuditLogs } from "../../db/schema/index.js";

export type PlatformAuditEntry = {
  actorId: string | null;
  actorEmail?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
};

/**
 * The audit trail of the installation itself: platform admin actions, account
 * and workspace deletions, billing changes made by admins. Workspace-level
 * changes stay in each workspace's own audit log.
 */
@Injectable()
export class PlatformAuditService {
  async record(entry: PlatformAuditEntry, exec: Executor = db) {
    await exec.insert(platformAuditLogs).values({
      actorId: entry.actorId,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      details: entry.details ?? {},
      ip: entry.ip ?? null,
    });
  }

  list(query: { page: number; pageSize: number; action?: string }) {
    return db
      .select()
      .from(platformAuditLogs)
      .where(query.action ? ilike(platformAuditLogs.action, `${query.action}%`) : undefined)
      .orderBy(desc(platformAuditLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
  }
}
