import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { AppRequest } from "../../../common/context.js";
import { DomainError, forbidden, tooManyRequests } from "../../../common/errors.js";
import { WORKSPACE_HEADER } from "../../../common/guards.js";
import { EntitlementsService } from "../../billing/entitlements.service.js";
import { hit } from "../../system/rate-limit.js";
import { ApiKeysService } from "./api-keys.service.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Requests per key per minute. */
export const API_KEY_RATE_LIMIT = 120;

/**
 * The workspace a key request names: the X-Workspace-Id header or the
 * `?workspace=` query (an id, a name, or "personal"/"business").
 */
export function requestedWorkspace(request: Pick<AppRequest, "headers" | "query">): string | undefined {
  const header = request.headers[WORKSPACE_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const query = request.query?.workspace;
  const fromQuery = Array.isArray(query) ? query[0] : query;
  const value = fromHeader || (typeof fromQuery === "string" ? fromQuery : undefined);
  return value?.trim() || undefined;
}

/**
 * Authenticates `/api/v1/*` with `Authorization: Bearer ew_live_…`. Builds the
 * workspace context the key acts in (actor type "api", role member) — its own
 * workspace, or with the all_workspaces scope the one the request names — and
 * attaches it as `request.ctx`, so `@Ctx()` works as on session routes.
 * Controllers using it are `@Public()` so the session guard steps aside.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(ApiKeysService) private readonly keys: ApiKeysService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const header = request.headers.authorization;
    const token = typeof header === "string" ? header.match(/^Bearer\s+(\S+)\s*$/i)?.[1] : undefined;
    if (!token) throw new DomainError(401, "Missing API key. Send it as Authorization: Bearer ew_live_…", "missing_api_key");
    const key = await this.keys.authenticate(token);
    if (!key) throw new DomainError(401, "This API key is invalid, revoked or expired", "invalid_api_key");
    if (!(await hit(`api:${key.id}`, API_KEY_RATE_LIMIT, 60))) throw tooManyRequests(`Rate limit: ${API_KEY_RATE_LIMIT} requests a minute per key`);
    if (!READ_METHODS.has(request.method) && !key.scopes.includes("write")) {
      throw forbidden("This API key is read-only; create one with the write scope", "insufficient_scope");
    }
    const { ctx, canWrite } = await this.keys.contextFor(key, requestedWorkspace(request), request.ip);
    if (!READ_METHODS.has(request.method) && !canWrite) {
      throw forbidden(`You can only view "${ctx.workspaceName}", so this key can't change it`, "insufficient_scope");
    }
    // The workspace owner's plan must include API access (HTTP 402 otherwise).
    await this.entitlements.assertApiAccess(ctx.workspaceId);
    request.ctx = ctx;
    return true;
  }
}
