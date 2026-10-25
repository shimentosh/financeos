import type { apiKeyInput, MemberRole } from "@financeos/core";
import type { ApiKeyScope } from "@financeos/core/contracts/integrations-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { contextFor, type WorkspaceContext } from "../../../common/context.js";
import { assertFound, DomainError } from "../../../common/errors.js";
import { db } from "../../../db/index.js";
import { apiKeys, workspaceMembers, workspaces } from "../../../db/schema/index.js";
import { EntitlementsService } from "../../billing/entitlements.service.js";
import { AuditService } from "../../system/audit.service.js";
import { randomBase62, sha256Hex } from "../crypto.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export const API_KEY_PREFIX = "ew_live_";
const KEY_PATTERN = /^ew_live_[0-9A-Za-z]{40,64}$/;
/** How many characters of the key are kept to recognise it. */
const VISIBLE_PREFIX = 12;

/** A workspace an API key can reach, as `GET /v1/workspaces` and MCP list it. */
export type KeyWorkspace = {
  id: string;
  name: string;
  kind: string;
  baseCurrency: string;
  /** The workspace the key was created in: used when a request names none. */
  home: boolean;
  canWrite: boolean;
};

type ReachableWorkspace = KeyWorkspace & { workspace: typeof workspaces.$inferSelect; role: MemberRole };

export function apiKeyStatus(row: Pick<ApiKeyRow, "revokedAt" | "expiresAt">, now = new Date()): "active" | "revoked" | "expired" {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt <= now) return "expired";
  return "active";
}

/** The public shape of a key: never the hash, never the key. */
export function apiKeyView(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as ApiKeyScope[],
    status: apiKeyStatus(row),
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
  };
}

/**
 * Workspace API keys for the public API. The full key is returned once at
 * creation; only its SHA-256 and a short prefix are stored.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async list(ctx: WorkspaceContext) {
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, ctx.workspaceId)).orderBy(desc(apiKeys.createdAt));
    return rows.map(apiKeyView);
  }

  async create(ctx: WorkspaceContext, input: z.output<typeof apiKeyInput>) {
    // API keys and MCP come with the plan (HTTP 402 otherwise).
    await this.entitlements.assertApiAccess(ctx.workspaceId);
    const key = `${API_KEY_PREFIX}${randomBase62(32)}`;
    const scopes = [...new Set(input.scopes)];
    // Every key reads.
    if (!scopes.includes("read")) scopes.unshift("read");
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(apiKeys)
        .values({
          workspaceId: ctx.workspaceId,
          name: input.name,
          prefix: key.slice(0, VISIBLE_PREFIX),
          keyHash: sha256Hex(key),
          scopes,
          expiresAt,
          createdBy: ctx.userId,
        })
        .returning();
      const inserted = created as ApiKeyRow;
      await this.audit.record(tx, ctx, { action: "api_key.created", entityType: "api_key", entityId: inserted.id, after: apiKeyView(inserted) });
      return inserted;
    });
    return { apiKey: apiKeyView(row), key };
  }

  async revoke(ctx: WorkspaceContext, id: string) {
    return db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, ctx.workspaceId)))
        .limit(1);
      const found = assertFound(before, "API key");
      if (found.revokedAt) return apiKeyView(found);
      const [row] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "api_key.revoked", entityType: "api_key", entityId: id, before: apiKeyView(found) });
      return apiKeyView(row as ApiKeyRow);
    });
  }

  /** The active key a bearer token belongs to, or null. */
  async authenticate(token: string, now = new Date()): Promise<ApiKeyRow | null> {
    if (!KEY_PATTERN.test(token)) return null;
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, sha256Hex(token)))
      .limit(1);
    if (!row || apiKeyStatus(row, now) !== "active") return null;
    // At most one write a minute per key for "last used".
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
    }
    return row;
  }

  /**
   * The workspaces a key reaches: its own, and — with the all_workspaces
   * scope — every other workspace its creator is still a member of, with that
   * member's rights (a viewer's workspace stays read-only). Membership is
   * checked on every request, so leaving a workspace takes the key out of it.
   */
  async reachable(key: ApiKeyRow): Promise<ReachableWorkspace[]> {
    const write = key.scopes.includes("write");
    const [home] = await db.select().from(workspaces).where(eq(workspaces.id, key.workspaceId)).limit(1);
    const found = assertFound(home, "Workspace");
    const list: ReachableWorkspace[] = [{ ...describe(found, true, write), workspace: found, role: "member" }];
    if (!key.scopes.includes("all_workspaces") || !key.createdBy) return list;
    const others = await db
      .select({ workspace: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, key.createdBy))
      .orderBy(asc(workspaces.createdAt));
    for (const { workspace, role } of others) {
      if (workspace.id === key.workspaceId) continue;
      const viewer = role === "viewer";
      list.push({ ...describe(workspace, false, write && !viewer), workspace, role: viewer ? "viewer" : "member" });
    }
    return list;
  }

  /** What `GET /v1/workspaces` and the MCP `list_workspaces` tool answer, for the key a request came with. */
  async workspacesFor(ctx: Pick<WorkspaceContext, "apiKeyId">): Promise<KeyWorkspace[]> {
    const [key] = ctx.apiKeyId ? await db.select().from(apiKeys).where(eq(apiKeys.id, ctx.apiKeyId)).limit(1) : [];
    return (await this.reachable(assertFound(key, "API key"))).map(({ workspace: _w, role: _r, ...rest }) => rest);
  }

  /**
   * The context a request with this key acts in. `requested` (a workspace id,
   * name, or "personal"/"business") picks one of the reachable workspaces;
   * without it the key's own workspace is used.
   */
  async contextFor(key: ApiKeyRow, requested: string | undefined, ip?: string): Promise<{ ctx: WorkspaceContext; canWrite: boolean }> {
    const list = await this.reachable(key);
    const wanted = requested?.trim();
    let match = list[0] as ReachableWorkspace;
    if (wanted) {
      const lower = wanted.toLowerCase();
      const byKind = list.filter((w) => w.kind === lower);
      const picked = list.find((w) => w.id === wanted) ?? list.find((w) => w.name.toLowerCase() === lower) ?? (byKind.length === 1 ? byKind[0] : undefined);
      if (!picked) {
        const names = list.map((w) => `"${w.name}" (${w.kind})`).join(", ");
        const hint = key.scopes.includes("all_workspaces") ? "" : " Create a key with the all_workspaces scope to reach your other workspaces.";
        throw new DomainError(403, `This API key can't reach the workspace "${wanted}". It reaches ${names}.${hint}`, "workspace_not_allowed");
      }
      match = picked;
    }
    const ctx = contextFor(match.workspace, { userId: null, actorType: "api", apiKeyId: key.id, role: match.role, ip });
    return { ctx, canWrite: match.canWrite };
  }
}

function describe(workspace: typeof workspaces.$inferSelect, home: boolean, canWrite: boolean): KeyWorkspace {
  return { id: workspace.id, name: workspace.name, kind: workspace.kind, baseCurrency: workspace.baseCurrency, home, canWrite };
}
