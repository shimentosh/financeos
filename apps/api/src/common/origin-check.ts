import type { NextFunction, Request, Response } from "express";
import { requestIdOf } from "./request-context.js";

/**
 * CSRF defence for cookie-authenticated writes. The session cookie is
 * SameSite=Lax, which already stops most cross-site POSTs; this closes the
 * rest (same-site subdomains, older browsers, top-level form posts): a write
 * that carries the session cookie and says where it came from (Origin, else
 * Referer) must come from APP_URL.
 *
 * Passed through untouched:
 * - reads (GET/HEAD/OPTIONS);
 * - requests without the session cookie, or with `Authorization: Bearer`
 *   (API keys: nothing ambient for another site to borrow);
 * - requests with neither Origin nor Referer (server-to-server calls, such as
 *   the web server's Server Actions forwarding the cookie);
 * - routes that verify their callers themselves (EXEMPT_PREFIXES).
 */

export const SESSION_COOKIES = ["ew.session_token", "__Secure-ew.session_token"];

/**
 * Better Auth checks origins itself; payment callbacks and webhooks arrive
 * from the provider's site and are verified by signature or validation call;
 * the public API and MCP authenticate with keys.
 */
export const EXEMPT_PREFIXES = ["/api/auth/", "/api/billing/webhooks/", "/api/billing/sslcommerz/", "/api/webhooks/", "/api/v1/", "/api/mcp"];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function hasSessionCookie(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(";").some((part) => {
    const name = part.split("=")[0]?.trim();
    return name !== undefined && SESSION_COOKIES.includes(name);
  });
}

export function isExempt(path: string): boolean {
  const lower = path.toLowerCase();
  return EXEMPT_PREFIXES.some((prefix) => {
    const base = prefix.replace(/\/+$/, "");
    return lower === base || lower.startsWith(`${base}/`);
  });
}

/** The origin a header names; `null` for an unparseable or opaque ("null") value. */
function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

export function checkOrigin(
  request: { method: string; path: string; headers: Record<string, string | string[] | undefined> },
  allowedOrigin: string,
): OriginVerdict {
  if (!WRITE_METHODS.has(request.method.toUpperCase())) return { ok: true };
  if (isExempt(request.path)) return { ok: true };
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (!hasSessionCookie(header("cookie"))) return { ok: true };
  if (/^bearer\s+\S/i.test(header("authorization") ?? "")) return { ok: true };
  const origin = header("origin");
  const referer = header("referer");
  const source = origin !== undefined ? origin : referer;
  if (source === undefined || source === "") return { ok: true };
  const claimed = originOf(source);
  if (claimed === allowedOrigin) return { ok: true };
  return { ok: false, reason: claimed ? `origin ${claimed}` : "an opaque origin" };
}

/** Express middleware: 403 JSON for a cross-origin, cookie-authenticated write. */
export function originCheck(appUrl: string) {
  const allowedOrigin = new URL(appUrl).origin;
  return (request: Request, response: Response, next: NextFunction) => {
    const verdict = checkOrigin({ method: request.method, path: request.path, headers: request.headers }, allowedOrigin);
    if (verdict.ok) return next();
    const requestId = requestIdOf(request);
    response.status(403).json({
      statusCode: 403,
      error: "origin_rejected",
      message: "This request did not come from the app. Reload the page and try again.",
      ...(requestId ? { requestId } : {}),
    });
  };
}
