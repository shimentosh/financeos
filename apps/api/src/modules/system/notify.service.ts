import { Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, type Executor } from "../../db/index.js";
import { inboxItems, notifications, userSettings, users, workspaceMembers } from "../../db/schema/index.js";
import type { InboxData } from "../../db/schema/types.js";
import { env } from "../../env.js";
import { appLink, sendEmail } from "./email.service.js";

export type Notice = {
  workspaceId: string;
  /** Recipients; defaults to every member who can act (not viewers). */
  userIds?: string[];
  kind: string;
  severity?: "info" | "success" | "warning" | "critical";
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Same key, same user: never notified twice. */
  dedupeKey: string;
  email?: boolean;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("Notifications");

  async notify(notice: Notice, exec: Executor = db): Promise<number> {
    const recipients =
      notice.userIds ??
      (
        await exec
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, notice.workspaceId), ne(workspaceMembers.role, "viewer")))
      ).map((row) => row.userId);
    if (!recipients.length) return 0;

    const inserted = await exec
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          workspaceId: notice.workspaceId,
          userId,
          kind: notice.kind,
          severity: notice.severity ?? "info",
          title: notice.title,
          body: notice.body ?? null,
          link: notice.link ?? null,
          entityType: notice.entityType ?? null,
          entityId: notice.entityId ?? null,
          dedupeKey: notice.dedupeKey,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notifications.id, userId: notifications.userId });

    if (notice.email !== false && inserted.length && env.RESEND_API_KEY) {
      void this.email(
        inserted.map((row) => row.userId),
        notice,
      ).catch((error) => this.logger.warn(`Email for ${notice.dedupeKey} failed: ${error instanceof Error ? error.message : error}`));
    }
    return inserted.length;
  }

  /** Optional email channel, honouring each user's preference. */
  private async email(userIds: string[], notice: Notice) {
    const rows = await db
      .select({ id: users.id, email: users.email, preferences: userSettings.preferences })
      .from(users)
      .leftJoin(userSettings, eq(userSettings.userId, users.id))
      .where(inArray(users.id, userIds));
    for (const row of rows) {
      if (row.preferences?.notifications?.email === false) continue;
      const result = await sendEmail({
        to: row.email,
        subject: notice.title,
        preview: notice.body ?? undefined,
        heading: notice.title,
        paragraphs: notice.body ? [notice.body] : [],
        action: { label: "Open in Expense Wise", url: appLink(notice.link ?? "/") },
        footnote: "You get these because email alerts are on. Turn them off in Settings → Notifications.",
      });
      if (result.delivered) {
        await db
          .update(notifications)
          .set({ emailedAt: new Date() })
          .where(and(eq(notifications.userId, row.id), eq(notifications.dedupeKey, notice.dedupeKey)));
      }
    }
  }

  list(userId: string, workspaceId: string, options: { unreadOnly?: boolean; limit?: number }) {
    return db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), options.unreadOnly ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(options.limit ?? 50);
  }

  async unreadCount(userId: string, workspaceId: string) {
    const [row] = await db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.workspaceId, workspaceId), isNull(notifications.readAt)));
    return row?.value ?? 0;
  }

  async markRead(userId: string, ids: string[] | "all", workspaceId: string) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.workspaceId, workspaceId),
          isNull(notifications.readAt),
          ids === "all" ? undefined : inArray(notifications.id, ids),
        ),
      );
  }
}

export type InboxUpsert = {
  workspaceId: string;
  kind:
    | "duplicate"
    | "recurring_candidate"
    | "subscription_candidate"
    | "anomaly"
    | "integration_error"
    | "budget_warning"
    | "price_change"
    | "renewal"
    | "large_transaction"
    | "forecast_warning"
    | "receivable_overdue"
    | "observation";
  severity?: "info" | "success" | "warning" | "critical";
  title: string;
  body?: string;
  data?: InboxData;
  entityType?: string;
  entityId?: string;
  dedupeKey: string;
};

@Injectable()
export class InboxService {
  /**
   * Creates the item, or refreshes it while it is still open. A dismissed or
   * resolved item stays that way: the same finding does not come back.
   */
  async upsert(item: InboxUpsert, exec: Executor = db) {
    const [row] = await exec
      .insert(inboxItems)
      .values({
        workspaceId: item.workspaceId,
        kind: item.kind,
        severity: item.severity ?? "info",
        title: item.title,
        body: item.body ?? null,
        data: item.data ?? {},
        entityType: item.entityType ?? null,
        entityId: item.entityId ?? null,
        dedupeKey: item.dedupeKey,
      })
      .onConflictDoUpdate({
        target: [inboxItems.workspaceId, inboxItems.dedupeKey],
        set: { title: item.title, body: item.body ?? null, data: item.data ?? {}, severity: item.severity ?? "info", updatedAt: new Date() },
        setWhere: sql`${inboxItems.status} = 'open'`,
      })
      .returning({ id: inboxItems.id });
    return row?.id ?? null;
  }

  async resolveByKey(workspaceId: string, dedupeKey: string, userId: string | null, exec: Executor = db) {
    await exec
      .update(inboxItems)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: userId })
      .where(and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.dedupeKey, dedupeKey), eq(inboxItems.status, "open")));
  }

  async resolveForEntity(workspaceId: string, entityId: string, kinds: InboxUpsert["kind"][], userId: string | null, exec: Executor = db) {
    await exec
      .update(inboxItems)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: userId })
      .where(and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.entityId, entityId), inArray(inboxItems.kind, kinds), eq(inboxItems.status, "open")));
  }
}
