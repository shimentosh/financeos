import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { checkOrigin, EXEMPT_PREFIXES, hasSessionCookie, isExempt, originCheck } from "../../src/common/origin-check.js";
import { defaultLimitApplies } from "../../src/modules/system/rate-limit.js";

const APP = "https://books.example.com";
const cookie = "ew_ws=abc; ew.session_token=token123.sig";
const secureCookie = "__Secure-ew.session_token=token123.sig";

const req = (method: string, path: string, headers: Record<string, string | undefined> = {}) => ({ method, path, headers });

describe("origin check (CSRF)", () => {
  it("recognises the session cookie in both its plain and __Secure- forms", () => {
    expect(hasSessionCookie(cookie)).toBe(true);
    expect(hasSessionCookie(secureCookie)).toBe(true);
    expect(hasSessionCookie("ew_ws=abc; other=1")).toBe(false);
    expect(hasSessionCookie("xew.session_token=1")).toBe(false);
    expect(hasSessionCookie(undefined)).toBe(false);
  });

  it("rejects a cookie-authenticated write from another origin", () => {
    expect(checkOrigin(req("POST", "/api/transactions", { cookie, origin: "https://evil.example" }), APP)).toEqual({
      ok: false,
      reason: "origin https://evil.example",
    });
    expect(checkOrigin(req("DELETE", "/api/accounts/1", { cookie: secureCookie, origin: "http://books.example.com" }), APP).ok).toBe(false);
    // Same host, other port or scheme is another origin.
    expect(checkOrigin(req("PATCH", "/api/accounts/1", { cookie, origin: "https://books.example.com:8443" }), APP).ok).toBe(false);
  });

  it("falls back to Referer when Origin is missing, and treats opaque origins as foreign", () => {
    expect(checkOrigin(req("POST", "/api/x", { cookie, referer: "https://evil.example/page?q=1" }), APP).ok).toBe(false);
    expect(checkOrigin(req("POST", "/api/x", { cookie, referer: "https://books.example.com/transactions?q=1" }), APP).ok).toBe(true);
    expect(checkOrigin(req("POST", "/api/x", { cookie, origin: "null" }), APP)).toEqual({ ok: false, reason: "an opaque origin" });
    expect(checkOrigin(req("POST", "/api/x", { cookie, origin: "not a url" }), APP).ok).toBe(false);
    // Origin wins over Referer.
    expect(checkOrigin(req("POST", "/api/x", { cookie, origin: APP, referer: "https://evil.example/" }), APP).ok).toBe(true);
  });

  it("lets through reads, cookieless and bearer requests, and requests that name no origin", () => {
    expect(checkOrigin(req("GET", "/api/transactions", { cookie, origin: "https://evil.example" }), APP).ok).toBe(true);
    expect(checkOrigin(req("OPTIONS", "/api/transactions", { cookie, origin: "https://evil.example" }), APP).ok).toBe(true);
    expect(checkOrigin(req("POST", "/api/transactions", { origin: "https://evil.example" }), APP).ok).toBe(true);
    expect(checkOrigin(req("POST", "/api/transactions", { cookie, authorization: "Bearer ew_live_abc", origin: "https://evil.example" }), APP).ok).toBe(true);
    // The web server's Server Actions forward the cookie without Origin/Referer.
    expect(checkOrigin(req("POST", "/api/transactions", { cookie }), APP).ok).toBe(true);
    expect(checkOrigin(req("POST", "/api/transactions", { cookie, origin: APP }), APP).ok).toBe(true);
  });

  it("does not accept a non-bearer Authorization header as a way around the check", () => {
    expect(checkOrigin(req("POST", "/api/x", { cookie, authorization: "Basic abc", origin: "https://evil.example" }), APP).ok).toBe(false);
    expect(checkOrigin(req("POST", "/api/x", { cookie, authorization: "Bearer ", origin: "https://evil.example" }), APP).ok).toBe(false);
  });

  it("exempts Better Auth, webhooks, payment callbacks and key-authenticated APIs — and nothing that merely starts alike", () => {
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/billing/webhooks/stripe",
      "/api/billing/sslcommerz/success",
      "/api/billing/sslcommerz/ipn",
      "/api/webhooks/wh_123",
      "/api/v1/transactions",
      "/api/mcp",
      "/api/MCP",
    ]) {
      expect(isExempt(path), path).toBe(true);
      expect(checkOrigin(req("POST", path, { cookie, origin: "https://pay.example" }), APP).ok, path).toBe(true);
    }
    for (const path of ["/api/mcpx", "/api/authx/whatever", "/api/v1x", "/api/billing/checkout", "/api/transactions"]) {
      expect(isExempt(path), path).toBe(false);
    }
    expect(EXEMPT_PREFIXES).toContain("/api/auth/");
  });

  it("answers a rejected write with a 403 JSON body carrying the request id", () => {
    const middleware = originCheck(`${APP}/`);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn() as unknown as NextFunction;
    const request = { method: "POST", path: "/api/transactions", headers: { cookie, origin: "https://evil.example" }, requestId: "req-12345678" };
    middleware(request as unknown as Request, { status } as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, error: "origin_rejected", requestId: "req-12345678" }));

    const allowed = vi.fn() as unknown as NextFunction;
    middleware({ ...request, headers: { cookie, origin: APP } } as unknown as Request, { status } as unknown as Response, allowed);
    expect(allowed).toHaveBeenCalledOnce();
  });
});

describe("default write rate limit", () => {
  it("applies to writes, not reads, and skips self-metered and provider routes", () => {
    expect(defaultLimitApplies("POST", "/api/transactions")).toBe(true);
    expect(defaultLimitApplies("delete", "/api/accounts/1")).toBe(true);
    expect(defaultLimitApplies("GET", "/api/transactions")).toBe(false);
    for (const path of [
      "/api/webhooks/abc",
      "/api/billing/webhooks/stripe",
      "/api/billing/sslcommerz/ipn",
      "/api/v1/transactions",
      "/api/mcp",
      "/api/system/tick",
    ]) {
      expect(defaultLimitApplies("POST", path), path).toBe(false);
    }
    expect(defaultLimitApplies("POST", "/api/system/client-errors")).toBe(true);
  });
});
