import {
  applyRules,
  categoryInput,
  categoryUpdate,
  counterpartyInput,
  normalizeName,
  projectInput,
  projectUpdate,
  type Rule,
  type RuleOutcome,
  type RuleSubject,
  ruleInput,
  titleCase,
} from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { categories, counterparties, projects, rules, transactions } from "../../db/schema/index.js";
import { AuditService } from "../system/audit.service.js";
import { assertInWorkspace } from "./references.js";

export type CategoryRow = typeof categories.$inferSelect;

@Injectable()
export class CategoriesService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  list(ctx: WorkspaceContext, options: { includeArchived?: boolean } = {}, exec: Executor = db) {
    return exec
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ctx.workspaceId), options.includeArchived ? undefined : eq(categories.archived, false)))
      .orderBy(asc(categories.kind), asc(categories.sortOrder), asc(categories.name));
  }

  /** The category and its subcategories, for "include children" filters. */
  async withDescendants(workspaceId: string, id: string, exec: Executor = db): Promise<string[]> {
    const children = await exec
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), eq(categories.parentId, id)));
    return [id, ...children.map((c) => c.id)];
  }

  /** Resolves a name hint from the parser or the model to a category id. */
  async resolveName(ctx: WorkspaceContext, name: string | null | undefined, kind: "expense" | "income", exec: Executor = db) {
    if (!name) return null;
    const all = await this.list(ctx, {}, exec);
    const wanted = normalizeName(name);
    const sameKind = all.filter((c) => c.kind === kind);
    return (
      sameKind.find((c) => normalizeName(c.name) === wanted) ??
      sameKind.find((c) => normalizeName(c.name).includes(wanted) || wanted.includes(normalizeName(c.name))) ??
      null
    );
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof categoryInput>) {
    const input = categoryInput.parse(raw);
    return db.transaction(async (tx) => {
      await assertInWorkspace(tx, categories, ctx.workspaceId, [input.parentId], "Parent category");
      const [row] = await tx
        .insert(categories)
        .values({ workspaceId: ctx.workspaceId, ...input })
        .returning();
      await this.audit.record(tx, ctx, { action: "category.created", entityType: "category", entityId: row?.id, after: row });
      return row as CategoryRow;
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof categoryUpdate>) {
    const input = categoryUpdate.parse(raw);
    return db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(categories)
        .where(and(eq(categories.id, id), eq(categories.workspaceId, ctx.workspaceId)));
      assertFound(before, "Category");
      if (input.parentId === id) throw conflict("A category cannot be its own parent");
      await assertInWorkspace(tx, categories, ctx.workspaceId, [input.parentId], "Parent category");
      const [row] = await tx.update(categories).set(input).where(eq(categories.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "category.updated", entityType: "category", entityId: id, before, after: row });
      return row as CategoryRow;
    });
  }

  /** Categories in use are archived; transactions keep their category. */
  async remove(ctx: WorkspaceContext, id: string) {
    return db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(categories)
        .where(and(eq(categories.id, id), eq(categories.workspaceId, ctx.workspaceId)));
      assertFound(before, "Category");
      const [used] = await tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.categoryId, id)).limit(1);
      if (used) {
        await tx.update(categories).set({ archived: true }).where(eq(categories.id, id));
        await this.audit.record(tx, ctx, { action: "category.archived", entityType: "category", entityId: id, before });
        return { archived: true };
      }
      await tx.update(categories).set({ parentId: null }).where(eq(categories.parentId, id));
      await tx.delete(categories).where(eq(categories.id, id));
      await this.audit.record(tx, ctx, { action: "category.deleted", entityType: "category", entityId: id, before });
      return { deleted: true };
    });
  }
}

export type CounterpartyRow = typeof counterparties.$inferSelect;

@Injectable()
export class CounterpartiesService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** Finds a merchant/customer by name or alias, creating it on first sight. */
  async findOrCreate(exec: Executor, workspaceId: string, name: string, kind: CounterpartyRow["kind"] = "merchant"): Promise<CounterpartyRow | null> {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const existing = await this.match(exec, workspaceId, name);
    if (existing) {
      await exec.update(counterparties).set({ lastSeenAt: new Date() }).where(eq(counterparties.id, existing.id));
      return existing;
    }
    const display = name.trim().length > 1 && name === name.toUpperCase() ? titleCase(name.toLowerCase()) : name.trim();
    const [row] = await exec
      .insert(counterparties)
      .values({ workspaceId, name: display.slice(0, 120), normalizedName: normalized, kind, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: [counterparties.workspaceId, counterparties.normalizedName], set: { lastSeenAt: new Date() } })
      .returning();
    return row ?? null;
  }

  async match(exec: Executor, workspaceId: string, name: string): Promise<CounterpartyRow | null> {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const [row] = await exec
      .select()
      .from(counterparties)
      .where(
        and(
          eq(counterparties.workspaceId, workspaceId),
          or(eq(counterparties.normalizedName, normalized), sql`${normalized} = any(${counterparties.aliases})`),
        ),
      )
      .limit(1);
    if (row) return row;
    // "openai chatgpt subscr" should find "openai": match on the leading word.
    const first = normalized.split(" ")[0] ?? "";
    if (first.length < 4) return null;
    const [prefix] = await exec
      .select()
      .from(counterparties)
      .where(and(eq(counterparties.workspaceId, workspaceId), eq(counterparties.normalizedName, first)))
      .limit(1);
    return prefix ?? null;
  }

  /**
   * Merchant memory: a confirmed category becomes the merchant's default, and
   * repeated agreement raises confidence enough to skip the model next time.
   */
  async learn(exec: Executor, counterpartyId: string, categoryId: string | null, projectId: string | null) {
    const [row] = await exec.select().from(counterparties).where(eq(counterparties.id, counterpartyId)).limit(1);
    if (!row || !categoryId) return;
    const agrees = row.defaultCategoryId === categoryId;
    await exec
      .update(counterparties)
      .set({
        defaultCategoryId: categoryId,
        defaultProjectId: projectId ?? row.defaultProjectId,
        confirmations: agrees ? row.confirmations + 1 : 1,
      })
      .where(eq(counterparties.id, counterpartyId));
  }

  list(ctx: WorkspaceContext, query: { q?: string; kind?: CounterpartyRow["kind"] }) {
    return db
      .select()
      .from(counterparties)
      .where(
        and(
          eq(counterparties.workspaceId, ctx.workspaceId),
          query.kind ? eq(counterparties.kind, query.kind) : undefined,
          query.q ? ilike(counterparties.name, `%${query.q}%`) : undefined,
        ),
      )
      .orderBy(desc(counterparties.lastSeenAt))
      .limit(200);
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof counterpartyInput>) {
    const input = counterpartyInput.parse(raw);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(counterparties)
        .values({
          workspaceId: ctx.workspaceId,
          ...input,
          aliases: (input.aliases ?? []).map(normalizeName),
          normalizedName: normalizeName(input.name),
        })
        .returning();
      await this.audit.record(tx, ctx, { action: "counterparty.created", entityType: "counterparty", entityId: row?.id, after: row });
      return row;
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: Partial<z.input<typeof counterpartyInput>>) {
    const input = counterpartyInput.partial().parse(raw);
    return db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(counterparties)
        .where(and(eq(counterparties.id, id), eq(counterparties.workspaceId, ctx.workspaceId)));
      assertFound(before, "Counterparty");
      const [row] = await tx
        .update(counterparties)
        .set({
          ...input,
          ...(input.name ? { normalizedName: normalizeName(input.name) } : {}),
          ...(input.aliases ? { aliases: input.aliases.map(normalizeName) } : {}),
        })
        .where(eq(counterparties.id, id))
        .returning();
      await this.audit.record(tx, ctx, { action: "counterparty.updated", entityType: "counterparty", entityId: id, before, after: row });
      return row;
    });
  }
}

export type ProjectRow = typeof projects.$inferSelect;

@Injectable()
export class ProjectsService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  list(ctx: WorkspaceContext, options: { includeArchived?: boolean } = {}, exec: Executor = db) {
    return exec
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, ctx.workspaceId), options.includeArchived ? undefined : sql`${projects.status} <> 'archived'`))
      .orderBy(desc(projects.isDefault), asc(projects.name));
  }

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    const [row] = await exec
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.workspaceId, ctx.workspaceId)));
    return assertFound(row, "Project");
  }

  async resolveName(ctx: WorkspaceContext, name: string | null | undefined, exec: Executor = db) {
    if (!name) return null;
    const wanted = normalizeName(name);
    const all = await this.list(ctx, {}, exec);
    return all.find((p) => normalizeName(p.name) === wanted || (p.code && normalizeName(p.code) === wanted)) ?? null;
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof projectInput>) {
    const input = projectInput.parse(raw);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({ workspaceId: ctx.workspaceId, ...input })
        .returning();
      await this.audit.record(tx, ctx, { action: "project.created", entityType: "project", entityId: row?.id, after: row });
      return row as ProjectRow;
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof projectUpdate>) {
    const input = projectUpdate.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const [row] = await tx.update(projects).set(input).where(eq(projects.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "project.updated", entityType: "project", entityId: id, before, after: row });
      return row as ProjectRow;
    });
  }
}

export type RuleRow = typeof rules.$inferSelect;

@Injectable()
export class RulesService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  list(ctx: WorkspaceContext, exec: Executor = db) {
    return exec.select().from(rules).where(eq(rules.workspaceId, ctx.workspaceId)).orderBy(asc(rules.priority), asc(rules.createdAt));
  }

  /**
   * Runs the workspace's rules against a record. Called before any AI
   * inference: a rule that decides the category makes the model call
   * unnecessary.
   */
  async evaluate(ctx: WorkspaceContext, subject: RuleSubject, exec: Executor = db): Promise<RuleOutcome> {
    const rows = await exec
      .select()
      .from(rules)
      .where(and(eq(rules.workspaceId, ctx.workspaceId), eq(rules.enabled, true)));
    const outcome = applyRules(rows as Rule[], subject);
    if (outcome.matchedRuleIds.length) {
      await exec
        .update(rules)
        .set({ timesApplied: sql`${rules.timesApplied} + 1`, lastAppliedAt: new Date() })
        .where(inArray(rules.id, outcome.matchedRuleIds));
    }
    return outcome;
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof ruleInput>) {
    const input = ruleInput.parse(raw);
    return db.transaction(async (tx) => {
      await this.checkActionRefs(tx, ctx, input.actions);
      const [row] = await tx
        .insert(rules)
        .values({ workspaceId: ctx.workspaceId, ...input, createdBy: ctx.userId })
        .returning();
      await this.audit.record(tx, ctx, { action: "rule.created", entityType: "rule", entityId: row?.id, after: row });
      return row as RuleRow;
    });
  }

  async update(ctx: WorkspaceContext, id: string, raw: Partial<z.input<typeof ruleInput>>) {
    const input = ruleInput.partial().parse(raw);
    return db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(rules)
        .where(and(eq(rules.id, id), eq(rules.workspaceId, ctx.workspaceId)));
      assertFound(before, "Rule");
      if (input.actions) await this.checkActionRefs(tx, ctx, input.actions);
      const [row] = await tx.update(rules).set(input).where(eq(rules.id, id)).returning();
      await this.audit.record(tx, ctx, { action: "rule.updated", entityType: "rule", entityId: id, before, after: row });
      return row as RuleRow;
    });
  }

  async remove(ctx: WorkspaceContext, id: string) {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .delete(rules)
        .where(and(eq(rules.id, id), eq(rules.workspaceId, ctx.workspaceId)))
        .returning();
      assertFound(before, "Rule");
      await this.audit.record(tx, ctx, { action: "rule.deleted", entityType: "rule", entityId: id, before });
    });
  }

  private async checkActionRefs(exec: Executor, ctx: WorkspaceContext, actions: { categoryId?: string | null; projectId?: string | null }) {
    await assertInWorkspace(exec, categories, ctx.workspaceId, [actions.categoryId], "Category");
    await assertInWorkspace(exec, projects, ctx.workspaceId, [actions.projectId], "Project");
  }
}
