import "../load-env.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { migrationsFolder } from "../db/migrations.js";

/**
 * Applies pending migrations from apps/api/drizzle (or MIGRATIONS_DIR).
 *
 *   pnpm db:migrate                  development database (tsx, from source)
 *   pnpm db:migrate:test             DATABASE_URL_TEST
 *   node dist/scripts/migrate.js     production: the release step, before the new
 *                                    version starts serving (`pnpm migrate:prod`)
 *
 * A session advisory lock serialises concurrent runs (two replicas starting
 * at once), and each migration runs in a transaction, so a failed run leaves
 * the schema as it was.
 */
const LOCK_ID = 7_342_001; // arbitrary, constant: "FinanceOS migrations"

async function main() {
  const target = process.argv.includes("--test") ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
  if (!target) throw new Error(process.argv.includes("--test") ? "DATABASE_URL_TEST is not set" : "DATABASE_URL is not set");

  const folder = migrationsFolder();
  const pool = new Pool({ connectionString: target, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    }
    console.log(`migrations applied → ${new URL(target).pathname.slice(1)} (from ${folder})`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
