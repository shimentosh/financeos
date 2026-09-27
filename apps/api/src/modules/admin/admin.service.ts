import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  aiUsage,
  auditLogs,
  domainEvents,
  integrationConnections,
  jobs,
  sessions,
  syncRuns,
  transactions,
  users,
  workspaceMembers,
  workspaces,
} from "../../db/schema/index.js";
import { env } from "../../env.js";
import { aiRuntime } from "../ai/gateway/router.provider.js";
import { SchedulerService } from "../jobs/scheduler.service.js";
import { loadStorageConfig } from "../storage/storage-config.js";
import { EventsService } from "../system/events.service.js";
import { JobsService } from "../system/jobs.service.js";
import { PlatformAuditService } from "../system/platform-audit.service.js";

/**
 * Platform administration: the instance as a whole, across workspaces.
 * Only reachable through AdminGuard. Returns operational metadata — counts,
 * statuses, costs — never another user's financial records.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(PlatformAuditService) private readonly platformAuditLog: PlatformAuditService,
  ) {}

  async overview() {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [[userCount], [workspaceCount], [transactionCount], [activeSessions], [aiMonth], jobStats, [pendingEvents], [failedEvents], connections, dbSize] =
      await Promise.all([
        db.select({ value: count() }).from(users),
        db.select({ value: count() }).from(workspaces),
        db.select({ value: count() }).from(transactions),
        db.select({ value: count() }).from(sessions).where(gte(sessions.expiresAt, new Date())),
        db
          .select({
            calls: count(),
            cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`,
            failures: sql<number>`count(*) filter (where ${aiUsage.status} <> 'ok')::int`,
          })
          .from(aiUsage)
          .where(gte(aiUsage.createdAt, monthStart)),
        this.jobs.stats(),
        db.select({ value: count() }).from(domainEvents).where(sql`${domainEvents.processedAt} is null`),
        db.select({ value: count() }).from(domainEvents).where(sql`${domainEvents.processedAt} is null and ${domainEvents.attempts} >= 5`),
        db.select({ status: integrationConnections.status, value: count() }).from(integrationConnections).groupBy(integrationConnections.status),
        db.execute<{ size: string }>(sql`select pg_size_pretty(pg_database_size(current_database())) as size`),
      ]);
    const storage = await loadStorageConfig();
    return {
      users: userCount?.value ?? 0,
      workspaces: workspaceCount?.value ?? 0,
      transactions: transactionCount?.value ?? 0,
      activeSessions: activeSessions?.value ?? 0,
      ai: {
        configured: aiRuntime.available,
        provider: aiRuntime.provider,
        model: aiRuntime.model,
        callsThisMonth: aiMonth?.calls ?? 0,
        costThisMonthUsd: Number(aiMonth?.cost ?? 0),
        failuresThisMonth: aiMonth?.failures ?? 0,
      },
      jobs: jobStats,
      events: { pending: pendingEvents?.value ?? 0, failed: failedEvents?.value ?? 0 },
      integrations: Object.fromEntries(connections.map((row) => [row.status, row.value])),
      database: { size: dbSize.rows[0]?.size ?? "unknown" },
      storage: storage
        ? `${storage.stored.provider === "r2" ? "Cloudflare R2" : "S3"} · ${storage.stored.bucket}${storage.problem ? " (not working)" : ""}`
        : env.STORAGE_DRIVER === "s3"
          ? `S3 · ${env.S3_BUCKET} (.env)`
          : "Server disk (.env)",
      worker: env.RUN_WORKER_IN_PROCESS ? "in-process" : "external",
      signUp: env.ALLOW_SIGN_UP ? "open" : "closed",
    };
  }

  async users(query: { q?: string; page: number; pageSize: number }) {
    const where = query.q ? or(ilike(users.email, `%${query.q}%`), ilike(users.name, `%${query.q}%`)) : undefined;
    const [items, [total]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          banned: users.banned,
          banReason: users.banReason,
          createdAt: users.createdAt,
          workspaces: sql<number>`(select count(*)::int from ${workspaceMembers} m where m.user_id = "auth_user"."id")`,
          lastSeen: sql<string | null>`(select max(s.updated_at) from ${sessions} s where s.user_id = "auth_user"."id")`,
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(users).where(where),
    ]);
    return { items, total: total?.value ?? 0, page: query.page, pageSize: query.pageSize };
  }

  async workspaces(query: { q?: string; page: number; pageSize: number }) {
    const where = query.q ? ilike(workspaces.name, `%${query.q}%`) : undefined;
    const [items, [total]] = await Promise.all([
      db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          kind: workspaces.kind,
          baseCurrency: workspaces.baseCurrency,
          createdAt: workspaces.createdAt,
          members: sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = "workspace"."id")`,
          transactions: sql<number>`(select count(*)::int from ${transactions} t where t.workspace_id = "workspace"."id")`,
          connections: sql<number>`(select count(*)::int from ${integrationConnections} c where c.workspace_id = "workspace"."id")`,
          aiCostUsd: sql<string>`(select coalesce(sum(u.cost_usd), 0)::text from ${aiUsage} u where u.workspace_id = "workspace"."id" and u.created_at >= date_trunc('month', now()))`,
          owner: sql<
            string | null
          >`(select u.email from ${workspaceMembers} m join ${users} u on u.id = m.user_id where m.workspace_id = "workspace"."id" and m.role = 'owner' limit 1)`,
        })
        .from(workspaces)
        .where(where)
        .orderBy(desc(workspaces.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(workspaces).where(where),
    ]);
    return { items: items.map((row) => ({ ...row, aiCostUsd: Number(row.aiCostUsd) })), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize };
  }

  async jobList(status?: "queued" | "running" | "succeeded" | "failed" | "dead") {
    return {
      stats: await this.jobs.stats(),
      registered: this.jobs.registeredTypes(),
      schedules: this.scheduler.list(),
      items: await this.jobs.recent(100, status),
    };
  }

  retryJob(id: string) {
    return this.jobs.retry(id);
  }

  async runSchedule(name: string) {
    await this.scheduler.runTask(name);
    return this.scheduler.list().find((task) => task.name === name) ?? null;
  }

  async aiUsage(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [byDay, byFeature, byWorkspace] = await Promise.all([
      db
        .select({ day: sql<string>`to_char(${aiUsage.createdAt}, 'YYYY-MM-DD')`, calls: count(), cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
        .from(aiUsage)
        .where(gte(aiUsage.createdAt, since))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({
          feature: aiUsage.feature,
          calls: count(),
          cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`,
          inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
          outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
          failures: sql<number>`count(*) filter (where ${aiUsage.status} <> 'ok')::int`,
          avgLatency: sql<number>`coalesce(avg(${aiUsage.latencyMs}), 0)::int`,
        })
        .from(aiUsage)
        .where(gte(aiUsage.createdAt, since))
        .groupBy(aiUsage.feature),
      db
        .select({ workspaceId: aiUsage.workspaceId, name: workspaces.name, calls: count(), cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
        .from(aiUsage)
        .leftJoin(workspaces, eq(workspaces.id, aiUsage.workspaceId))
        .where(gte(aiUsage.createdAt, since))
        .groupBy(aiUsage.workspaceId, workspaces.name)
        .orderBy(desc(sql`sum(${aiUsage.costUsd})`))
        .limit(20),
    ]);
    const num = <T extends { cost: string }>(rows: T[]) => rows.map((row) => ({ ...row, cost: Number(row.cost) }));
    return {
      days,
      byDay: num(byDay),
      byFeature: byFeature.map((row) => ({ ...row, cost: Number(row.cost), inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens) })),
      byWorkspace: num(byWorkspace),
    };
  }

  async integrations() {
    const connections = await db
      .select({
        id: integrationConnections.id,
        name: integrationConnections.name,
        provider: integrationConnections.provider,
        status: integrationConnections.status,
        workspaceName: workspaces.name,
        lastSyncedAt: integrationConnections.lastSyncedAt,
        lastSuccessAt: integrationConnections.lastSuccessAt,
        consecutiveFailures: integrationConnections.consecutiveFailures,
        errorMessage: integrationConnections.errorMessage,
        recordsTotal: integrationConnections.recordsTotal,
      })
      .from(integrationConnections)
      .innerJoin(workspaces, eq(workspaces.id, integrationConnections.workspaceId))
      .orderBy(desc(integrationConnections.consecutiveFailures), desc(integrationConnections.lastSyncedAt));
    const recentRuns = await db
      .select({ status: syncRuns.status, value: count() })
      .from(syncRuns)
      .where(gte(syncRuns.startedAt, new Date(Date.now() - 7 * 86_400_000)))
      .groupBy(syncRuns.status);
    return { connections, runsLast7Days: Object.fromEntries(recentRuns.map((row) => [row.status, row.value])) };
  }

  /** Platform-level audit trail (admin actions and auth changes across workspaces). */
  async audit(query: { page: number; pageSize: number; action?: string }) {
    const where = query.action ? ilike(auditLogs.action, `${query.action}%`) : undefined;
    const items = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        workspaceName: workspaces.name,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .innerJoin(workspaces, eq(workspaces.id, auditLogs.workspaceId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return { items, page: query.page, pageSize: query.pageSize };
  }

  /** The platform audit log: admin actions on users, account and workspace deletions. */
  async platformAudit(query: { page: number; pageSize: number; action?: string }) {
    const items = await this.platformAuditLog.list(query);
    return { items, page: query.page, pageSize: query.pageSize };
  }

  async eventQueue() {
    return {
      pending: await this.events.pendingCount(),
      failed: await this.events.failedCount(),
      recent: await db
        .select()
        .from(domainEvents)
        .where(and(sql`${domainEvents.processedAt} is null`))
        .orderBy(desc(domainEvents.createdAt))
        .limit(50),
    };
  }

  async dispatchEvents() {
    return { dispatched: await this.events.dispatchPending(200) };
  }

  failedJobsCount() {
    return db.select({ value: count() }).from(jobs).where(eq(jobs.status, "dead"));
  }
}
