import { Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { db, type Executor } from "../../db/index.js";
import { auditLogs } from "../../db/schema/index.js";

const SECRET_KEYS = /(password|secret|token|credential|apikey|api_key|keyhash)/i;

/** Copies a record for the audit log with anything secret-shaped removed. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 4) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  source?: string;
};

@Injectable()
export class AuditService {
  /** Written inside the same database transaction as the change itself. */
  async record(exec: Executor, ctx: WorkspaceContext, entry: AuditEntry) {
    await exec.insert(auditLogs).values({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId ?? ctx.apiKeyId ?? null,
      actorType: ctx.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: redact(entry.before) as object | null,
      after: redact(entry.after) as object | null,
      source: entry.source ?? ctx.actorType,
      ip: ctx.ip ?? null,
    });
  }

  async list(ctx: WorkspaceContext, query: { entityType?: string; entityId?: string; page: number; pageSize: number }) {
    const where = and(
      eq(auditLogs.workspaceId, ctx.workspaceId),
      query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
      query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
    );
    const [items, [total]] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(auditLogs).where(where),
    ]);
    return { items, total: total?.value ?? 0, page: query.page, pageSize: query.pageSize };
  }
}
