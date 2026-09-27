import { asc, eq } from "drizzle-orm";
import type { Response } from "express";
import { WORKSPACE_COOKIE } from "../../common/guards.js";
import { db, type Executor } from "../../db/index.js";
import { userSettings, workspaceMembers, workspaces } from "../../db/schema/index.js";
import { env } from "../../env.js";

/** The workspace the web opens next: remembered in a cookie it reads (not a secret; membership is checked on every request). */
export function setWorkspaceCookie(response: Response, workspaceId: string | null) {
  if (!workspaceId) {
    response.clearCookie(WORKSPACE_COOKIE, { path: "/" });
    return;
  }
  response.cookie(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: false,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });
}

/** Remembers `workspaceId` as the user's active workspace. */
export async function rememberActiveWorkspace(userId: string, workspaceId: string | null, exec: Executor = db) {
  await exec
    .insert(userSettings)
    .values({ userId, activeWorkspaceId: workspaceId })
    .onConflictDoUpdate({ target: userSettings.userId, set: { activeWorkspaceId: workspaceId } });
}

/**
 * After leaving or deleting a workspace: the user's oldest remaining workspace
 * becomes the active one, so the next request lands somewhere they belong.
 */
export async function fallbackWorkspace(userId: string, exec: Executor = db): Promise<string | null> {
  const [next] = await exec
    .select({ id: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  const id = next?.id ?? null;
  await rememberActiveWorkspace(userId, id, exec);
  return id;
}
