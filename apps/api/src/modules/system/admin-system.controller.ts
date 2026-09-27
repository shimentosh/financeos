import { Controller, Get, UseGuards } from "@nestjs/common";
import { desc, sql } from "drizzle-orm";
import { appVersion, errorReporter } from "../../common/error-reporter.js";
import { AdminGuard } from "../../common/guards.js";
import { db } from "../../db/index.js";
import { schedulerRuns } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { aiRuntime } from "../ai/gateway/router.provider.js";
import { loadStorageConfig } from "../storage/storage-config.js";
import { readiness } from "./health.controller.js";
import { readHeartbeat } from "./heartbeat.js";

/**
 * GET /api/admin/system — how this installation runs, for platform admins:
 * version, database and migrations, AI provider, storage, worker layout and
 * its last heartbeat, when each schedule last fired (across all instances).
 */
@Controller("admin/system")
@UseGuards(AdminGuard)
export class AdminSystemController {
  @Get()
  async system() {
    const started = Date.now();
    const ready = await readiness();
    const latencyMs = Date.now() - started;
    const [heartbeat, storage, schedules] = await Promise.all([
      readHeartbeat().catch(() => null),
      loadStorageConfig().catch(() => null),
      db
        .select({ name: schedulerRuns.name, lastSlot: sql<Date>`max(${schedulerRuns.slot})`, runs: sql<number>`count(*)::int` })
        .from(schedulerRuns)
        .groupBy(schedulerRuns.name)
        .orderBy(desc(sql`max(${schedulerRuns.slot})`))
        .catch(() => []),
    ]);
    return {
      version: appVersion,
      environment: env.NODE_ENV,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      database: { ok: ready.database, latencyMs, poolMax: env.DATABASE_POOL_MAX },
      migrations: ready.migrations,
      ready: ready.ready,
      ai: { provider: aiRuntime.provider, model: aiRuntime.model, source: aiRuntime.source },
      storage: storage?.stored.provider ?? env.STORAGE_DRIVER,
      worker: { mode: env.RUN_WORKER_IN_PROCESS ? "in-process" : "external", heartbeat },
      schedules,
      observability: { errorReporting: errorReporter().enabled, logFormat: env.LOG_FORMAT, trustProxy: env.TRUST_PROXY },
    };
  }
}
