import { type Day, type MemberRole, today, type WorkspaceKind } from "@financeos/core";
import type { Request } from "express";
import type { WorkspaceSettings } from "../db/schema/types.js";

export type ActorType = "user" | "system" | "integration" | "ai" | "api";

/**
 * Who is acting, in which workspace. Built by the workspace guard from the
 * session and a verified membership — never from request input — and passed
 * to every domain call, which filters by `workspaceId` on every query.
 */
export type WorkspaceContext = {
  userId: string | null;
  actorType: ActorType;
  /** API key id when `actorType` is "api". */
  apiKeyId?: string;
  workspaceId: string;
  workspaceKind: WorkspaceKind;
  workspaceName: string;
  role: MemberRole;
  baseCurrency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  settings: WorkspaceSettings;
  ip?: string;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  kind: WorkspaceKind;
  baseCurrency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  settings: WorkspaceSettings;
};

export function contextFor(
  workspace: WorkspaceRecord,
  actor: { userId: string | null; actorType: ActorType; role?: MemberRole; apiKeyId?: string; ip?: string },
): WorkspaceContext {
  return {
    userId: actor.userId,
    actorType: actor.actorType,
    apiKeyId: actor.apiKeyId,
    workspaceId: workspace.id,
    workspaceKind: workspace.kind,
    workspaceName: workspace.name,
    role: actor.role ?? "owner",
    baseCurrency: workspace.baseCurrency,
    timezone: workspace.timezone,
    fiscalYearStartMonth: workspace.fiscalYearStartMonth,
    settings: workspace.settings ?? {},
    ip: actor.ip,
  };
}

/** Today in the workspace's timezone. */
export function todayFor(ctx: Pick<WorkspaceContext, "timezone">): Day {
  return today(ctx.timezone);
}

export function canWrite(ctx: Pick<WorkspaceContext, "role">): boolean {
  return ctx.role !== "viewer";
}

export function canManage(ctx: Pick<WorkspaceContext, "role">): boolean {
  return ctx.role === "owner" || ctx.role === "admin";
}

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  image?: string | null;
};

export type AppRequest = Request & {
  user?: SessionUser;
  sessionId?: string;
  ctx?: WorkspaceContext;
  rawBody?: Buffer;
};
