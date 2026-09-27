import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";

/**
 * Where the generated SQL migrations live, in development (src/db → ../../drizzle)
 * and in a built image (dist/db → ../../drizzle, copied next to dist/).
 * MIGRATIONS_DIR overrides both; the working directory's ./drizzle is the
 * last resort.
 */
export function migrationsFolder(): string {
  const candidates = [process.env.MIGRATIONS_DIR, fileURLToPath(new URL("../../drizzle", import.meta.url)), resolve(process.cwd(), "drizzle")];
  for (const candidate of candidates) {
    if (candidate && existsSync(resolve(candidate, "meta", "_journal.json"))) return resolve(candidate);
  }
  throw new Error(`No migrations folder found (looked in ${candidates.filter(Boolean).join(", ")}); set MIGRATIONS_DIR`);
}

export type JournalEntry = { idx: number; tag: string; when: number };

export function readJournal(folder = migrationsFolder()): JournalEntry[] {
  const journal = JSON.parse(readFileSync(resolve(folder, "meta", "_journal.json"), "utf8")) as { entries?: JournalEntry[] };
  return [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx);
}

/**
 * Drizzle's migrator applies every journal entry newer than the newest
 * `created_at` in drizzle.__drizzle_migrations; the same rule says what is
 * still pending.
 */
export function pendingMigrations(journal: JournalEntry[], lastAppliedAt: number | null): JournalEntry[] {
  return journal.filter((entry) => lastAppliedAt === null || entry.when > lastAppliedAt);
}

export type MigrationStatus = { applied: number; expected: number; pending: string[]; lastAppliedAt: number | null };

type Queryable = { execute: (query: SQL) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** Compares the journal on disk with what the database has applied. */
export async function migrationStatus(exec: Queryable, folder?: string): Promise<MigrationStatus> {
  const journal = readJournal(folder);
  let applied = 0;
  let lastAppliedAt: number | null = null;
  try {
    const result = await exec.execute(sql`select count(*)::int as count, max(created_at) as last from drizzle.__drizzle_migrations`);
    const row = result.rows[0] ?? {};
    applied = Number(row.count ?? 0);
    lastAppliedAt = row.last === null || row.last === undefined ? null : Number(row.last);
  } catch (error) {
    // No migrations table yet (a fresh database): everything is pending.
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code !== "42P01" && code !== "3F000") throw error;
  }
  return { applied, expected: journal.length, pending: pendingMigrations(journal, lastAppliedAt).map((entry) => entry.tag), lastAppliedAt };
}
