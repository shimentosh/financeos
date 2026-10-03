import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export { schema };

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction on one. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

type Holder = { pool?: Pool; db?: Database };

// One pool per process. Next.js dev reloads modules on every edit, so the pool
// is kept on globalThis instead of being re-created (and leaked) each time.
const holder = globalThis as typeof globalThis & { __financeOsDb?: Holder };
holder.__financeOsDb ??= {};

function createPool(connectionString: string) {
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export function getDb(): Database {
  const state = holder.__financeOsDb as Holder;
  if (!state.db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    state.pool = createPool(url);
    state.db = drizzle(state.pool, { schema });
  }
  return state.db;
}

/** For tests and scripts that point the app at another database. */
export function setDatabaseUrl(url: string) {
  const state = holder.__financeOsDb as Holder;
  void state.pool?.end();
  state.pool = createPool(url);
  state.db = drizzle(state.pool, { schema });
  return state.db;
}

export async function closeDb() {
  const state = holder.__financeOsDb as Holder;
  await state.pool?.end();
  state.pool = undefined;
  state.db = undefined;
}

export const db = new Proxy({} as Database, {
  get(_target, property) {
    const instance = getDb();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
