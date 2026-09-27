import { Controller, Get, Res } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { appVersion } from "../../common/error-reporter.js";
import { Public } from "../../common/guards.js";
import { db } from "../../db/index.js";
import { type MigrationStatus, migrationStatus } from "../../db/migrations.js";

/** Is the database reachable, and how long does a round trip take. */
export async function databaseCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

export type Readiness = { ready: boolean; database: boolean; migrations: MigrationStatus | null };

/** Ready to serve: the database answers and every migration on disk has been applied. */
export async function readiness(folder?: string): Promise<Readiness> {
  const database = await databaseCheck();
  if (!database.ok) return { ready: false, database: false, migrations: null };
  try {
    const migrations = await migrationStatus(db, folder);
    return { ready: migrations.pending.length === 0, database: true, migrations };
  } catch {
    return { ready: false, database: true, migrations: null };
  }
}

/**
 * Public probes. They say only whether the service works — which AI provider,
 * storage or worker layout it uses is for platform admins (GET /api/admin/system).
 */
@Controller("health")
@Public()
export class HealthController {
  /** Liveness: the process answers and reaches its database. */
  @Get()
  async health(@Res({ passthrough: true }) response: Response) {
    const database = await databaseCheck();
    if (!database.ok) response.status(503);
    return { status: database.ok ? "ok" : "error", database: { ok: database.ok }, version: appVersion };
  }

  /** Readiness: also no pending migrations, so a load balancer holds traffic until the release step ran. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const result = await readiness();
    if (!result.ready) response.status(503);
    return {
      status: result.ready ? "ready" : "not_ready",
      database: { ok: result.database },
      migrations: { pending: result.migrations?.pending.length ?? null },
      version: appVersion,
    };
  }
}
