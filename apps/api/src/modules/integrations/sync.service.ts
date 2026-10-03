import { uuidv7 } from "@financeos/core";
import { SYNC_TRIGGERS, type SyncTrigger, type syncRunQuery } from "@financeos/core/contracts/integrations-extra";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { assertFound, badRequest, conflict } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { integrationConnections, syncRuns } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { SchedulerService } from "../jobs/scheduler.service.js";
import { EventsService } from "../system/events.service.js";
import { JobsService } from "../system/jobs.service.js";
import { InboxService, NotificationsService } from "../system/notify.service.js";
import { defaultHttpClient, type HttpClient, privateNetworkAllowed } from "./connectors/http.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { type AnyConnector, ConnectorError, type RawRecord } from "./connectors/types.js";
import { type IngestScope, PipelineService, type RunDetail, RunLog, recordErrorMessage } from "./pipeline.service.js";
import { type ConnectionRow, connectionInfo, getConnection, integrationContext, loadWorkspace, openCredentials } from "./store.js";

export type SyncRunRow = typeof syncRuns.$inferSelect;

export const SYNC_JOB = "integrations.sync";
const FAILURES_BEFORE_ATTENTION = 3;
/** A sync that has not touched its connection for this long is treated as dead. */
const LEASE_MINUTES = 15;
const DEFAULT_MAX_PAGES = 20;
const HARD_MAX_PAGES = 50;

export type RunOptions = {
  /** A run row created when the sync was queued (manual syncs). */
  runId?: string;
  workspaceId?: string;
  triggeredBy?: string | null;
  /** Injectable for tests: the network and the clock. */
  http?: HttpClient;
  now?: Date;
};

class AlreadyQueued extends Error {}

/** Public shape of a run in lists (no per-record details). */
export function runSummary(run: SyncRunRow & { connectionName?: string | null; provider?: string | null }) {
  const details = (run.errorDetails ?? []) as RunDetail[];
  return {
    id: run.id,
    connectionId: run.connectionId,
    connectionName: run.connectionName ?? null,
    provider: run.provider ?? null,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    recordsFound: run.recordsFound,
    created: run.created,
    updated: run.updated,
    skipped: run.skipped,
    duplicates: run.duplicates,
    errors: run.errors,
    needsReview: details.filter((d) => d.kind === "review").length,
    message: details.find((d) => (d.kind ?? "error") === "error")?.message ?? null,
    triggeredBy: run.triggeredBy,
  };
}

/** Full run: the summary plus its log split by kind. */
export function runDetail(run: SyncRunRow & { connectionName?: string | null; provider?: string | null }) {
  const details = (run.errorDetails ?? []) as RunDetail[];
  const of = (kind: RunDetail["kind"]) => details.filter((d) => (d.kind ?? "error") === kind);
  return {
    ...runSummary(run),
    errorDetails: of("error").map((d) => ({ externalId: d.externalId ?? null, message: d.message })),
    skippedDetails: of("skipped").map((d) => ({ externalId: d.externalId ?? null, message: d.message })),
    reviewDetails: of("review").map((d) => ({ externalId: d.externalId ?? null, message: d.message, transactionId: d.transactionId ?? null })),
    balances: of("balance").map((d) => ({
      accountId: d.accountId ?? null,
      balance: d.balance ?? 0,
      currency: d.currency ?? null,
      asOf: d.asOf ?? null,
      bookBalance: d.bookBalance ?? null,
      difference: d.difference ?? null,
    })),
    cursorBefore: run.cursorBefore ?? null,
    cursorAfter: run.cursorAfter ?? null,
  };
}

/**
 * Runs syncs: pages through the connector (bounded), feeds each page through
 * the pipeline, saves the cursor once the page is committed, then records
 * the outcome on the run and the connection. One job per connection at a time
 * (job dedupe key), and a lease on the connection row keeps two workers from
 * syncing the same connection even when jobs overlap.
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger("Sync");

  constructor(
    @Inject(ConnectorRegistry) private readonly registry: ConnectorRegistry,
    @Inject(PipelineService) private readonly pipeline: PipelineService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  onModuleInit() {
    this.jobs.register(SYNC_JOB, async (payload, job) => {
      const trigger = (SYNC_TRIGGERS as readonly string[]).includes(String(payload.trigger)) ? (payload.trigger as SyncTrigger) : "scheduled";
      const run = await this.run(String(payload.connectionId), trigger, {
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
        workspaceId: job.workspaceId ?? undefined,
        triggeredBy: typeof payload.triggeredBy === "string" ? payload.triggeredBy : null,
      });
      return { runId: run?.id ?? null, status: run?.status ?? "skipped" };
    });
    this.scheduler.register("integrations.schedule", "*/15 * * * *", "Queue integration syncs that are due (hourly/daily)", () => this.enqueueDue());
  }

  /**
   * Queues a sync and returns its run id straight away. When one is already
   * queued or running, returns that instead of starting another.
   */
  async start(ctx: WorkspaceContext, connectionId: string, trigger: SyncTrigger): Promise<{ runId: string | null; status: "queued" | "already_running" }> {
    const connection = await getConnection(ctx, connectionId);
    if (connection.status === "disconnected") throw conflict("Reconnect this integration before syncing it", "disconnected");
    const connector = this.registry.get(connection.provider);
    if (!connector?.capabilities.sync || !connector.fetch)
      throw badRequest(`${connector?.displayName ?? connection.provider} does not sync; it receives webhooks`, "sync_unsupported");
    const runId = uuidv7();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(syncRuns).values({
          id: runId,
          workspaceId: ctx.workspaceId,
          connectionId,
          trigger,
          status: "running",
          triggeredBy: ctx.userId,
          cursorBefore: connection.syncCursor ?? null,
        });
        const jobId = await this.jobs.enqueue(
          SYNC_JOB,
          { connectionId, trigger, runId, triggeredBy: ctx.userId },
          { workspaceId: ctx.workspaceId, dedupeKey: `sync:${connectionId}`, maxAttempts: 3 },
          tx,
        );
        if (!jobId) throw new AlreadyQueued();
      });
      return { runId, status: "queued" };
    } catch (error) {
      if (!(error instanceof AlreadyQueued)) throw error;
      const [active] = await db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(and(eq(syncRuns.connectionId, connectionId), eq(syncRuns.status, "running"), ne(syncRuns.trigger, "webhook")))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      return { runId: active?.id ?? null, status: "already_running" };
    }
  }

  /** Runs one sync to completion. Returns the finished run, or null when nothing ran. */
  async run(connectionId: string, trigger: SyncTrigger, options: RunOptions = {}): Promise<SyncRunRow | null> {
    const [connection] = await db
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.id, connectionId), options.workspaceId ? eq(integrationConnections.workspaceId, options.workspaceId) : undefined))
      .limit(1);
    if (!connection || connection.status === "disconnected") {
      if (options.runId) await this.abandon(options.runId, connection ? "The integration was disconnected" : "The integration no longer exists");
      return null;
    }
    const ctx = await integrationContext(connection.workspaceId);
    const connector = this.registry.get(connection.provider);

    // A run that has not finished within the lease is dead (worker crash).
    await db
      .update(syncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errors: 1,
        errorDetails: [{ kind: "error", message: "The sync was interrupted before it finished" }] as RunDetail[],
      })
      .where(
        and(
          eq(syncRuns.connectionId, connectionId),
          eq(syncRuns.status, "running"),
          lt(syncRuns.startedAt, new Date(Date.now() - LEASE_MINUTES * 60_000)),
          options.runId ? ne(syncRuns.id, options.runId) : undefined,
        ),
      );

    if (connector?.fetch) {
      const leased = await db
        .update(integrationConnections)
        .set({ status: "syncing" })
        .where(
          and(
            eq(integrationConnections.id, connectionId),
            ne(integrationConnections.status, "disconnected"),
            or(ne(integrationConnections.status, "syncing"), lt(integrationConnections.updatedAt, new Date(Date.now() - LEASE_MINUTES * 60_000))),
          ),
        )
        .returning({ id: integrationConnections.id });
      if (!leased.length) {
        if (options.runId) await this.abandon(options.runId, "Another sync of this integration was already running");
        return null;
      }
    }

    const runId = options.runId ?? uuidv7();
    const started = Date.now();
    await db
      .insert(syncRuns)
      .values({
        id: runId,
        workspaceId: connection.workspaceId,
        connectionId,
        trigger,
        status: "running",
        triggeredBy: options.triggeredBy ?? null,
        cursorBefore: connection.syncCursor ?? null,
      })
      .onConflictDoUpdate({ target: syncRuns.id, set: { status: "running", startedAt: new Date(), cursorBefore: connection.syncCursor ?? null } });

    const log = new RunLog();
    let fatal: string | null = null;
    let hasMore = false;
    let cursor: unknown = connection.syncCursor ?? null;

    if (!connector) fatal = `The ${connection.provider} connector is not available`;
    else if (!connector.fetch || !connector.capabilities.sync) fatal = `${connector.displayName} does not sync; it receives webhooks`;
    else {
      try {
        const { credentials, readable } = openCredentials(connection);
        if (!readable) throw new ConnectorError("The stored credentials cannot be decrypted (was ENCRYPTION_KEY changed?). Reconnect this integration.");
        const parsedCredentials = connector.credentialsSchema.safeParse(credentials);
        if (!parsedCredentials.success) throw new ConnectorError(`The saved credentials are incomplete: ${recordErrorMessage(parsedCredentials.error)}`);
        const parsedConfig = connector.configSchema.safeParse(connection.config ?? {});
        if (!parsedConfig.success) throw new ConnectorError(`The configuration is invalid: ${recordErrorMessage(parsedConfig.error)}`);
        const workspace = await loadWorkspace(connection.workspaceId);
        const info = connectionInfo(connection, workspace);
        const config = parsedConfig.data as Record<string, unknown>;
        const scope: IngestScope = { ctx, connection, config, runId };
        const maxPages = Math.min(connector.maxPagesPerRun ?? DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
        let pages = 0;
        do {
          const page = await connector.fetch(
            {
              connection: info,
              config,
              credentials: parsedCredentials.data,
              http: options.http ?? defaultHttpClient,
              now: options.now ?? new Date(),
              allowPrivateNetwork: privateNetworkAllowed(config, env.NODE_ENV),
            },
            { cursor, since: connection.lastSuccessAt, trigger },
          );
          pages++;
          const records = this.pipeline.normalize(connector, page.records, { ...info, config }, log);
          await this.pipeline.ingest(scope, records, log);
          // The page is committed; only now does the cursor move past it.
          cursor = page.nextCursor ?? null;
          await db.update(integrationConnections).set({ syncCursor: cursor }).where(eq(integrationConnections.id, connectionId));
          hasMore = page.hasMore;
        } while (hasMore && pages < maxPages);
      } catch (error) {
        fatal = recordErrorMessage(error, this.logger);
        if (fatal === "Unexpected error while importing this record") fatal = error instanceof Error ? error.message.slice(0, 300) : "The sync failed";
      }
    }

    const run = await this.finish(ctx, connection, runId, trigger, log, { fatal, cursorAfter: cursor, started });
    if (hasMore && !fatal) {
      // Bounded runs: the rest continues in a follow-up run.
      await this.jobs.enqueue(
        SYNC_JOB,
        { connectionId, trigger: "incremental" },
        { workspaceId: connection.workspaceId, dedupeKey: `sync:${connectionId}:continue`, runAt: new Date(Date.now() + 5_000), maxAttempts: 3 },
      );
    }
    return run;
  }

  /**
   * Imports records that arrived by webhook through the same pipeline, as a
   * run with trigger "webhook". Does not take the sync lease.
   */
  async ingestPushed(connection: ConnectionRow, connector: AnyConnector, raws: RawRecord[], triggeredBy: string | null): Promise<SyncRunRow | null> {
    const ctx = await integrationContext(connection.workspaceId);
    const workspace = await loadWorkspace(connection.workspaceId);
    const runId = uuidv7();
    const started = Date.now();
    await db.insert(syncRuns).values({
      id: runId,
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      trigger: "webhook",
      status: "running",
      triggeredBy,
      cursorBefore: null,
    });
    const log = new RunLog();
    let fatal: string | null = null;
    try {
      const parsedConfig = connector.configSchema.safeParse(connection.config ?? {});
      if (!parsedConfig.success) throw new ConnectorError(`The configuration is invalid: ${recordErrorMessage(parsedConfig.error)}`);
      const config = parsedConfig.data as Record<string, unknown>;
      const records = this.pipeline.normalize(connector, raws, { ...connectionInfo(connection, workspace), config }, log);
      await this.pipeline.ingest({ ctx, connection, config, runId }, records, log);
    } catch (error) {
      fatal = recordErrorMessage(error, this.logger);
    }
    return this.finish(ctx, connection, runId, "webhook", log, { fatal, cursorAfter: null, started });
  }

  private async abandon(runId: string, message: string) {
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), durationMs: 0, errors: 1, errorDetails: [{ kind: "error", message }] as RunDetail[] })
      .where(and(eq(syncRuns.id, runId), eq(syncRuns.status, "running")));
  }

  /** Records the outcome on the run and the connection; failure streaks raise an inbox item. */
  private async finish(
    ctx: WorkspaceContext,
    before: ConnectionRow,
    runId: string,
    trigger: SyncTrigger,
    log: RunLog,
    outcome: { fatal: string | null; cursorAfter: unknown; started: number },
  ): Promise<SyncRunRow> {
    if (outcome.fatal) log.error(undefined, outcome.fatal);
    const succeededRecords = log.created + log.updated + log.duplicates + log.skipped;
    const status: SyncRunRow["status"] = log.errors === 0 ? "succeeded" : succeededRecords > 0 ? "partial" : "failed";
    const failed = status === "failed";
    const finishedAt = new Date();

    return db.transaction(async (tx) => {
      const [run] = await tx
        .update(syncRuns)
        .set({
          status,
          finishedAt,
          durationMs: finishedAt.getTime() - outcome.started,
          recordsFound: log.found,
          created: log.created,
          updated: log.updated,
          skipped: log.skipped,
          duplicates: log.duplicates,
          errors: log.errors,
          errorDetails: log.details(),
          cursorAfter: (outcome.cursorAfter ?? null) as object | null,
        })
        .where(eq(syncRuns.id, runId))
        .returning();

      const [current] = await tx.select().from(integrationConnections).where(eq(integrationConnections.id, before.id)).for("update");
      if (!current) return run as SyncRunRow;
      const failures = failed ? current.consecutiveFailures + 1 : 0;
      let nextStatus = current.status;
      if (current.status !== "disconnected" && !(trigger === "webhook" && current.status === "syncing")) {
        nextStatus = failed ? (failures >= FAILURES_BEFORE_ATTENTION ? "needs_attention" : "error") : "connected";
      }
      const message = failed
        ? (outcome.fatal ?? log.firstError ?? "The sync failed")
        : log.errors
          ? `${log.errors} of ${log.found} records could not be imported${log.firstError ? `: ${log.firstError}` : ""}`
          : null;
      await tx
        .update(integrationConnections)
        .set({
          status: nextStatus,
          lastSyncedAt: finishedAt,
          ...(failed ? {} : { lastSuccessAt: finishedAt }),
          ...(log.errors ? { lastErrorAt: finishedAt } : {}),
          errorMessage: message?.slice(0, 500) ?? null,
          consecutiveFailures: failures,
          recordsTotal: sql`${integrationConnections.recordsTotal} + ${log.created}`,
        })
        .where(eq(integrationConnections.id, before.id));

      // One inbox item per failure streak (keyed by the last success), resolved on recovery.
      const streak = `integration_error:${before.id}:${current.lastSuccessAt?.getTime() ?? 0}`;
      if (failed && failures >= FAILURES_BEFORE_ATTENTION && current.status !== "disconnected") {
        await this.inbox.upsert(
          {
            workspaceId: ctx.workspaceId,
            kind: "integration_error",
            severity: "critical",
            title: `${current.name} needs attention`,
            body: `The last ${failures} syncs failed: ${message}. Check the credentials and settings, or reconnect.`,
            data: { connectionId: current.id, href: `/integrations/${current.id}?tab=runs&run=${runId}` },
            entityType: "integration_connection",
            entityId: current.id,
            dedupeKey: streak,
          },
          tx,
        );
        await this.notifications.notify(
          {
            workspaceId: ctx.workspaceId,
            kind: "integration_error",
            severity: "critical",
            title: `${current.name} stopped syncing`,
            body: `${failures} syncs in a row failed: ${message}`,
            link: `/integrations/${current.id}?tab=runs&run=${runId}`,
            entityType: "integration_connection",
            entityId: current.id,
            dedupeKey: streak,
          },
          tx,
        );
      }
      if (!failed && (current.consecutiveFailures > 0 || current.status === "needs_attention" || current.status === "error")) {
        await this.inbox.resolveForEntity(ctx.workspaceId, current.id, ["integration_error"], null, tx);
      }
      await this.events.publish(tx, ctx, failed ? "integration.failed" : "integration.synced", {
        connectionId: current.id,
        provider: current.provider,
        runId,
        trigger,
        status,
        created: log.created,
        updated: log.updated,
        duplicates: log.duplicates,
        errors: log.errors,
      });
      return run as SyncRunRow;
    });
  }

  /** The 15-minute scheduler: queues hourly/daily connections that are due. */
  async enqueueDue(now = new Date()): Promise<number> {
    const providers = this.registry.syncProviders();
    if (!providers.length) return 0;
    const hourAgo = new Date(now.getTime() - 55 * 60_000);
    const dayAgo = new Date(now.getTime() - (24 * 60 - 15) * 60_000);
    // Connections left "syncing" by a crashed worker become visible again.
    await db
      .update(integrationConnections)
      .set({ status: "error", errorMessage: "The last sync was interrupted; it will retry" })
      .where(and(eq(integrationConnections.status, "syncing"), lt(integrationConnections.updatedAt, new Date(now.getTime() - 30 * 60_000))));
    const due = await db
      .select({ id: integrationConnections.id, workspaceId: integrationConnections.workspaceId, lastSyncedAt: integrationConnections.lastSyncedAt })
      .from(integrationConnections)
      .where(
        and(
          inArray(integrationConnections.provider, providers),
          inArray(integrationConnections.status, ["connected", "error", "needs_attention"]),
          ne(integrationConnections.syncFrequency, "manual"),
          or(
            isNull(integrationConnections.lastSyncedAt),
            and(eq(integrationConnections.syncFrequency, "hourly"), lt(integrationConnections.lastSyncedAt, hourAgo)),
            and(eq(integrationConnections.syncFrequency, "daily"), lt(integrationConnections.lastSyncedAt, dayAgo)),
          ),
        ),
      );
    let queued = 0;
    for (const connection of due) {
      const id = await this.jobs.enqueue(
        SYNC_JOB,
        { connectionId: connection.id, trigger: connection.lastSyncedAt ? "scheduled" : "initial" },
        { workspaceId: connection.workspaceId, dedupeKey: `sync:${connection.id}`, maxAttempts: 3 },
      );
      if (id) queued++;
    }
    if (queued) this.logger.log(`Queued ${queued} integration syncs`);
    return queued;
  }

  async list(ctx: WorkspaceContext, query: z.output<typeof syncRunQuery>) {
    const where = and(
      eq(syncRuns.workspaceId, ctx.workspaceId),
      query.connectionId ? eq(syncRuns.connectionId, query.connectionId) : undefined,
      query.status?.length ? inArray(syncRuns.status, query.status) : undefined,
      query.trigger?.length ? inArray(syncRuns.trigger, query.trigger) : undefined,
      query.from ? gte(syncRuns.startedAt, sql`(${query.from}::date)::timestamp at time zone ${ctx.timezone}`) : undefined,
      query.to ? lt(syncRuns.startedAt, sql`((${query.to}::date + 1)::timestamp) at time zone ${ctx.timezone}`) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({ run: syncRuns, connectionName: integrationConnections.name, provider: integrationConnections.provider })
        .from(syncRuns)
        .innerJoin(integrationConnections, eq(integrationConnections.id, syncRuns.connectionId))
        .where(where)
        .orderBy(desc(syncRuns.startedAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(syncRuns).where(where),
    ]);
    return {
      items: rows.map((row) => runSummary({ ...row.run, connectionName: row.connectionName, provider: row.provider })),
      total: total?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(ctx: WorkspaceContext, id: string) {
    const [row] = await db
      .select({ run: syncRuns, connectionName: integrationConnections.name, provider: integrationConnections.provider })
      .from(syncRuns)
      .innerJoin(integrationConnections, eq(integrationConnections.id, syncRuns.connectionId))
      .where(and(eq(syncRuns.id, id), eq(syncRuns.workspaceId, ctx.workspaceId)))
      .limit(1);
    const found = assertFound(row, "Sync run");
    return runDetail({ ...found.run, connectionName: found.connectionName, provider: found.provider });
  }

  /** Runs a failed or partial sync again, resuming from the last committed cursor. */
  async retry(ctx: WorkspaceContext, id: string) {
    const [run] = await db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.id, id), eq(syncRuns.workspaceId, ctx.workspaceId)))
      .limit(1);
    const found = assertFound(run, "Sync run");
    if (found.status !== "failed" && found.status !== "partial") throw conflict("Only failed or partial runs can be retried", "not_retryable");
    if (found.trigger === "webhook") throw badRequest("Webhook runs are retried by the sender; sync the integration instead", "not_retryable");
    return this.start(ctx, found.connectionId, "retry");
  }
}
