import type { onboardingInput } from "@financeos/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { contextFor, type SessionUser } from "../../common/context.js";
import { badRequest, conflict, notFound } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { financialAccounts, sessions, transactions, userSettings, users, workspaceMembers, workspaces } from "../../db/schema/index.js";
import type { UserPreferences } from "../../db/schema/types.js";
import { env } from "../../env.js";
import { BillingService } from "../billing/billing.service.js";
import { AuditService } from "../system/audit.service.js";
import { appLink, EmailService } from "../system/email.service.js";
import { PlatformAuditService } from "../system/platform-audit.service.js";
import { WorkspaceDeletionService } from "../workspaces/workspace-deletion.service.js";

type OnboardingInput = z.output<typeof onboardingInput>;

export type DeletionCheck = {
  email: string;
  canDelete: boolean;
  /** Owned and shared with other people: hand over or delete first. */
  blocking: Array<{ id: string; name: string; kind: string; otherMembers: number }>;
  /** Owned alone: deleted with the account, records and files included. */
  deletes: Array<{ id: string; name: string; kind: string; transactions: number }>;
  /** Someone else's workspaces: the account simply leaves them. */
  leaves: Array<{ id: string; name: string; kind: string; role: string }>;
};

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Your own account: first-run setup and deleting it. */
@Injectable()
export class AccountService {
  constructor(
    @Inject(WorkspaceDeletionService) private readonly deletion: WorkspaceDeletionService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  /** Every workspace the person belongs to, with their role, how many people share it and whether it has records. */
  private memberships(userId: string) {
    return db
      .select({
        workspace: workspaces,
        role: workspaceMembers.role,
        members: sql<number>`(select count(*)::int from ${workspaceMembers} m where m.workspace_id = ${workspaces.id})`,
        transactions: sql<number>`(select count(*)::int from ${transactions} t where t.workspace_id = ${workspaces.id})`,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaces.createdAt));
  }

  async deletionCheck(userId: string): Promise<DeletionCheck> {
    const [[user], rows] = await Promise.all([db.select({ email: users.email }).from(users).where(eq(users.id, userId)), this.memberships(userId)]);
    if (!user) throw notFound("Account");
    const owned = rows.filter((row) => row.role === "owner");
    const blocking = owned
      .filter((row) => row.members > 1)
      .map((row) => ({ id: row.workspace.id, name: row.workspace.name, kind: row.workspace.kind, otherMembers: row.members - 1 }));
    return {
      email: user.email,
      canDelete: blocking.length === 0,
      blocking,
      deletes: owned
        .filter((row) => row.members <= 1)
        .map((row) => ({ id: row.workspace.id, name: row.workspace.name, kind: row.workspace.kind, transactions: row.transactions })),
      leaves: rows
        .filter((row) => row.role !== "owner")
        .map((row) => ({ id: row.workspace.id, name: row.workspace.name, kind: row.workspace.kind, role: row.role })),
    };
  }

  /**
   * Deletes the account: first every workspace it owns alone (records, files
   * and all), then the user, whose sign-in data, sessions and memberships go
   * with it. Refused while it owns a workspace other people still use.
   */
  async deleteAccount(sessionUser: SessionUser, confirmEmail: string, ip?: string | null) {
    const check = await this.deletionCheck(sessionUser.id);
    if (confirmEmail.trim().toLowerCase() !== check.email.toLowerCase()) {
      throw badRequest("Type the email address of your account exactly to confirm", "confirmation_mismatch");
    }
    if (!check.canDelete) {
      throw conflict("You own workspaces other people still use. Transfer their ownership or delete them before deleting your account.", "workspaces_shared", {
        workspaces: check.blocking,
      });
    }
    return this.removeUser(sessionUser.id, check, { actorId: sessionUser.id, actorEmail: check.email, action: "account.deleted" }, ip);
  }

  /**
   * A platform admin deleting someone: the same path as deleting your own
   * account (their paid plan stopped, workspaces they own alone deleted with
   * their files, audited), instead of the bare user delete that would leave
   * their workspaces without an owner.
   */
  async adminDelete(targetUserId: string, admin: SessionUser, ip?: string | null) {
    if (targetUserId === admin.id) throw badRequest("Delete your own account from Settings → Data & account", "self_delete");
    const check = await this.deletionCheck(targetUserId);
    if (!check.canDelete) {
      throw conflict("This person owns workspaces other people still use. Those need a new owner (or to be deleted) first.", "workspaces_shared", {
        workspaces: check.blocking,
      });
    }
    return this.removeUser(targetUserId, check, { actorId: admin.id, actorEmail: admin.email, action: "user.deleted_by_admin" }, ip);
  }

  private async removeUser(userId: string, check: DeletionCheck, actor: { actorId: string; actorEmail: string; action: string }, ip?: string | null) {
    // A card subscription is stopped first; if Stripe can't be reached nothing is deleted yet.
    await this.billing.closeForDeletion(userId);
    for (const workspace of check.deletes) {
      await this.deletion.delete(workspace.id, {
        userId: actor.actorId,
        email: actor.actorEmail,
        ip: ip ?? null,
        reason: actor.action === "account.deleted" ? "account_deleted" : "admin",
      });
    }
    await db.transaction(async (tx) => {
      // The user's rows cascade from here: sessions, sign-in methods, memberships, settings, notifications.
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
      await this.platformAudit.record(
        {
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          action: actor.action,
          targetType: "user",
          targetId: userId,
          details: {
            email: check.email,
            workspacesDeleted: check.deletes.map((w) => ({ id: w.id, name: w.name })),
            workspacesLeft: check.leaves.map((w) => ({ id: w.id, name: w.name })),
          },
          ip: ip ?? null,
        },
        tx,
      );
    });
    await this.email.send({
      to: check.email,
      subject: "Your FinanceOS account was deleted",
      heading: "Your account was deleted",
      paragraphs: [
        `Your FinanceOS account (${check.email}) has been deleted${actor.action === "account.deleted" ? "" : " by the people who run this service"}${check.deletes.length ? `, together with ${check.deletes.length === 1 ? "the workspace" : `the ${check.deletes.length} workspaces`} you owned and every record and file in ${check.deletes.length === 1 ? "it" : "them"}` : ""}. This cannot be undone.`,
        ...(check.leaves.length
          ? [
              `You were also removed from ${check.leaves.length === 1 ? "1 workspace" : `${check.leaves.length} workspaces`} that other people own; their books are unchanged.`,
            ]
          : []),
        "Thank you for using FinanceOS. You are welcome back any time.",
      ],
      action: { label: "Visit FinanceOS", url: appLink("/") },
      footnote:
        actor.action === "account.deleted"
          ? env.SUPPORT_EMAIL
            ? `If you did not delete your account, write to ${env.SUPPORT_EMAIL} straight away.`
            : "If you did not delete your account, contact the people who run this service straight away."
          : env.SUPPORT_EMAIL
            ? `Questions? Write to ${env.SUPPORT_EMAIL}.`
            : "Questions? Reply to this email.",
    });
    return { deleted: true, workspacesDeleted: check.deletes.length, workspacesLeft: check.leaves.length };
  }

  /**
   * First-run setup. Applies the base currency and timezone to the person's
   * own workspaces (currency only where nothing is recorded yet: amounts
   * already posted keep the currency they were converted to), removes the
   * starter business workspace for a personal-only start when it is still
   * empty, names it otherwise, and remembers that setup is done.
   */
  async onboard(user: SessionUser, input: OnboardingInput, ip?: string | null) {
    if (!validTimezone(input.timezone)) throw badRequest("Unknown timezone", "invalid_timezone");
    if (!/^[A-Z]{3}$/.test(input.baseCurrency)) throw badRequest("Currency must be a three-letter ISO code", "invalid_currency");

    const rows = await this.memberships(user.id);
    const owned = rows.filter((row) => row.role === "owner");
    const business = owned.find((row) => row.workspace.kind === "business");

    let businessDeleted = false;
    let businessKeptReason: string | null = null;
    if (!input.keepBusiness && business) {
      if (business.transactions > 0) businessKeptReason = "It already has records.";
      else if (business.members > 1) businessKeptReason = "Other people use it.";
      else {
        await this.deletion.delete(business.workspace.id, { userId: user.id, email: user.email, ip: ip ?? null, reason: "workspace_deleted" });
        businessDeleted = true;
      }
    }

    const results = await db.transaction(async (tx) => {
      const changed: Array<{ id: string; name: string; kind: string; baseCurrency: string; timezone: string; currencyApplied: boolean }> = [];
      for (const row of owned) {
        if (businessDeleted && row.workspace.id === business?.workspace.id) continue;
        const before = row.workspace;
        const canChangeCurrency = row.transactions === 0;
        const changes: Partial<typeof workspaces.$inferInsert> = { timezone: input.timezone };
        if (before.baseCurrency !== input.baseCurrency && canChangeCurrency) {
          changes.baseCurrency = input.baseCurrency;
          // Starter accounts (nothing in them yet) follow the new base currency.
          await tx
            .update(financialAccounts)
            .set({ currency: input.baseCurrency })
            .where(
              and(eq(financialAccounts.workspaceId, before.id), eq(financialAccounts.currency, before.baseCurrency), eq(financialAccounts.openingBalance, 0)),
            );
        }
        if (row.workspace.id === business?.workspace.id && input.businessName) changes.name = input.businessName;
        const [after] = await tx.update(workspaces).set(changes).where(eq(workspaces.id, before.id)).returning();
        if (!after) continue;
        await this.audit.record(tx, contextFor(before, { userId: user.id, actorType: "user", role: "owner", ip: ip ?? undefined }), {
          action: "workspace.updated",
          entityType: "workspace",
          entityId: before.id,
          before: { name: before.name, baseCurrency: before.baseCurrency, timezone: before.timezone },
          after: { name: after.name, baseCurrency: after.baseCurrency, timezone: after.timezone },
          source: "onboarding",
        });
        changed.push({
          id: after.id,
          name: after.name,
          kind: after.kind,
          baseCurrency: after.baseCurrency,
          timezone: after.timezone,
          currencyApplied: after.baseCurrency === input.baseCurrency,
        });
      }

      const [settings] = await tx.select({ preferences: userSettings.preferences }).from(userSettings).where(eq(userSettings.userId, user.id));
      const preferences: UserPreferences = { ...(settings?.preferences ?? {}), onboarded: true };
      await tx.insert(userSettings).values({ userId: user.id, preferences }).onConflictDoUpdate({ target: userSettings.userId, set: { preferences } });
      return changed;
    });

    return { onboarded: true, workspaces: results, businessDeleted, businessKeptReason };
  }
}
