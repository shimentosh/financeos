import { hostname } from "node:os";
import { Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type Executor } from "../../db/index.js";
import { jobs } from "../../db/schema/index.js";

export type JobHandler = (payload: Record<string, unknown>, job: { id: string; workspaceId: string | null; attempts: number }) => Promise<unknown>;

export type EnqueueOptions = {
  workspaceId?: string | null;
  runAt?: Date;
  /** At most one queued or running job per key: re-enqueueing is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
};

const LOCK_TIMEOUT_MINUTES = 10;

/**
 * A job queue on PostgreSQL. Long work — syncs, AI extraction, report
 * generation, reminder scans — runs here instead of in a request. Workers
 * claim with FOR UPDATE SKIP LOCKED, so the API process and any number of
 * `pnpm worker` processes can share one queue.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger("Jobs");
  private readonly handlers = new Map<string, JobHandler>();
  readonly workerId = `${hostname()}:${process.pid}`;

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  registeredTypes() {
    return [...this.handlers.keys()].sort();
  }

  async enqueue(type: string, payload: Record<string, unknown> = {}, options: EnqueueOptions = {}, exec: Executor = db) {
    const [row] = await exec
      .insert(jobs)
      .values({
        type,
        payload,
        workspaceId: options.workspaceId ?? null,
        runAt: options.runAt ?? new Date(),
        dedupeKey: options.dedupeKey ?? null,
        maxAttempts: options.maxAttempts ?? 5,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    return row?.id ?? null;
  }

  /** Claims and runs up to `limit` due jobs. Returns how many ran. */
  async runDue(limit = 5): Promise<number> {
    await this.recoverStale();
    const claimed = await db.execute<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      workspace_id: string | null;
      attempts: number;
      max_attempts: number;
    }>(sql`
      update ${jobs} set status = 'running', locked_at = now(), locked_by = ${this.workerId}, attempts = attempts + 1
      where id in (
        select id from ${jobs}
        where status = 'queued' and run_at <= now()
        order by run_at
        limit ${limit}
        for update skip locked
      )
      returning id, type, payload, workspace_id, attempts, max_attempts
    `);

    await Promise.all(
      claimed.rows.map(async (job) => {
        const handler = this.handlers.get(job.type);
        if (!handler) {
          await this.fail(job.id, job.attempts, job.max_attempts, `No handler registered for ${job.type}`);
          return;
        }
        try {
          const result = await handler(job.payload, { id: job.id, workspaceId: job.workspace_id, attempts: job.attempts });
          await db
            .update(jobs)
            .set({ status: "succeeded", finishedAt: new Date(), result: (result ?? null) as object | null, lockedAt: null, lastError: null })
            .where(eq(jobs.id, job.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Job ${job.type} (${job.id}) failed on attempt ${job.attempts}: ${message}`);
          await this.fail(job.id, job.attempts, job.max_attempts, message);
        }
      }),
    );
    return claimed.rows.length;
  }

  private async fail(id: string, attempts: number, maxAttempts: number, message: string) {
    const dead = attempts >= maxAttempts;
    // Exponential backoff: 30s, 1m, 2m, 4m, ... capped at an hour.
    const delaySeconds = Math.min(3600, 15 * 2 ** attempts);
    await db
      .update(jobs)
      .set({
        status: dead ? "dead" : "queued",
        lastError: message.slice(0, 2000),
        lockedAt: null,
        lockedBy: null,
        runAt: dead ? undefined : new Date(Date.now() + delaySeconds * 1000),
        finishedAt: dead ? new Date() : null,
      })
      .where(eq(jobs.id, id));
  }

  /** A worker that died mid-job leaves it running; hand it back to the queue. */
  private async recoverStale() {
    await db.execute(sql`
      update ${jobs} set status = 'queued', locked_at = null, locked_by = null
      where status = 'running' and locked_at < now() - make_interval(mins => ${LOCK_TIMEOUT_MINUTES})
    `);
  }

  async retry(id: string) {
    await db
      .update(jobs)
      .set({ status: "queued", runAt: new Date(), attempts: 0, lastError: null, finishedAt: null })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ["failed", "dead"])));
  }

  async stats() {
    const rows = await db.select({ status: jobs.status, value: count() }).from(jobs).groupBy(jobs.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.value])) as Record<string, number>;
  }

  recent(limit = 50, status?: "queued" | "running" | "succeeded" | "failed" | "dead") {
    return db
      .select()
      .from(jobs)
      .where(status ? eq(jobs.status, status) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(limit);
  }

  async prune() {
    await db.execute(sql`delete from ${jobs} where status = 'succeeded' and finished_at < now() - interval '14 days'`);
  }
}
