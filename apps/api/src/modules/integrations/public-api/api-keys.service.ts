import type { apiKeyInput } from "@financeos/core";
import type { ApiKeyScope } from "@financeos/core/contracts/integrations-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { WorkspaceContext } from "../../../common/context.js";
import { assertFound } from "../../../common/errors.js";
import { db } from "../../../db/index.js";
import { apiKeys } from "../../../db/schema/index.js";
import { EntitlementsService } from "../../billing/entitlements.service.js";
import { AuditService } from "../../system/audit.service.js";
import { randomBase62, sha256Hex } from "../crypto.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export const API_KEY_PREFIX = "ew_live_";
const KEY_PATTERN = /^ew_live_[0-9A-Za-z]{40,64}$/;
/** How many characters of the key are kept to recognise it. */
const VISIBLE_PREFIX = 12;

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
    // Write implies read.
    if (scopes.includes("write") && !scopes.includes("read")) scopes.unshift("read");
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
}
