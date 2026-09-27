import { applyDecorators, type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable, SetMetadata, UseGuards } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import { auth } from "../auth/auth.js";
import { db } from "../db/index.js";
import { userSettings, workspaceMembers, workspaces } from "../db/schema/index.js";
import { type AppRequest, contextFor, type SessionUser, type WorkspaceContext } from "./context.js";
import { forbidden, notFound, unauthorized } from "./errors.js";

export const WORKSPACE_HEADER = "x-workspace-id";
export const WORKSPACE_COOKIE = "ew_ws";
const IS_PUBLIC = "ew:public";
const REQUIRE_MANAGE = "ew:require-manage";
const ALLOW_VIEWER = "ew:allow-viewer";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Skips the session check: health, webhooks, the API-key API. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Owner or admin of the workspace only (settings, members, integrations). */
export const RequireManage = () => SetMetadata(REQUIRE_MANAGE, true);
/** A POST that changes nothing in the books (asking the copilot): viewers may call it. */
export const AllowViewer = () => SetMetadata(ALLOW_VIEWER, true);

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Global: every route needs a valid Better Auth session unless marked
 * @Public(). The session is read from the cookie the web app forwards.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AppRequest>();
    // Bypass the signed cookie cache: a ban or a role change must apply on the
    // next request, not up to five minutes later.
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers), query: { disableCookieCache: true } });
    if (!session) throw unauthorized();
    const user = session.user as typeof session.user & { role?: string; banned?: boolean };
    if (user.banned) throw forbidden("This account is suspended", "suspended");
    request.user = { id: user.id, name: user.name, email: user.email, role: user.role ?? "user", image: user.image };
    request.sessionId = session.session.id;
    return true;
  }
}

export async function resolveWorkspace(user: SessionUser, requested: string | undefined, ip?: string): Promise<WorkspaceContext> {
  const base = db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId));

  let row: Awaited<typeof base>[number] | undefined;
  if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
    [row] = await base.where(and(eq(workspaceMembers.userId, user.id), eq(workspaces.id, requested))).limit(1);
    // A stale or foreign id is not an error the user can act on; fall back.
  }
  if (!row) {
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
    if (settings?.activeWorkspaceId) {
      [row] = await base.where(and(eq(workspaceMembers.userId, user.id), eq(workspaces.id, settings.activeWorkspaceId))).limit(1);
    }
  }
  if (!row) {
    [row] = await base.where(eq(workspaceMembers.userId, user.id)).orderBy(asc(workspaces.createdAt)).limit(1);
  }
  if (!row) throw notFound("Workspace");
  return contextFor(row.workspace, { userId: user.id, actorType: "user", role: row.role, ip });
}

/**
 * Resolves the active workspace from the x-workspace-id header or the ew_ws
 * cookie, verifies membership, and attaches the WorkspaceContext. Viewers get
 * read-only access; @RequireManage() routes need owner or admin.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) throw unauthorized();
    const header = request.headers[WORKSPACE_HEADER];
    const requested = (Array.isArray(header) ? header[0] : header) ?? readCookie(request.headers.cookie, WORKSPACE_COOKIE);
    const ctx = await resolveWorkspace(request.user, requested, request.ip);
    const viewerAllowed = this.reflector.getAllAndOverride<boolean>(ALLOW_VIEWER, [context.getHandler(), context.getClass()]);
    if (!READ_METHODS.has(request.method) && ctx.role === "viewer" && !viewerAllowed) {
      throw forbidden("Viewers can look but not change anything");
    }
    const manage = this.reflector.getAllAndOverride<boolean>(REQUIRE_MANAGE, [context.getHandler(), context.getClass()]);
    if (manage && ctx.role !== "owner" && ctx.role !== "admin") throw forbidden();
    request.ctx = ctx;
    return true;
  }
}

/** Platform administrators (Better Auth admin role). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (request.user?.role !== "admin") throw forbidden("Platform administrators only");
    return true;
  }
}

/** Marks a controller as operating inside the active workspace. */
export const WorkspaceScoped = () => applyDecorators(UseGuards(WorkspaceGuard));

export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): WorkspaceContext => {
  const ctx = context.switchToHttp().getRequest<AppRequest>().ctx;
  if (!ctx) throw new Error("@Ctx() used on a route without @WorkspaceScoped()");
  return ctx;
});

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser => {
  const user = context.switchToHttp().getRequest<AppRequest>().user;
  if (!user) throw unauthorized();
  return user;
});
