import { DEFAULT_REMINDER_OFFSETS, type DefaultCategory, defaultCategories, SEED_RATES_TO_BDT, today, type WorkspaceKind } from "@financeos/core";
import { count, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "../../db/index.js";
import { categories, exchangeRates, financialAccounts, projects, userSettings, users, workspaceMembers, workspaces } from "../../db/schema/index.js";
import { env } from "../../env.js";

export type NewWorkspace = {
  name: string;
  kind: WorkspaceKind;
  baseCurrency?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
};

async function insertCategories(exec: Executor, workspaceId: string, list: DefaultCategory[]) {
  let order = 0;
  for (const category of list) {
    const [parent] = await exec
      .insert(categories)
      .values({
        workspaceId,
        name: category.name,
        kind: category.kind,
        icon: category.icon,
        color: category.color,
        isSystem: true,
        sortOrder: order++,
      })
      .returning({ id: categories.id });
    if (!parent || !category.children?.length) continue;
    await exec.insert(categories).values(
      category.children.map((child, index) => ({
        workspaceId,
        name: child.name,
        kind: category.kind,
        parentId: parent.id,
        icon: child.icon,
        color: category.color,
        isSystem: true,
        sortOrder: index,
      })),
    );
  }
}

/**
 * A workspace ready to use: owner membership, starter categories, seed
 * exchange rates to the base currency (labelled "seed", meant to be replaced),
 * a Cash account for personal books and a General Operations project for a
 * business.
 */
export async function createWorkspace(exec: Executor, ownerId: string, input: NewWorkspace) {
  const baseCurrency = (input.baseCurrency ?? "BDT").toUpperCase();
  const [workspace] = await exec
    .insert(workspaces)
    .values({
      name: input.name,
      kind: input.kind,
      baseCurrency,
      timezone: input.timezone ?? "Asia/Dhaka",
      fiscalYearStartMonth: input.fiscalYearStartMonth ?? (input.kind === "business" ? 7 : 1),
      settings: { reminderOffsets: [...DEFAULT_REMINDER_OFFSETS], aiEnabled: true, autoPostHighConfidence: false },
    })
    .returning();
  if (!workspace) throw new Error("Workspace was not created");

  await exec.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: ownerId, role: "owner" });
  await insertCategories(exec, workspace.id, defaultCategories(input.kind));

  const day = today(workspace.timezone);
  if (baseCurrency === "BDT") {
    await exec.insert(exchangeRates).values(
      Object.entries(SEED_RATES_TO_BDT).map(([from, rate]) => ({
        workspaceId: workspace.id,
        fromCurrency: from,
        toCurrency: "BDT",
        rate,
        date: "2026-01-01",
        source: "seed" as const,
      })),
    );
  }

  if (input.kind === "personal") {
    await exec.insert(financialAccounts).values({
      workspaceId: workspace.id,
      name: "Cash",
      kind: "cash",
      currency: baseCurrency,
      openingBalance: 0,
      openingDate: day,
    });
  } else {
    await exec.insert(projects).values({
      workspaceId: workspace.id,
      name: "General Operations",
      code: "OPS",
      isDefault: true,
      startDate: day,
    });
  }
  return workspace;
}

/**
 * Runs once per new user: a personal and a business workspace, and the
 * platform admin role for anyone listed in ADMIN_EMAILS. Outside production
 * the very first user is made admin too, so a fresh development install has
 * one; in production only ADMIN_EMAILS counts, so nobody can claim a new
 * deployment by signing up first.
 */
export async function provisionUser(user: { id: string; email: string; name: string }) {
  await db.transaction(async (tx) => {
    const [{ value: userCount } = { value: 0 }] = await tx.select({ value: count() }).from(users);
    const isAdmin = env.ADMIN_EMAILS.includes(user.email.toLowerCase()) || (env.NODE_ENV !== "production" && userCount <= 1);
    if (isAdmin) await tx.update(users).set({ role: "admin" }).where(eq(users.id, user.id));

    const firstName = user.name.split(" ")[0] || "My";
    const personal = await createWorkspace(tx, user.id, { name: "Personal", kind: "personal" });
    await createWorkspace(tx, user.id, { name: `${firstName}'s Company`, kind: "business" });
    await tx
      .insert(userSettings)
      .values({ userId: user.id, activeWorkspaceId: personal.id, preferences: { numberLocale: "en-IN", theme: "system" } })
      .onConflictDoNothing();
  });
}

export async function workspaceIdsFor(userId: string, exec: Executor = db) {
  const rows = await exec.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
  return rows.map((row) => row.id);
}

export async function workspacesByIds(ids: string[], exec: Executor = db) {
  if (!ids.length) return [];
  return exec.select().from(workspaces).where(inArray(workspaces.id, ids));
}
