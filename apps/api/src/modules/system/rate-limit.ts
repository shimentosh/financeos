import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sql } from "drizzle-orm";
import type { AppRequest } from "../../common/context.js";
import { tooManyRequests } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { rateLimits } from "../../db/schema/index.js";

/**
 * Counts a hit in a fixed window and reports whether it is within the limit.
 * Kept in PostgreSQL so the limit holds across every API instance.
 */
export async function hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const result = await db.execute<{ count: number }>(sql`
    insert into ${rateLimits} (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when ${rateLimits.windowStart} < now() - make_interval(secs => ${windowSeconds}) then 1 else ${rateLimits.count} + 1 end,
      window_start = case when ${rateLimits.windowStart} < now() - make_interval(secs => ${windowSeconds}) then now() else ${rateLimits.windowStart} end
    returning count
  `);
  return (result.rows[0]?.count ?? 0) <= limit;
}

/** Deletes counters whose window ended long ago (the longest window in use is an hour). */
export async function pruneRateLimits(olderThanHours = 24): Promise<number> {
  const result = await db.execute(sql`delete from ${rateLimits} where ${rateLimits.windowStart} < now() - make_interval(hours => ${olderThanHours})`);
  return result.rowCount ?? 0;
}

const RATE_LIMIT = "ew:rate-limit";

type LimitConfig = { bucket: string; limit: number; windowSeconds: number };

/** `@RateLimit("ai", 30, 60)`: 30 requests per minute per user (or IP). */
export const RateLimit = (bucket: string, limit: number, windowSeconds: number) => SetMetadata(RATE_LIMIT, { bucket, limit, windowSeconds });

/**
 * Every write without its own @RateLimit shares this budget per user (or IP):
 * generous for people, a ceiling for scripts and runaway clients.
 */
export const DEFAULT_WRITE_LIMIT: LimitConfig = { bucket: "writes", limit: 300, windowSeconds: 60 };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes that meter themselves or must not be throttled by caller IP:
 * provider webhooks and payment callbacks (bursts from a few provider IPs),
 * the API-key API and MCP (limited per key), the cron tick (secret-guarded).
 */
const DEFAULT_EXEMPT = ["/api/webhooks/", "/api/billing/webhooks/", "/api/billing/sslcommerz/", "/api/v1/", "/api/mcp", "/api/system/tick"];

export function defaultLimitApplies(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  const lower = path.toLowerCase();
  return !DEFAULT_EXEMPT.some((prefix) => {
    const base = prefix.replace(/\/+$/, "");
    return lower === base || lower.startsWith(`${base}/`);
  });
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    let config = this.reflector.getAllAndOverride<LimitConfig | undefined>(RATE_LIMIT, [context.getHandler(), context.getClass()]);
    if (!config) {
      const path = (request.originalUrl ?? request.url ?? "").split("?")[0] ?? "";
      if (!defaultLimitApplies(request.method, path)) return true;
      config = DEFAULT_WRITE_LIMIT;
    }
    const who = request.user?.id ?? request.ctx?.apiKeyId ?? request.ip ?? "anonymous";
    const allowed = await hit(`${config.bucket}:${who}`, config.limit, config.windowSeconds);
    if (!allowed) throw tooManyRequests();
    return true;
  }
}
