import { AGENT_MEMORY_LIMIT, type AgentMemoryItem, agentMemoryInput, normalizeName, uuidv7 } from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "../../common/context.js";
import { conflict, notFound } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { workspaces } from "../../db/schema/index.js";
import { AuditService } from "../system/audit.service.js";

/**
 * The assistant's memory: short facts the user asked it to keep ("salary
 * lands in BRAC on the 5th", "Shwapno is groceries"). Stored per workspace in
 * its settings and shown to the model in every conversation, labelled as the
 * user's own notes. Everyone in the workspace sees and can remove them.
 */
@Injectable()
export class AgentMemoryService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async list(ctx: Pick<WorkspaceContext, "workspaceId">): Promise<AgentMemoryItem[]> {
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    return row?.settings.agentMemory ?? [];
  }

  async add(ctx: WorkspaceContext, raw: { text: string }): Promise<{ item: AgentMemoryItem; duplicate: boolean }> {
    const { text } = agentMemoryInput.parse(raw);
    return db.transaction(async (tx) => {
      // Serialise writers so two quick saves can't overwrite each other.
      await tx.execute(sql`select 1 from ${workspaces} where ${workspaces.id} = ${ctx.workspaceId} for update`);
      const [row] = await tx.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
      const settings = row?.settings ?? {};
      const items = settings.agentMemory ?? [];
      const same = items.find((item) => normalizeName(item.text) === normalizeName(text));
      if (same) return { item: same, duplicate: true };
      if (items.length >= AGENT_MEMORY_LIMIT) {
        throw conflict(`The assistant can keep ${AGENT_MEMORY_LIMIT} notes. Remove some in Settings → AI first.`, "memory_full");
      }
      const item: AgentMemoryItem = { id: uuidv7(), text, createdAt: new Date().toISOString(), createdBy: ctx.userId };
      await tx
        .update(workspaces)
        .set({ settings: { ...settings, agentMemory: [...items, item] } })
        .where(eq(workspaces.id, ctx.workspaceId));
      await this.audit.record(tx, ctx, { action: "agent_memory.added", entityType: "workspace", entityId: ctx.workspaceId, after: item });
      return { item, duplicate: false };
    });
  }

  async remove(ctx: WorkspaceContext, id: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from ${workspaces} where ${workspaces.id} = ${ctx.workspaceId} for update`);
      const [row] = await tx.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
      const settings = row?.settings ?? {};
      const items = settings.agentMemory ?? [];
      const item = items.find((entry) => entry.id === id);
      if (!item) throw notFound("Memory");
      await tx
        .update(workspaces)
        .set({ settings: { ...settings, agentMemory: items.filter((entry) => entry.id !== id) } })
        .where(eq(workspaces.id, ctx.workspaceId));
      await this.audit.record(tx, ctx, { action: "agent_memory.removed", entityType: "workspace", entityId: ctx.workspaceId, before: item });
      return { deleted: true };
    });
  }

  /** The memory as the model sees it: the user's own notes, not instructions from anyone else. */
  static prompt(items: AgentMemoryItem[]): string {
    if (!items.length) return "";
    return `\n\nNotes the user saved for you (their own words; use them to fill in accounts, categories and habits):\n${items.map((item) => `- ${item.text}`).join("\n")}`;
  }
}
