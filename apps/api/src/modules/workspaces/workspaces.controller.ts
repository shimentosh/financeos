import { pagination, workspaceInput, workspaceUpdate } from "@expensewise/core";
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Response } from "express";
import { z } from "zod";
import { contextFor, type SessionUser, type WorkspaceContext } from "../../common/context.js";
import { assertFound, forbidden } from "../../common/errors.js";
import { Ctx, CurrentUser, RequireManage, resolveWorkspace, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { db } from "../../db/index.js";
import { userSettings, workspaceMembers, workspaces } from "../../db/schema/index.js";
import type { UserPreferences } from "../../db/schema/types.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../system/audit.service.js";
import { NotificationsService } from "../system/notify.service.js";
import { createWorkspace } from "./provisioning.js";
import { rememberActiveWorkspace, setWorkspaceCookie } from "./workspace-cookie.js";

const preferencesInput = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  numberLocale: z.enum(["en-IN", "en-US"]).optional(),
  weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]).optional(),
  dashboard: z.object({ hidden: z.array(z.string()).optional(), order: z.array(z.string()).optional(), period: z.string().optional() }).optional(),
  notifications: z.object({ email: z.boolean().optional(), inApp: z.boolean().optional() }).optional(),
  sidebarCollapsed: z.boolean().optional(),
});

@Controller("me")
export class MeController {
  @Get()
  async me(@CurrentUser() user: SessionUser) {
    const memberships = await db
      .select({ workspace: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(asc(workspaces.createdAt));
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id));
    return {
      user: { ...user, isAdmin: user.role === "admin" },
      workspaces: memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        kind: m.workspace.kind,
        baseCurrency: m.workspace.baseCurrency,
        role: m.role,
      })),
      activeWorkspaceId: settings?.activeWorkspaceId ?? memberships[0]?.workspace.id ?? null,
      preferences: settings?.preferences ?? {},
    };
  }

  /** Switches workspace: remembered server-side and in a cookie the web reads. */
  @Post("active-workspace")
  @HttpCode(200)
  async setActive(
    @CurrentUser() user: SessionUser,
    @Body(zod(z.object({ workspaceId: z.uuid() }))) body: { workspaceId: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const ctx = await resolveWorkspace(user, body.workspaceId);
    if (ctx.workspaceId !== body.workspaceId) throw forbidden("You are not a member of that workspace");
    await rememberActiveWorkspace(user.id, body.workspaceId);
    setWorkspaceCookie(response, body.workspaceId);
    return { workspaceId: ctx.workspaceId, kind: ctx.workspaceKind, name: ctx.workspaceName };
  }

  @Patch("preferences")
  async preferences(@CurrentUser() user: SessionUser, @Body(zod(preferencesInput)) input: UserPreferences) {
    const [current] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id));
    const merged = { ...(current?.preferences ?? {}), ...input };
    await db
      .insert(userSettings)
      .values({ userId: user.id, preferences: merged })
      .onConflictDoUpdate({ target: userSettings.userId, set: { preferences: merged } });
    return merged;
  }
}

@Controller("workspaces")
export class WorkspacesController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body(zod(workspaceInput)) input: z.output<typeof workspaceInput>) {
    await this.entitlements.assertCanCreateWorkspace(user.id);
    return db.transaction(async (tx) => {
      const workspace = await createWorkspace(tx, user.id, input);
      const ctx = contextFor(workspace, { userId: user.id, actorType: "user", role: "owner" });
      await this.audit.record(tx, ctx, {
        action: "workspace.created",
        entityType: "workspace",
        entityId: workspace.id,
        after: { name: workspace.name, kind: workspace.kind },
      });
      return workspace;
    });
  }

  @Get("current")
  @WorkspaceScoped()
  current(@Ctx() ctx: WorkspaceContext) {
    return {
      id: ctx.workspaceId,
      name: ctx.workspaceName,
      kind: ctx.workspaceKind,
      role: ctx.role,
      baseCurrency: ctx.baseCurrency,
      timezone: ctx.timezone,
      fiscalYearStartMonth: ctx.fiscalYearStartMonth,
      settings: ctx.settings,
    };
  }

  @Patch("current")
  @WorkspaceScoped()
  @RequireManage()
  async update(@Ctx() ctx: WorkspaceContext, @Body(zod(workspaceUpdate)) input: z.output<typeof workspaceUpdate>) {
    return db.transaction(async (tx) => {
      const [before] = await tx.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
      assertFound(before, "Workspace");
      const { settings, kind: _kind, ...rest } = input;
      const [row] = await tx
        .update(workspaces)
        .set({ ...rest, ...(settings ? { settings: { ...before?.settings, ...settings } } : {}) })
        .where(eq(workspaces.id, ctx.workspaceId))
        .returning();
      await this.audit.record(tx, ctx, { action: "workspace.updated", entityType: "workspace", entityId: ctx.workspaceId, before, after: row });
      return row;
    });
  }

  @Get("current/audit")
  @WorkspaceScoped()
  auditLog(
    @Ctx() ctx: WorkspaceContext,
    @Query(zod(pagination.extend({ entityType: z.string().optional(), entityId: z.string().optional() }))) query: {
      page: number;
      pageSize: number;
      entityType?: string;
      entityId?: string;
    },
  ) {
    return this.audit.list(ctx, query);
  }
}

@Controller("notifications")
@WorkspaceScoped()
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Ctx() ctx: WorkspaceContext, @Query("unread") unread?: string) {
    const userId = ctx.userId as string;
    const [items, unreadCount] = await Promise.all([
      this.notifications.list(userId, ctx.workspaceId, { unreadOnly: unread === "true" }),
      this.notifications.unreadCount(userId, ctx.workspaceId),
    ]);
    return { items, unread: unreadCount };
  }

  @Post("read")
  @HttpCode(200)
  async read(@Ctx() ctx: WorkspaceContext, @Body(zod(z.object({ ids: z.union([z.array(z.uuid()), z.literal("all")]) }))) body: { ids: string[] | "all" }) {
    await this.notifications.markRead(ctx.userId as string, body.ids, ctx.workspaceId);
    return { ok: true };
  }
}

@Controller("workspaces/:workspaceId/membership")
export class MembershipCheckController {
  /** Lets the web confirm a workspace id from a URL before using it. */
  @Get()
  async check(@CurrentUser() user: SessionUser, @Param("workspaceId", ParseUUIDPipe) workspaceId: string) {
    const [row] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.workspaceId, workspaceId)));
    return { member: Boolean(row), role: row?.role ?? null };
  }
}
