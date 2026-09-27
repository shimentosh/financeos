import { Injectable, Logger } from "@nestjs/common";
import { asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { db, type Executor } from "../../db/index.js";
import { domainEvents } from "../../db/schema/index.js";

/** The domain event vocabulary. */
export type DomainEventType =
  | "transaction.created"
  | "transaction.updated"
  | "transaction.confirmed"
  | "transaction.imported"
  | "transaction.voided"
  | "integration.synced"
  | "integration.failed"
  | "invoice.overdue"
  | "budget.threshold_reached"
  | "subscription.renewed"
  | "commitment.paid"
  | "capture.processed";

export type DomainEvent = {
  id: string;
  workspaceId: string | null;
  type: string;
  payload: Record<string, unknown>;
  actorId: string | null;
};

type Handler = (event: DomainEvent) => Promise<void>;

/**
 * A transactional outbox. `publish` writes the event in the caller's database
 * transaction, so an event exists exactly when its change was committed;
 * `dispatchPending` (run by the worker) hands events to their handlers.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger("Events");
  private readonly handlers = new Map<string, Handler[]>();

  on(type: DomainEventType, handler: Handler) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async publish(exec: Executor, ctx: Pick<WorkspaceContext, "workspaceId" | "userId">, type: DomainEventType, payload: Record<string, unknown>) {
    await exec.insert(domainEvents).values({ workspaceId: ctx.workspaceId, type, payload, actorId: ctx.userId });
  }

  async dispatchPending(limit = 50): Promise<number> {
    // Claim a batch atomically so two workers never deliver the same event.
    const claimed = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(domainEvents)
        .where(sql`${domainEvents.processedAt} is null and ${domainEvents.attempts} < 5`)
        .orderBy(asc(domainEvents.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      for (const row of rows) {
        await tx
          .update(domainEvents)
          .set({ attempts: row.attempts + 1 })
          .where(eq(domainEvents.id, row.id));
      }
      return rows;
    });

    for (const event of claimed) {
      const handlers = this.handlers.get(event.type) ?? [];
      try {
        for (const handler of handlers) {
          await handler({ id: event.id, workspaceId: event.workspaceId, type: event.type, payload: event.payload, actorId: event.actorId });
        }
        await db.update(domainEvents).set({ processedAt: new Date(), error: null }).where(eq(domainEvents.id, event.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Event ${event.type} (${event.id}) failed: ${message}`);
        await db.update(domainEvents).set({ error: message }).where(eq(domainEvents.id, event.id));
      }
    }
    return claimed.length;
  }

  /** Housekeeping: processed events older than 30 days. */
  async prune() {
    await db.delete(domainEvents).where(sql`${domainEvents.processedAt} is not null and ${domainEvents.processedAt} < now() - interval '30 days'`);
  }

  pendingCount() {
    return db.$count(domainEvents, isNull(domainEvents.processedAt));
  }

  failedCount() {
    return db.$count(domainEvents, sql`${domainEvents.processedAt} is null and ${domainEvents.attempts} >= 5`);
  }

  staleBefore(date: Date) {
    return db.select().from(domainEvents).where(lt(domainEvents.createdAt, date)).limit(1);
  }
}
