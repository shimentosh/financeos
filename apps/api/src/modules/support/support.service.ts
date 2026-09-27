import { type SupportRequestInput, type SupportStatus, supportRequestInput } from "@expensewise/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { assertFound } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { supportRequests, users } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { appLink, EmailService } from "../system/email.service.js";
import { PlatformAuditService } from "../system/platform-audit.service.js";

type Requester = { userId: string | null; workspaceId: string | null; ip: string | null };

/**
 * Messages to the people running the service, from the public contact page
 * and the in-app help form. Each is stored (Admin → Support), sent to
 * SUPPORT_EMAIL (or the platform admins), and acknowledged to the sender.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger("Support");

  constructor(
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
  ) {}

  private async recipients(): Promise<string[]> {
    if (env.SUPPORT_EMAIL) return [env.SUPPORT_EMAIL];
    if (env.ADMIN_EMAILS.length) return env.ADMIN_EMAILS;
    const admins = await db.select({ email: users.email }).from(users).where(eq(users.role, "admin")).limit(5);
    return admins.map((row) => row.email);
  }

  async create(raw: SupportRequestInput, requester: Requester) {
    const input = supportRequestInput.parse(raw);
    const [row] = await db
      .insert(supportRequests)
      .values({
        userId: requester.userId,
        workspaceId: requester.workspaceId,
        email: input.email.toLowerCase(),
        name: input.name ?? null,
        subject: input.subject,
        message: input.message,
        page: input.page ?? null,
      })
      .returning();
    const request = assertFound(row, "Support request");

    const to = await this.recipients();
    if (to.length) {
      void this.email.send({
        to,
        replyTo: request.email,
        subject: `[Support] ${request.subject}`,
        preview: request.message.slice(0, 120),
        heading: request.subject,
        paragraphs: request.message.split(/\n{2,}/),
        details: [
          { label: "From", value: request.name ? `${request.name} <${request.email}>` : request.email },
          { label: "Signed in", value: requester.userId ? "Yes" : "No" },
          ...(request.page ? [{ label: "Page", value: request.page }] : []),
          { label: "Reference", value: request.id },
        ],
        action: { label: "Open in Admin → Support", url: appLink(`/admin/support?focus=${request.id}`) },
        footnote: "Reply to this email to answer the sender directly.",
      });
    } else {
      this.logger.warn(`Support request ${request.id} saved, but no SUPPORT_EMAIL or admin address to notify`);
    }
    void this.email.send({
      to: request.email,
      subject: `We got your message: ${request.subject}`,
      heading: "Thanks — we got your message",
      paragraphs: [`We'll reply to ${request.email}, usually within one working day.`, "If you have more to add, just reply to this email."],
      details: [{ label: "Reference", value: request.id.slice(-8).toUpperCase() }],
      replyTo: to[0],
    });
    return { id: request.id, reference: request.id.slice(-8).toUpperCase() };
  }

  async list(query: { status?: SupportStatus; page: number; pageSize: number }) {
    const where = query.status ? eq(supportRequests.status, query.status) : undefined;
    const [items, [total], counts] = await Promise.all([
      db
        .select()
        .from(supportRequests)
        .where(where)
        .orderBy(desc(supportRequests.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(supportRequests).where(where),
      db.select({ status: supportRequests.status, value: count() }).from(supportRequests).groupBy(supportRequests.status),
    ]);
    return {
      items,
      total: total?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      counts: Object.fromEntries(counts.map((row) => [row.status, row.value])) as Partial<Record<SupportStatus, number>>,
    };
  }

  async setStatus(ids: string[], status: SupportStatus, admin: { id: string; email: string }) {
    const updated = await db
      .update(supportRequests)
      .set({ status })
      .where(and(inArray(supportRequests.id, ids)))
      .returning({ id: supportRequests.id });
    for (const row of updated) {
      await this.platformAudit.record({
        actorId: admin.id,
        actorEmail: admin.email,
        action: `support.${status}`,
        targetType: "support_request",
        targetId: row.id,
      });
    }
    return { updated: updated.length };
  }
}
