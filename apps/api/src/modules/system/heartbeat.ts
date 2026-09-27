import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformSettings } from "../../db/schema/index.js";

/** platform_setting key holding the last sign of life from a worker loop. */
export const WORKER_HEARTBEAT_KEY = "worker_heartbeat";
const INTERVAL_MS = 60_000;
/** A worker polls every two seconds; three missed minutes means it is gone. */
export const HEARTBEAT_STALE_SECONDS = 180;

let lastWritten = 0;

/**
 * Records that a worker loop is alive, at most once a minute per process, so
 * the admin panel can tell a stopped worker from an idle queue.
 */
export async function recordHeartbeat(instance: string, now: Date = new Date()): Promise<boolean> {
  if (now.getTime() - lastWritten < INTERVAL_MS) return false;
  lastWritten = now.getTime();
  const value = { at: now.toISOString(), instance };
  await db
    .insert(platformSettings)
    .values({ key: WORKER_HEARTBEAT_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: now } });
  return true;
}

/** For tests: forget the last write, so the next beat is written immediately. */
export function resetHeartbeatThrottle() {
  lastWritten = 0;
}

export type Heartbeat = { at: string; instance: string; ageSeconds: number; healthy: boolean };

export async function readHeartbeat(now: Date = new Date()): Promise<Heartbeat | null> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, WORKER_HEARTBEAT_KEY)).limit(1);
  const at = typeof row?.value.at === "string" ? row.value.at : null;
  if (!at) return null;
  const ageSeconds = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000));
  return { at, instance: String(row?.value.instance ?? "unknown"), ageSeconds, healthy: ageSeconds <= HEARTBEAT_STALE_SECONDS };
}
