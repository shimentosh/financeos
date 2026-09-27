import { type Day, diffDays, formatDay, formatMoney, type RenewalAlert, renewalAlerts } from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { commitments, subscriptions } from "../../db/schema/index.js";
import { InboxService, NotificationsService } from "../system/notify.service.js";
import { CommitmentsService } from "./commitments.service.js";
import { GoalsService } from "./goals.service.js";
import { unconfirmedKey } from "./occurrences.service.js";
import { type CommitmentRow, links, type OccurrenceRow, reminderOffsetsFor, type SubscriptionRow } from "./planning.shared.js";
import { SubscriptionsService } from "./subscriptions.service.js";

export type ReminderScanResult = {
  today: Day;
  commitments: number;
  notifications: number;
  inboxItems: number;
  statusChanges: Array<{ id: string; from: string; to: string }>;
  goalsAchieved: number;
};

function inDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/**
 * Renewal wording fits subscriptions; rent, salary and loan installments are
 * payments due (or income expected), so their reminders say so.
 */
function reword(alert: RenewalAlert, commitment: CommitmentRow, amountLabel: string): RenewalAlert {
  const incoming = commitment.direction === "in";
  if (alert.kind === "renewal") {
    const when = inDays(alert.days);
    return {
      ...alert,
      title: incoming ? `${commitment.name} is expected ${when}` : `${commitment.name} is due ${when}`,
      body: incoming
        ? `Expected: ${amountLabel} on ${formatDay(alert.date)}.`
        : commitment.autoPay
          ? `Automatic payment of ${amountLabel} expected on ${formatDay(alert.date)}.`
          : `Payment of ${amountLabel} is due on ${formatDay(alert.date)}. Record it once paid.`,
    };
  }
  if (alert.kind === "unconfirmed" && incoming) {
    return {
      ...alert,
      title: `${commitment.name} not recorded as received`,
      body: `${commitment.name} (${amountLabel}) was expected on ${formatDay(alert.date)} but no receipt has been recorded.`,
    };
  }
  return alert;
}

/**
 * The hourly reminder scan for one workspace. Every notification carries a
 * dedupe key per occurrence, alert kind and reminder offset, so running the
 * scan any number of times sends each reminder once.
 */
@Injectable()
export class RemindersService {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(GoalsService) private readonly goals: GoalsService,
  ) {}

  async scan(ctx: WorkspaceContext, today: Day = todayFor(ctx)): Promise<ReminderScanResult> {
    const statusChanges = await this.subscriptions.refreshStatuses(ctx, today);
    const rows = await db
      .select({ commitment: commitments, subscription: subscriptions })
      .from(commitments)
      .leftJoin(subscriptions, eq(subscriptions.commitmentId, commitments.id))
      .where(
        and(
          eq(commitments.workspaceId, ctx.workspaceId),
          or(eq(commitments.status, "active"), eq(subscriptions.status, "cancellation_pending"), eq(subscriptions.status, "cancelled")),
        ),
      );

    let notifications = 0;
    let inboxItems = 0;
    for (const { commitment, subscription } of rows) {
      const offsets = reminderOffsetsFor(ctx, commitment);
      if (commitment.status === "active") {
        const occurrence = await db.transaction(async (tx) => {
          // Self-heal: an active commitment always has its next occurrence.
          const synced = await this.commitments.syncNext(tx, ctx, commitment.id);
          return synced.status === "active" ? this.commitments.nextScheduled(tx, commitment.id) : null;
        });
        if (!occurrence) continue;
        const sent = await this.remindOccurrence(ctx, commitment, subscription, occurrence, offsets, today);
        notifications += sent.notifications;
        inboxItems += sent.inboxItems;
      } else if (subscription?.expiryDate && subscription.expiryDate >= today) {
        notifications += await this.remindExpiry(ctx, commitment, subscription, offsets, today);
      }
    }

    const goalsAchieved = await this.goals.checkAchievements(ctx);
    return { today, commitments: rows.length, notifications, inboxItems, statusChanges, goalsAchieved };
  }

  private async remindOccurrence(
    ctx: WorkspaceContext,
    commitment: CommitmentRow,
    subscription: SubscriptionRow | null,
    occurrence: OccurrenceRow,
    offsets: number[],
    today: Day,
  ) {
    const amountLabel = formatMoney(occurrence.amount, occurrence.currency);
    const cancelled = subscription?.status === "cancelled" || subscription?.status === "cancellation_pending";
    const alerts = renewalAlerts(
      {
        name: commitment.name,
        amountLabel,
        autoRenew: subscription ? subscription.autoRenew : commitment.autoPay,
        dueDate: occurrence.dueDate,
        expiryDate: subscription?.expiryDate ?? null,
        cancellationDeadline: subscription && !cancelled ? subscription.cancellationDeadline : null,
        unpaid: occurrence.dueDate < today,
        reminderOffsets: offsets,
      },
      today,
    ).map((alert) => (subscription ? alert : reword(alert, commitment, amountLabel)));

    const href = subscription ? links.subscription(subscription.id) : links.commitment(commitment.id);
    let notifications = 0;
    let inboxItems = 0;
    for (const alert of alerts) {
      notifications += await this.notifications.notify({
        workspaceId: ctx.workspaceId,
        kind: alert.kind === "renewal" ? (subscription ? "renewal" : "payment_due") : alert.kind,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        link: href,
        entityType: subscription ? "subscription" : "commitment",
        entityId: subscription?.id ?? commitment.id,
        dedupeKey: `renewal:${occurrence.id}:${alert.kind}:${alert.offset}`,
      });
      if (alert.kind === "unconfirmed") {
        const id = await this.inbox.upsert({
          workspaceId: ctx.workspaceId,
          kind: "renewal",
          severity: "warning",
          title: alert.title,
          body: alert.body,
          data: {
            commitmentId: commitment.id,
            subscriptionId: subscription?.id,
            occurrenceId: occurrence.id,
            amount: occurrence.amount,
            currency: occurrence.currency,
            dueDate: occurrence.dueDate,
            daysOverdue: diffDays(occurrence.dueDate, today),
            href,
          },
          entityType: "commitment",
          entityId: commitment.id,
          dedupeKey: unconfirmedKey(occurrence.id),
        });
        if (id) inboxItems += 1;
      }
    }
    return { notifications, inboxItems };
  }

  /** A cancelled subscription still gets its access-ends notice, nothing else. */
  private async remindExpiry(ctx: WorkspaceContext, commitment: CommitmentRow, subscription: SubscriptionRow, offsets: number[], today: Day) {
    const expiry = subscription.expiryDate as Day;
    const alerts = renewalAlerts(
      {
        name: commitment.name,
        amountLabel: formatMoney(commitment.amount, commitment.currency),
        autoRenew: false,
        dueDate: null,
        expiryDate: expiry,
        reminderOffsets: offsets,
      },
      today,
    ).filter((alert) => alert.kind === "expiry");
    let sent = 0;
    for (const alert of alerts) {
      sent += await this.notifications.notify({
        workspaceId: ctx.workspaceId,
        kind: "expiry",
        severity: alert.severity,
        title: alert.title,
        body: `${commitment.name} was cancelled; access ends ${inDays(alert.days)} (${formatDay(expiry)}).`,
        link: links.subscription(subscription.id),
        entityType: "subscription",
        entityId: subscription.id,
        dedupeKey: `expiry:${subscription.id}:${expiry}:${alert.offset}`,
      });
    }
    return sent;
  }
}
