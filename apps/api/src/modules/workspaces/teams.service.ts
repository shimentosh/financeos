import { createHash, randomBytes } from "node:crypto";
import { type AssignableRole, assignableRolesFor, canManageMember, INVITATION_TTL_DAYS, type InvitationStatus, type MemberRole } from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { contextFor, type SessionUser, type WorkspaceContext } from "../../common/context.js";
import { assertFound, badRequest, conflict, forbidden, notFound, unauthorized } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { userSettings, users, workspaceInvitations, workspaceMembers, workspaces } from "../../db/schema/index.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../system/audit.service.js";
import { appLink, EmailService } from "../system/email.service.js";
import { NotificationsService } from "../system/notify.service.js";
import { fallbackWorkspace, rememberActiveWorkspace } from "./workspace-cookie.js";
import { WorkspaceDeletionService } from "./workspace-deletion.service.js";

const DAY_MS = 86_400_000;
/** Invitations stay listed this long after they lapse, so they can be resent. */
const EXPIRED_VISIBLE_DAYS = 30;
const OPEN_STATUSES: InvitationStatus[] = ["pending", "expired"];
const ROLE_ORDER: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const invitationExpiry = () => new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS);
const article = (role: string) => (role === "admin" ? "an" : "a");

/** The link an invitation email carries. Only its SHA-256 is stored. */
export const invitationLink = (token: string) => appLink(`/invite?token=${encodeURIComponent(token)}`);

/** r***@gmail.com: enough for the right person to recognise, not enough to harvest. */
export function maskEmail(email: string) {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

type InvitationRow = typeof workspaceInvitations.$inferSelect;
type Actor = Pick<SessionUser, "id" | "name" | "email">;

/** An invitation as the members screen sees it: never its token or hash. */
function shapeInvitation(invitation: InvitationRow, inviterName: string | null) {
  const expired = invitation.status === "expired" || (invitation.status === "pending" && invitation.expiresAt < new Date());
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: expired ? ("expired" as const) : invitation.status,
    expired,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    invitedBy: invitation.invitedBy ? { id: invitation.invitedBy, name: inviterName ?? "Someone" } : null,
  };
}
type InvitationView = ReturnType<typeof shapeInvitation>;

/** What the role lets the invited person do, as the email puts it. */
const ROLE_IN_EMAIL: Record<MemberRole, string> = {
  owner: "As the owner you can manage everything, including the plan.",
  admin: "As an admin you can manage settings, people and every record.",
  member: "As a member you can add and edit records.",
  viewer: "As a viewer you can see everything but not change anything.",
};

/**
 * Who belongs to a workspace and how they got there. People join only through
 * an emailed, single-use invitation that the signed-in owner of the verified
 * invited address accepts; roles change within strict rules (nobody touches
 * the owner, admins manage only members and viewers); ownership moves only by
 * transfer to a verified member. Every change is audited in the workspace.
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(WorkspaceDeletionService) private readonly deletion: WorkspaceDeletionService,
  ) {}

  // ── Members ────────────────────────────────────────────────────────────────

  async listMembers(ctx: WorkspaceContext) {
    const rows = await db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        emailVerified: users.emailVerified,
        joinedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, ctx.workspaceId))
      .orderBy(asc(workspaceMembers.createdAt));
    return rows.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  }

  async changeRole(ctx: WorkspaceContext, memberId: string, role: AssignableRole) {
    const target = await this.findMember(ctx, memberId);
    if (target.userId === ctx.userId) throw forbidden("You can't change your own role", "own_role");
    if (target.role === "owner") throw forbidden("The owner's role can't be changed. The owner can transfer ownership instead.", "owner_protected");
    if (!canManageMember(ctx.role, target.role) || !assignableRolesFor(ctx.role).includes(role)) {
      throw forbidden(
        ctx.role === "admin" ? "Admins can change members and viewers, and only to member or viewer" : "You can't change this person's role",
        "role_not_allowed",
      );
    }
    if (target.role === role) return { ...target, role };
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(workspaceMembers)
        .set({ role })
        .where(and(eq(workspaceMembers.id, target.id), eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.role, target.role)))
        .returning();
      if (!row) throw conflict("This person's role changed meanwhile. Reload and try again.", "member_changed");
      await this.audit.record(tx, ctx, {
        action: "member.role_changed",
        entityType: "member",
        entityId: row.id,
        before: { userId: target.userId, email: target.email, role: target.role },
        after: { userId: target.userId, email: target.email, role },
      });
      return { ...target, role: row.role };
    });
  }

  async removeMember(ctx: WorkspaceContext, memberId: string) {
    const target = await this.findMember(ctx, memberId);
    if (target.userId === ctx.userId) throw forbidden("To remove yourself, leave the workspace instead", "use_leave");
    if (target.role === "owner") throw forbidden("The owner can't be removed from their workspace", "owner_protected");
    if (!canManageMember(ctx.role, target.role)) throw forbidden("Admins can remove members and viewers only", "role_not_allowed");
    await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.id, target.id), eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.role, target.role)))
        .returning({ id: workspaceMembers.id });
      if (!row) throw conflict("This person's role changed meanwhile. Reload and try again.", "member_changed");
      await this.forgetActiveWorkspace(tx, target.userId, ctx.workspaceId);
      await this.audit.record(tx, ctx, {
        action: "member.removed",
        entityType: "member",
        entityId: target.id,
        before: { userId: target.userId, email: target.email, role: target.role },
      });
    });
    return { removed: true };
  }

  /** Any member but the owner may leave; the next workspace they belong to becomes active. */
  async leave(ctx: WorkspaceContext) {
    const userId = this.userOf(ctx);
    if (ctx.role === "owner") throw forbidden("Transfer ownership to someone else before you leave this workspace", "owner_cannot_leave");
    await this.assertNotLastWorkspace(userId, "You can't leave your only workspace. Create another one first.");
    return db.transaction(async (tx) => {
      const [row] = await tx
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)))
        .returning();
      if (!row) throw notFound("Membership");
      await this.audit.record(tx, ctx, { action: "member.left", entityType: "member", entityId: row.id, before: { userId, role: row.role } });
      return { left: true, workspaceId: await fallbackWorkspace(userId, tx) };
    });
  }

  /**
   * Hands the workspace to another member with a verified email. They become
   * the owner (their plan now covers it), the previous owner becomes an admin.
   */
  async transferOwnership(ctx: WorkspaceContext, targetUserId: string, actor: Actor) {
    const ownerId = this.userOf(ctx);
    if (ctx.role !== "owner") throw forbidden("Only the owner can transfer ownership", "owner_only");
    if (targetUserId === ownerId) throw badRequest("You already own this workspace", "already_owner");
    const [target] = await db
      .select({ memberId: workspaceMembers.id, role: workspaceMembers.role, email: users.email, name: users.name, emailVerified: users.emailVerified })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw notFound("Member");
    if (!target.emailVerified) {
      throw forbidden(`${target.name} needs to verify their email address before they can own a workspace`, "email_unverified");
    }
    // The workspace joins the plan of its new owner.
    await this.entitlements.assertCanCreateWorkspace(targetUserId);
    await db.transaction(async (tx) => {
      const [previous] = await tx
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, ownerId), eq(workspaceMembers.role, "owner")))
        .returning({ id: workspaceMembers.id });
      if (!previous) throw conflict("Ownership changed meanwhile. Reload and try again.", "ownership_changed");
      await tx.update(workspaceMembers).set({ role: "owner" }).where(eq(workspaceMembers.id, target.memberId));
      await this.audit.record(tx, ctx, {
        action: "workspace.ownership_transferred",
        entityType: "workspace",
        entityId: ctx.workspaceId,
        before: { ownerId, newOwnerRole: target.role },
        after: { ownerId: targetUserId, ownerEmail: target.email, previousOwnerRole: "admin" },
      });
    });
    await this.email.send({
      to: target.email,
      subject: `You now own ${ctx.workspaceName} on Expense Wise`,
      heading: `${ctx.workspaceName} is yours now`,
      paragraphs: [
        `${actor.name} made you the owner of the workspace "${ctx.workspaceName}". You can manage its members, its plan, and delete it if it is ever no longer needed.`,
        `${actor.name} stays in the workspace as an admin.`,
      ],
      action: { label: "Open Expense Wise", url: appLink("/settings/workspace") },
    });
    return { ownerId: targetUserId };
  }

  /**
   * Deletes the workspace and everything in it. Owner only, the name typed to
   * confirm, and never the user's last workspace.
   */
  async deleteWorkspace(ctx: WorkspaceContext, confirmName: string, actor: Actor) {
    if (ctx.role !== "owner") throw forbidden("Only the owner can delete this workspace", "owner_only");
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    const found = assertFound(workspace, "Workspace");
    if (confirmName !== found.name.trim()) throw badRequest("Type the workspace name exactly as shown to confirm", "confirm_name_mismatch");
    await this.assertNotLastWorkspace(actor.id, "You can't delete your only workspace. Create another one first, or delete your account instead.");
    const others = await db
      .select({ email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), ne(workspaceMembers.userId, actor.id)));

    await this.deletion.delete(ctx.workspaceId, { userId: actor.id, email: actor.email, ip: ctx.ip ?? null, reason: "workspace_deleted" });
    const next = await fallbackWorkspace(actor.id);
    for (const person of others) {
      await this.email.send({
        to: person.email,
        subject: `${found.name} was deleted`,
        heading: `${found.name} was deleted`,
        paragraphs: [
          `${actor.name} deleted the workspace "${found.name}" on Expense Wise, together with its records and files.`,
          "Your other workspaces are not affected.",
        ],
      });
    }
    return { deleted: true, workspaceId: next };
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  /**
   * Open invitations: pending ones, and recently lapsed ones that can be
   * resent. One per address (the latest), none for people who already joined.
   */
  async listInvitations(ctx: WorkspaceContext) {
    await this.expireStale(eq(workspaceInvitations.workspaceId, ctx.workspaceId));
    const inviter = alias(users, "inviter");
    const since = new Date(Date.now() - EXPIRED_VISIBLE_DAYS * DAY_MS);
    const rows = await db
      .select({ invitation: workspaceInvitations, inviterName: inviter.name })
      .from(workspaceInvitations)
      .leftJoin(inviter, eq(inviter.id, workspaceInvitations.invitedBy))
      .where(
        and(eq(workspaceInvitations.workspaceId, ctx.workspaceId), or(eq(workspaceInvitations.status, "pending"), gte(workspaceInvitations.expiresAt, since))),
      )
      .orderBy(desc(workspaceInvitations.createdAt));
    const members = new Set((await this.listMembers(ctx)).map((member) => member.email.toLowerCase()));
    const seen = new Set<string>();
    const open: InvitationView[] = [];
    for (const row of rows) {
      if (seen.has(row.invitation.email)) continue;
      seen.add(row.invitation.email);
      if (members.has(row.invitation.email) || !OPEN_STATUSES.includes(row.invitation.status)) continue;
      open.push(shapeInvitation(row.invitation, row.inviterName));
    }
    return open;
  }

  /**
   * Invites someone by email. Re-inviting the same address replaces the open
   * invitation (the old link stops working). The link is returned to the
   * inviter too, to share another way if email is slow or not set up.
   */
  async invite(ctx: WorkspaceContext, input: { email: string; role: AssignableRole }, actor: Actor) {
    this.assertMayOffer(ctx, input.role);
    const email = input.email.trim().toLowerCase();
    const [member] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), sql`lower(${users.email}) = ${email}`))
      .limit(1);
    if (member) throw conflict(`${email} is already a member of this workspace`, "already_member");

    await this.expireStale(eq(workspaceInvitations.workspaceId, ctx.workspaceId));
    const [open] = await db
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(and(eq(workspaceInvitations.workspaceId, ctx.workspaceId), eq(workspaceInvitations.email, email), eq(workspaceInvitations.status, "pending")))
      .limit(1);
    // A replacement takes no extra seat: the open invitation it revokes was already counted.
    await this.entitlements.assertCanAddMember(ctx.workspaceId, open ? 0 : 1);

    const token = newToken();
    const invitation = await db.transaction(async (tx) => {
      const replaced = await tx
        .update(workspaceInvitations)
        .set({ status: "revoked" })
        .where(and(eq(workspaceInvitations.workspaceId, ctx.workspaceId), eq(workspaceInvitations.email, email), eq(workspaceInvitations.status, "pending")))
        .returning({ id: workspaceInvitations.id });
      const [row] = await tx
        .insert(workspaceInvitations)
        .values({ workspaceId: ctx.workspaceId, email, role: input.role, tokenHash: hashToken(token), invitedBy: actor.id, expiresAt: invitationExpiry() })
        .returning();
      const created = assertFound(row, "Invitation");
      await this.audit.record(tx, ctx, {
        action: "invitation.created",
        entityType: "invitation",
        entityId: created.id,
        after: { email, role: created.role, expiresAt: created.expiresAt, replaced: replaced.map((r) => r.id) },
      });
      return created;
    });
    const emailSent = await this.sendInvitation(ctx, invitation, token, actor);
    return { invitation: shapeInvitation(invitation, actor.name), link: invitationLink(token), emailSent };
  }

  /** A new link for an open (or lapsed) invitation, emailed unless `sendEmail` is false. The previous link stops working. */
  async resend(ctx: WorkspaceContext, invitationId: string, options: { sendEmail: boolean }, actor: Actor) {
    const invitation = await this.findInvitation(ctx, invitationId);
    this.assertMayOffer(ctx, invitation.role);
    if (!OPEN_STATUSES.includes(invitation.status)) throw conflict(`This invitation was already ${invitation.status}`, "invitation_closed");
    const lapsed = invitation.status === "expired" || invitation.expiresAt < new Date();
    // A lapsed invitation stopped counting against the plan; reviving it takes a seat again.
    if (lapsed) await this.entitlements.assertCanAddMember(ctx.workspaceId, 1);
    const token = newToken();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(workspaceInvitations)
        .set({ tokenHash: hashToken(token), status: "pending", expiresAt: invitationExpiry() })
        .where(
          and(
            eq(workspaceInvitations.id, invitation.id),
            eq(workspaceInvitations.workspaceId, ctx.workspaceId),
            inArray(workspaceInvitations.status, OPEN_STATUSES),
          ),
        )
        .returning();
      if (!row) throw conflict("This invitation changed meanwhile. Reload and try again.", "invitation_closed");
      await this.audit.record(tx, ctx, {
        action: "invitation.resent",
        entityType: "invitation",
        entityId: row.id,
        after: { email: row.email, role: row.role, expiresAt: row.expiresAt, emailed: options.sendEmail },
      });
      return row;
    });
    const emailSent = options.sendEmail ? await this.sendInvitation(ctx, updated, token, actor) : false;
    return { invitation: shapeInvitation(updated, actor.name), link: invitationLink(token), emailSent };
  }

  async revoke(ctx: WorkspaceContext, invitationId: string) {
    const invitation = await this.findInvitation(ctx, invitationId);
    this.assertMayOffer(ctx, invitation.role);
    if (!OPEN_STATUSES.includes(invitation.status)) throw conflict(`This invitation was already ${invitation.status}`, "invitation_closed");
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(workspaceInvitations)
        .set({ status: "revoked" })
        .where(
          and(
            eq(workspaceInvitations.id, invitation.id),
            eq(workspaceInvitations.workspaceId, ctx.workspaceId),
            inArray(workspaceInvitations.status, OPEN_STATUSES),
          ),
        )
        .returning({ id: workspaceInvitations.id });
      if (!row) throw conflict("This invitation changed meanwhile. Reload and try again.", "invitation_closed");
      await this.audit.record(tx, ctx, {
        action: "invitation.revoked",
        entityType: "invitation",
        entityId: invitation.id,
        before: { email: invitation.email, role: invitation.role, status: invitation.status },
        after: { status: "revoked" },
      });
    });
    return { revoked: true };
  }

  /**
   * What the invitation page shows, to anyone holding the link: the address
   * it was sent to is masked. With a session, whether that person can accept.
   */
  async lookup(token: string, viewerId: string | null) {
    const inviter = alias(users, "inviter");
    const [row] = await db
      .select({ invitation: workspaceInvitations, workspaceName: workspaces.name, workspaceKind: workspaces.kind, inviterName: inviter.name })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .leftJoin(inviter, eq(inviter.id, workspaceInvitations.invitedBy))
      .where(eq(workspaceInvitations.tokenHash, hashToken(token)))
      .limit(1);
    if (!row) throw notFound("Invitation");
    const { invitation } = row;
    let status = invitation.status;
    if (status === "pending" && invitation.expiresAt < new Date()) {
      await this.expireStale(eq(workspaceInvitations.id, invitation.id));
      status = "expired";
    }

    let viewer: { email: string; emailVerified: boolean; matches: boolean; alreadyMember: boolean; workspaceId: string | null } | null = null;
    if (viewerId) {
      const [account] = await db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, viewerId));
      if (account) {
        const [membership] = await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, viewerId)))
          .limit(1);
        viewer = {
          email: account.email,
          emailVerified: account.emailVerified,
          matches: account.email.toLowerCase() === invitation.email,
          alreadyMember: Boolean(membership),
          // Only a member learns the workspace id, to open it.
          workspaceId: membership ? invitation.workspaceId : null,
        };
      }
    }
    return {
      workspaceName: row.workspaceName,
      workspaceKind: row.workspaceKind,
      inviterName: row.inviterName ?? "Someone",
      role: invitation.role,
      email: maskEmail(invitation.email),
      status,
      expired: status === "expired",
      expiresAt: invitation.expiresAt,
      viewer,
    };
  }

  /**
   * Accepts an invitation as the signed-in user. The token must be open and
   * unexpired, the user's email must be the invited one and verified. Joins
   * the workspace (or, already a member, keeps their role) and makes it the
   * active workspace. A link works once.
   */
  async accept(user: SessionUser, token: string, ip?: string) {
    const [invitation] = await db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, hashToken(token)))
      .limit(1);
    if (!invitation) throw notFound("Invitation");
    const [account] = await db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, user.id));
    if (!account) throw unauthorized();
    const [existing] = await db
      .select({ id: workspaceMembers.id, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, user.id)))
      .limit(1);

    if (invitation.status === "accepted") {
      // A second click by the same person is harmless. Nobody else can use the
      // link, and it can't bring back someone who was removed since.
      if (invitation.acceptedBy === user.id && existing) return { workspaceId: invitation.workspaceId, role: existing.role, alreadyMember: true };
      throw conflict("This invitation has already been used. Ask for a new one if you still need access.", "invitation_used");
    }
    if (invitation.status === "revoked") throw conflict("This invitation was withdrawn. Ask for a new one if you still need access.", "invitation_revoked");
    if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
      await this.expireStale(eq(workspaceInvitations.id, invitation.id));
      throw conflict("This invitation has expired. Ask the person who invited you to send a new one.", "invitation_expired");
    }
    if (account.email.toLowerCase() !== invitation.email) {
      throw forbidden(
        `This invitation is for ${maskEmail(invitation.email)}, but you are signed in as ${account.email}. Sign in with the invited address to accept it.`,
        "invitation_email_mismatch",
      );
    }
    if (!account.emailVerified) {
      throw forbidden("Verify your email address first, then open the invitation link again.", "email_unverified");
    }
    // The open invitation already counts toward the plan; this checks the plan still has room for it.
    if (!existing) await this.entitlements.assertCanAddMember(invitation.workspaceId, 0);

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, invitation.workspaceId));
    const found = assertFound(workspace, "Workspace");
    return db.transaction(async (tx) => {
      // Claims the invitation: only one acceptance can move it out of pending.
      const [claimed] = await tx
        .update(workspaceInvitations)
        .set({ status: "accepted", acceptedAt: new Date(), acceptedBy: user.id })
        .where(and(eq(workspaceInvitations.id, invitation.id), eq(workspaceInvitations.status, "pending")))
        .returning({ id: workspaceInvitations.id });
      if (!claimed) throw conflict("This invitation has already been used. Ask for a new one if you still need access.", "invitation_used");

      let memberId = existing?.id ?? null;
      let role: MemberRole = existing?.role ?? invitation.role;
      if (!existing) {
        const [row] = await tx
          .insert(workspaceMembers)
          .values({ workspaceId: found.id, userId: user.id, role: invitation.role })
          .onConflictDoNothing()
          .returning({ id: workspaceMembers.id, role: workspaceMembers.role });
        memberId = row?.id ?? null;
        role = row?.role ?? role;
      }
      await rememberActiveWorkspace(user.id, found.id, tx);
      const ctx = contextFor(found, { userId: user.id, actorType: "user", role, ip });
      await this.audit.record(tx, ctx, {
        action: "member.joined",
        entityType: "member",
        entityId: memberId,
        after: { userId: user.id, email: account.email, role, invitationId: invitation.id, invitedBy: invitation.invitedBy, alreadyMember: Boolean(existing) },
      });
      if (invitation.invitedBy && invitation.invitedBy !== user.id) {
        await this.notifications.notify(
          {
            workspaceId: found.id,
            userIds: [invitation.invitedBy],
            kind: "member_joined",
            severity: "success",
            title: `${user.name} joined ${found.name}`,
            body: `They accepted your invitation as ${article(role)} ${role}.`,
            link: "/settings/workspace",
            entityType: "member",
            entityId: memberId ?? undefined,
            dedupeKey: `invitation-accepted:${invitation.id}`,
            email: false,
          },
          tx,
        );
      }
      return { workspaceId: found.id, role, alreadyMember: Boolean(existing) };
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private userOf(ctx: WorkspaceContext): string {
    if (!ctx.userId) throw forbidden("Only a signed-in person can do this");
    return ctx.userId;
  }

  private assertMayOffer(ctx: WorkspaceContext, role: MemberRole) {
    if (role === "owner" || !assignableRolesFor(ctx.role).includes(role)) {
      throw forbidden(
        ctx.role === "admin" ? "Admins can invite members and viewers. Only the owner can add admins." : "You can't invite people with that role",
        "role_not_allowed",
      );
    }
  }

  private async findMember(ctx: WorkspaceContext, memberId: string) {
    const [row] = await db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        emailVerified: users.emailVerified,
        joinedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Member");
  }

  private async findInvitation(ctx: WorkspaceContext, invitationId: string) {
    await this.expireStale(and(eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.workspaceId, ctx.workspaceId)));
    const [row] = await db
      .select()
      .from(workspaceInvitations)
      .where(and(eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Invitation");
  }

  /** Marks lapsed pending invitations as expired (lazily, whenever they are read). */
  private async expireStale(scope: SQL | undefined, exec: Executor = db) {
    await exec
      .update(workspaceInvitations)
      .set({ status: "expired" })
      .where(and(eq(workspaceInvitations.status, "pending"), lt(workspaceInvitations.expiresAt, new Date()), scope));
  }

  private async assertNotLastWorkspace(userId: string, message: string) {
    const [row] = await db.select({ value: count() }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    if ((row?.value ?? 0) <= 1) throw conflict(message, "last_workspace");
  }

  private async forgetActiveWorkspace(exec: Executor, userId: string, workspaceId: string) {
    await exec
      .update(userSettings)
      .set({ activeWorkspaceId: null })
      .where(and(eq(userSettings.userId, userId), eq(userSettings.activeWorkspaceId, workspaceId)));
  }

  private async sendInvitation(ctx: WorkspaceContext, invitation: InvitationRow, token: string, actor: Actor): Promise<boolean> {
    const kind = ctx.workspaceKind === "business" ? "business" : "personal";
    const result = await this.email.send({
      to: invitation.email,
      subject: `${actor.name} invited you to ${ctx.workspaceName} on Expense Wise`,
      preview: `Join ${ctx.workspaceName} as ${article(invitation.role)} ${invitation.role}.`,
      heading: `Join ${ctx.workspaceName} on Expense Wise`,
      paragraphs: [
        `${actor.name} (${actor.email}) invited you to the ${kind} workspace "${ctx.workspaceName}" on Expense Wise. ${ROLE_IN_EMAIL[invitation.role]}`,
        `Sign in, or create an account, with ${invitation.email} to accept.`,
      ],
      action: { label: "Accept invitation", url: invitationLink(token) },
      footnote: `The link works once and expires in ${INVITATION_TTL_DAYS} days. If you weren't expecting this, you can ignore this email.`,
    });
    return result.delivered;
  }
}
