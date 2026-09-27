import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Per-request context: the request id travels with the request through
 * AsyncLocalStorage, so every log line and error report written while serving
 * it carries the same id, and the caller sees it in the `x-request-id`
 * response header and in error bodies.
 */
export type RequestStore = { requestId: string };

export const requestStorage = new AsyncLocalStorage<RequestStore>();

export const REQUEST_ID_HEADER = "x-request-id";

// A caller's id is reused only when it looks like an id (a load balancer's or
// the web server's); anything else is replaced, so log lines stay clean.
const ACCEPTED_ID = /^[A-Za-z0-9._:-]{8,128}$/;

type TrackedRequest = Request & {
  requestId?: string;
  requestStore?: RequestStore;
  user?: { id: string };
  ctx?: { apiKeyId?: string };
};

export function currentRequestId(): string | undefined {
  return requestStorage.getStore()?.requestId;
}

/** The id of a request: set by the middleware, or the one in the current async context. */
export function requestIdOf(request: unknown): string | undefined {
  return (request as TrackedRequest | undefined)?.requestId ?? currentRequestId();
}

export function acceptRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate && ACCEPTED_ID.test(candidate) ? candidate : randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Long and containing a digit: a token or id, not a word like "notification-preferences".
const TOKEN = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;

/**
 * The route for an access log line: the matched pattern when Express knows it,
 * otherwise the path with ids and token-like segments replaced (reset tokens
 * and webhook ids must not end up in logs). Never the query string.
 */
export function routeOf(request: Pick<Request, "originalUrl" | "baseUrl"> & { route?: { path?: unknown } }): string {
  const pattern = request.route?.path;
  if (typeof pattern === "string") return `${request.baseUrl ?? ""}${pattern}`;
  const path = (request.originalUrl ?? "/").split("?")[0] ?? "/";
  return path
    .split("/")
    .map((segment) => (UUID.test(segment) ? ":id" : TOKEN.test(segment) ? ":token" : /^\d+$/.test(segment) ? ":n" : segment))
    .join("/");
}

/**
 * Express middleware, registered first: assigns the request id, echoes it in
 * the response and, when `accessLog` is given, writes one line per request
 * (method, route, status, duration, user) — never bodies, headers or queries.
 */
export function requestContext(options: { accessLog?: ((fields: Record<string, unknown>) => void) | null } = {}) {
  return (request: Request, response: Response, next: NextFunction) => {
    const tracked = request as TrackedRequest;
    const requestId = acceptRequestId(request.headers[REQUEST_ID_HEADER]);
    const store: RequestStore = { requestId };
    tracked.requestId = requestId;
    tracked.requestStore = store;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const accessLog = options.accessLog;
    if (accessLog) {
      const started = process.hrtime.bigint();
      response.once("finish", () => {
        const route = routeOf(tracked);
        // Health probes every few seconds are noise unless they fail.
        if (route.startsWith("/api/health") && response.statusCode < 400) return;
        accessLog({
          requestId,
          method: request.method,
          route,
          status: response.statusCode,
          ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
          ...(tracked.user?.id ? { userId: tracked.user.id } : {}),
          ...(tracked.ctx?.apiKeyId ? { apiKeyId: tracked.ctx.apiKeyId } : {}),
        });
      });
    }
    requestStorage.run(store, next);
  };
}

/**
 * Body parsers finish in stream callbacks, outside the request's async
 * context; this re-enters it for everything that runs after them.
 */
export function restoreRequestContext(request: Request, _response: Response, next: NextFunction) {
  const store = (request as TrackedRequest).requestStore;
  if (!store) return next();
  requestStorage.run(store, next);
}
