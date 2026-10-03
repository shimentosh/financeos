import { type BillingStatus, DEFAULT_PLANS, PAST_DUE_GRACE_DAYS, type PlanId, type PlanLimits, UNLIMITED_LIMITS } from "@financeos/core";
import { Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
import { planLimit } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { billingSubscriptions, files, users, workspaceInvitations, workspaceMembers } from "../../db/schema/index.js";
import { type BillingConfig, loadBillingConfig } from "./billing-config.js";
import { addDays } from "./periods.js";

/** What a user may do: their plan, its status and limits. */
export type Entitlement = { plan: PlanId | "unlimited"; status: BillingStatus; limits: PlanLimits; billingEnabled: boolean };

export type SubscriptionRow = typeof billingSubscriptions.$inferSelect;

/** A user's plan as it stands right now, with the reasons behind it. */
export type ResolvedPlan = Entitlement & {
  userId: string | null;
  /** The saved subscription, if any (a Free user may have none). */
  row: SubscriptionRow | null;
  trialEndsAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Past due: the plan keeps working until then. */
  graceEndsAt: Date | null;
  config: BillingConfig;
};

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : Number(value.toFixed(value >= 10 ? 0 : 1))} ${UNITS[unit]}`;
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

/**
 * The single place other modules ask "is this allowed on the plan?". Each
 * `assert…` throws `planLimit(...)` (HTTP 402, code `plan_limit`) with a
 * message saying which limit was reached and how to lift it; it returns
 * quietly when allowed. With billing off (self-hosted), everything is allowed.
 *
 * Limits follow the workspace's owner: a plan covers every workspace its
 * holder owns.
 */
@Injectable()
export class EntitlementsService {
  /** Whether plans are enforced on this installation (Admin → Billing). */
  async billingEnabled(): Promise<boolean> {
    return (await loadBillingConfig()).enabled;
  }

  async forUser(userId: string): Promise<Entitlement> {
    const { plan, status, limits, billingEnabled } = await this.resolve(userId);
    return { plan, status, limits, billingEnabled };
  }

  /** The entitlement of a workspace's owner. */
  async forWorkspace(workspaceId: string): Promise<Entitlement> {
    const { plan, status, limits, billingEnabled } = await this.resolveWorkspace(workspaceId);
    return { plan, status, limits, billingEnabled };
  }

  /** The owner of a workspace: the earliest member with the owner role. */
  async ownerOf(workspaceId: string, exec: Executor = db): Promise<string | null> {
    const [row] = await exec
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(workspaceMembers.createdAt))
      .limit(1);
    return row?.userId ?? null;
  }

  async resolveWorkspace(workspaceId: string): Promise<ResolvedPlan> {
    const config = await loadBillingConfig();
    if (!config.enabled) return this.unlimited(config, null);
    const owner = await this.ownerOf(workspaceId);
    if (!owner) return this.free(config, null, null, "active");
    return this.resolve(owner, new Date(), config);
  }

  /**
   * The plan in effect for a user. No subscription row means Free, except a
   * new user inside the trial window, who gets a trial row created on first
   * look. A trial or a paid period that has ended falls back to Free; a
   * failed renewal keeps the plan for a grace period.
   */
  async resolve(userId: string, now = new Date(), preloaded?: BillingConfig): Promise<ResolvedPlan> {
    const config = preloaded ?? (await loadBillingConfig());
    if (!config.enabled) return this.unlimited(config, userId);
    let [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)).limit(1);
    if (!row && config.trial.enabled) {
      const [user] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
      const trialEndsAt = user ? addDays(user.createdAt, config.trial.days) : null;
      if (user && trialEndsAt && trialEndsAt > now) {
        await db
          .insert(billingSubscriptions)
          .values({
            userId,
            plan: config.trial.plan,
            status: "trialing",
            trialEndsAt,
            currentPeriodStart: user.createdAt,
            currentPeriodEnd: trialEndsAt,
          })
          .onConflictDoNothing({ target: billingSubscriptions.userId });
        [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId)).limit(1);
      }
    }
    if (!row) return this.free(config, userId, null, "active");
    return this.fromRow(config, row, now);
  }

  private fromRow(config: BillingConfig, row: SubscriptionRow, now: Date): ResolvedPlan {
    const paid = (plan: PlanId, status: BillingStatus, graceEndsAt: Date | null = null): ResolvedPlan => ({
      plan,
      status,
      limits: config.plans[plan]?.limits ?? DEFAULT_PLANS[plan].limits,
      billingEnabled: true,
      userId: row.userId,
      row,
      trialEndsAt: row.trialEndsAt,
      periodStart: row.currentPeriodStart,
      periodEnd: row.currentPeriodEnd,
      graceEndsAt,
      config,
    });
    const end = row.currentPeriodEnd;
    switch (row.status) {
      case "trialing": {
        const trialEnd = row.trialEndsAt ?? end;
        if (trialEnd && trialEnd > now) return paid(row.plan, "trialing");
        return this.free(config, row.userId, row, "expired");
      }
      case "active": {
        if (!end || end > now) return paid(row.plan, "active");
        // A card subscription renews by webhook; allow a little time for it to arrive.
        if (row.provider === "stripe" && addDays(end, 3) > now) return paid(row.plan, "active");
        return this.free(config, row.userId, row, "expired");
      }
      case "past_due": {
        const since = typeof row.metadata?.pastDueAt === "string" ? new Date(row.metadata.pastDueAt) : (end ?? row.updatedAt);
        const graceEndsAt = addDays(Number.isNaN(since.getTime()) ? row.updatedAt : since, PAST_DUE_GRACE_DAYS);
        if (graceEndsAt > now) return paid(row.plan, "past_due", graceEndsAt);
        return this.free(config, row.userId, row, "expired");
      }
      case "canceled": {
        // Paid through the end of the period it was canceled in.
        if (end && end > now) return paid(row.plan, "canceled");
        return this.free(config, row.userId, row, "canceled");
      }
      default:
        return this.free(config, row.userId, row, "expired");
    }
  }

  private unlimited(config: BillingConfig, userId: string | null): ResolvedPlan {
    return {
      plan: "unlimited",
      status: "active",
      limits: UNLIMITED_LIMITS,
      billingEnabled: false,
      userId,
      row: null,
      trialEndsAt: null,
      periodStart: null,
      periodEnd: null,
      graceEndsAt: null,
      config,
    };
  }

  private free(config: BillingConfig, userId: string | null, row: SubscriptionRow | null, status: BillingStatus): ResolvedPlan {
    return {
      plan: "free",
      status: row?.plan === "free" ? "active" : status,
      limits: config.plans.free.limits,
      billingEnabled: true,
      userId,
      row,
      trialEndsAt: row?.trialEndsAt ?? null,
      periodStart: null,
      periodEnd: null,
      graceEndsAt: null,
      config,
    };
  }

  // ------------------------------------------------------------------ usage

  async workspacesOwned(userId: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner")));
    return row?.value ?? 0;
  }

  /** People in a workspace plus invitations still open. */
  async seatsUsed(workspaceId: string): Promise<number> {
    const [[members], [invited]] = await Promise.all([
      db.select({ value: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
      db
        .select({ value: count() })
        .from(workspaceInvitations)
        .where(
          and(eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, "pending"), gt(workspaceInvitations.expiresAt, new Date())),
        ),
    ]);
    return (members?.value ?? 0) + (invited?.value ?? 0);
  }

  /** Bytes of files across every workspace the user owns. */
  async storageUsed(userId: string): Promise<number> {
    const owned = db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner")));
    const [row] = await db
      .select({ bytes: sql<string>`coalesce(sum(${files.size}), 0)` })
      .from(files)
      .where(inArray(files.workspaceId, owned));
    return Number(row?.bytes ?? 0);
  }

  // ----------------------------------------------------------------- checks

  private planName(resolved: ResolvedPlan) {
    return resolved.plan === "unlimited" ? "current" : (resolved.config.plans[resolved.plan]?.name ?? resolved.plan);
  }

  /** Before creating a workspace the user will own. */
  async assertCanCreateWorkspace(userId: string): Promise<void> {
    const resolved = await this.resolve(userId);
    const allowed = resolved.limits.workspaces;
    if (!resolved.billingEnabled || allowed === null) return;
    const used = await this.workspacesOwned(userId);
    if (used + 1 > allowed) {
      throw planLimit(`Your ${this.planName(resolved)} plan includes ${plural(allowed, "workspace")}. Upgrade your plan to create more.`, {
        limit: "workspaces",
        plan: resolved.plan,
        used,
        allowed,
      });
    }
  }

  /** Before inviting or adding people: members plus open invitations, plus `adding`. */
  async assertCanAddMember(workspaceId: string, adding = 1): Promise<void> {
    const resolved = await this.resolveWorkspace(workspaceId);
    const allowed = resolved.limits.membersPerWorkspace;
    if (!resolved.billingEnabled || allowed === null) return;
    const used = await this.seatsUsed(workspaceId);
    if (used + adding > allowed) {
      throw planLimit(
        `The ${this.planName(resolved)} plan allows ${allowed} ${allowed === 1 ? "person" : "people"} per workspace, open invitations included (${used} now). The workspace owner can upgrade to add more.`,
        { limit: "membersPerWorkspace", plan: resolved.plan, used, allowed },
      );
    }
  }

  /** Before saving a file of `bytes` to a workspace. */
  async assertStorage(workspaceId: string, bytes: number): Promise<void> {
    const resolved = await this.resolveWorkspace(workspaceId);
    const allowed = resolved.limits.storageBytes;
    if (!resolved.billingEnabled || allowed === null || !resolved.userId) return;
    const used = await this.storageUsed(resolved.userId);
    if (used + bytes > allowed) {
      throw planLimit(
        `This file would go over the ${formatBytes(allowed)} of storage on the ${this.planName(resolved)} plan (${formatBytes(used)} used). Upgrade the plan or delete files you no longer need.`,
        { limit: "storageBytes", plan: resolved.plan, used, allowed },
      );
    }
  }

  /** Before using an API key or the MCP endpoint. */
  async assertApiAccess(workspaceId: string): Promise<void> {
    const resolved = await this.resolveWorkspace(workspaceId);
    if (!resolved.billingEnabled || resolved.limits.apiAccess) return;
    throw planLimit(`API keys and AI agents (MCP) aren't included in the ${this.planName(resolved)} plan. Upgrade to Pro to use them.`, {
      limit: "apiAccess",
      plan: resolved.plan,
    });
  }

  /** Before connecting a bank, wallet or app. */
  async assertIntegrations(workspaceId: string): Promise<void> {
    const resolved = await this.resolveWorkspace(workspaceId);
    if (!resolved.billingEnabled || resolved.limits.integrations) return;
    throw planLimit(`Bank, wallet and app connections aren't included in the ${this.planName(resolved)} plan. Upgrade to Pro to connect them.`, {
      limit: "integrations",
      plan: resolved.plan,
    });
  }
}
