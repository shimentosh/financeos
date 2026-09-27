import { randomUUID } from "node:crypto";
import type { INestApplicationContext, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { asc, eq, sql } from "drizzle-orm";
import { AppModule } from "../../src/app.module.js";
import { contextFor, type WorkspaceContext } from "../../src/common/context.js";
import { closeDb, db } from "../../src/db/index.js";
import { users, workspaceMembers, workspaces } from "../../src/db/schema/index.js";
import { provisionUser } from "../../src/modules/workspaces/provisioning.js";

let app: INestApplicationContext | null = null;

/** The whole Nest application, without HTTP, for calling services directly. */
export async function getApp(): Promise<INestApplicationContext> {
  if (!app) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    await app.init();
  }
  return app;
}

export async function service<T>(type: Type<T>): Promise<T> {
  return (await getApp()).get(type, { strict: false });
}

/** Empties every table. Only ever runs against DATABASE_URL_TEST. */
export async function resetDatabase() {
  if (!process.env.DATABASE_URL?.includes("test")) throw new Error("resetDatabase only runs on a test database");
  const tables = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'
  `);
  const names = tables.rows.map((row) => `"${row.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate table ${names} restart identity cascade`));
}

export type TestUser = {
  userId: string;
  email: string;
  personal: WorkspaceContext;
  business: WorkspaceContext;
};

/**
 * A signed-up user as the sign-up hook leaves them: personal and business
 * workspaces with default categories, a Cash account, seed exchange rates.
 */
export async function createUser(name = "Test User"): Promise<TestUser> {
  const userId = randomUUID().replace(/-/g, "");
  const email = `${userId.slice(0, 10)}@example.test`;
  await db.insert(users).values({ id: userId, name, email });
  await provisionUser({ id: userId, email, name });
  const rows = await db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt));
  const context = (kind: "personal" | "business") => {
    const row = rows.find((r) => r.workspace.kind === kind);
    if (!row) throw new Error(`No ${kind} workspace`);
    return contextFor(row.workspace, { userId, actorType: "user", role: row.role });
  };
  return { userId, email, personal: context("personal"), business: context("business") };
}

/** Same workspace, acting as the system (jobs, integrations). */
export function asSystem(ctx: WorkspaceContext, actorType: WorkspaceContext["actorType"] = "system"): WorkspaceContext {
  return { ...ctx, userId: null, actorType };
}

export async function shutdown() {
  if (app) await app.close();
  app = null;
  await closeDb();
}
