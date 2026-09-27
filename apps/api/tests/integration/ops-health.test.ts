import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { auth } from "../../src/auth/auth.js";
import { configureHttpServer } from "../../src/common/http-server.js";
import { AppLogger } from "../../src/common/logger.js";
import { closeDb, db } from "../../src/db/index.js";
import { migrationStatus, migrationsFolder, pendingMigrations, readJournal } from "../../src/db/migrations.js";
import { users } from "../../src/db/schema/index.js";
import { env } from "../../src/env.js";
import { readiness } from "../../src/modules/system/health.controller.js";
import { readHeartbeat, recordHeartbeat, resetHeartbeatThrottle } from "../../src/modules/system/heartbeat.js";
import { resetDatabase } from "./harness.js";

// The operational surface over real HTTP, with the same Express stack as
// main.ts: probes, the admin system view, request ids, the CSRF origin check
// and browser error reports.

let app: NestExpressApplication;
let base: string;
const appOrigin = new URL(env.APP_URL).origin;
// JSON log lines written while serving (the access log among them).
const logLines: Array<Record<string, unknown>> = [];
const accessLogger = new AppLogger({ format: "json", levels: ["log"], write: (line) => logLines.push(JSON.parse(line)) });

async function signUp(name: string) {
  const response = await auth.api.signUpEmail({
    body: { email: `${name.toLowerCase().replace(/\W+/g, "-")}-${Date.now()}@example.test`, password: "correct horse battery staple", name },
    asResponse: true,
  });
  const body = (await response.json()) as { user: { id: string } };
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  return { cookie, userId: body.user.id };
}

async function call(method: string, path: string, init: { cookie?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.body !== undefined || init.raw !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

beforeAll(async () => {
  await resetDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureHttpServer(app, { appUrl: env.APP_URL, trustProxy: "1", logger: accessLogger });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("migrations and readiness", () => {
  it("finds the migrations folder and sees every migration applied", async () => {
    const folder = migrationsFolder();
    expect(readJournal(folder).length).toBeGreaterThan(0);
    const status = await migrationStatus(db);
    expect(status.pending).toEqual([]);
    expect(status.applied).toBe(status.expected);
    expect(await readiness()).toMatchObject({ ready: true, database: true });
  });

  it("is not ready while a migration on disk is not applied", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ew-migrations-"));
    try {
      const journal = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: Array<Record<string, unknown>> };
      journal.entries.push({ idx: journal.entries.length, version: "7", when: Date.now() + 86_400_000, tag: "9999_not_applied", breakpoints: true });
      mkdirSync(join(folder, "meta"));
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
      expect((await migrationStatus(db, folder)).pending).toEqual(["9999_not_applied"]);
      expect(await readiness(folder)).toMatchObject({ ready: false, database: true });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("treats a database without the migrations table as entirely pending", async () => {
    const fresh = {
      execute: async () => {
        throw Object.assign(new Error('relation "drizzle.__drizzle_migrations" does not exist'), { code: "42P01" });
      },
    };
    const status = await migrationStatus(fresh);
    expect(status.applied).toBe(0);
    expect(status.pending).toHaveLength(readJournal().length);
    expect(
      pendingMigrations(
        [
          { idx: 0, tag: "a", when: 10 },
          { idx: 1, tag: "b", when: 20 },
        ],
        10,
      ).map((entry) => entry.tag),
    ).toEqual(["b"]);
  });
});

describe("probes", () => {
  it("GET /api/health says only whether it works", async () => {
    const response = await call("GET", "/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: { ok: true }, version: expect.any(String) });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET /api/health/ready is 200 with no pending migrations", async () => {
    const response = await call("GET", "/health/ready");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ready", database: { ok: true }, migrations: { pending: 0 } });
  });

  it("echoes a caller's x-request-id and puts it in error bodies", async () => {
    const response = await call("GET", "/admin/system", { headers: { "x-request-id": "edge-7f3a9b21" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("edge-7f3a9b21");
    expect(response.body).toMatchObject({ statusCode: 401, requestId: "edge-7f3a9b21" });
  });
});

describe("admin system view", () => {
  it("is for platform admins only, and carries what /health no longer shows", async () => {
    const member = await signUp("Ops Member");
    const adminUser = await signUp("Ops Admin");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, adminUser.userId));
    // The one signed up first may have been made admin by the first-user rule; make the member a member.
    await db.update(users).set({ role: "user" }).where(eq(users.id, member.userId));

    expect((await call("GET", "/admin/system", { cookie: member.cookie })).status).toBe(403);

    resetHeartbeatThrottle();
    expect(await recordHeartbeat("worker-host:123")).toBe(true);
    expect(await recordHeartbeat("worker-host:123")).toBe(false); // at most once a minute
    expect(await readHeartbeat()).toMatchObject({ instance: "worker-host:123", healthy: true });

    const response = await call("GET", "/admin/system", { cookie: adminUser.cookie });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ready: true,
      database: { ok: true },
      migrations: { pending: [] },
      ai: { provider: expect.any(String) },
      storage: expect.any(String),
      worker: { mode: expect.stringMatching(/in-process|external/), heartbeat: { instance: "worker-host:123", healthy: true } },
      observability: { errorReporting: false },
    });
  });
});

describe("access log", () => {
  it("writes one line per request: method, route pattern, status, duration, user, request id — no ids or queries", async () => {
    const { cookie, userId } = await signUp("Log Reader");
    const missing = await call("GET", "/accounts/0199a000-0000-7000-8000-00000000abcd?secret=1", { cookie });
    expect(missing.status).toBe(404);
    const line = logLines.find((entry) => entry.requestId === missing.headers.get("x-request-id"));
    expect(line).toMatchObject({ level: "info", message: "request", method: "GET", route: "/api/accounts/:id", status: 404, userId });
    expect(typeof line?.ms).toBe("number");
    expect(JSON.stringify(logLines)).not.toContain("secret=1");
    // Successful health probes are not logged.
    await call("GET", "/health");
    expect(logLines.some((entry) => entry.route === "/api/health")).toBe(false);
  });
});

describe("CSRF origin check", () => {
  it("refuses a cookie-authenticated write from another origin and allows the app's own", async () => {
    const { cookie } = await signUp("Origin Tester");
    const account = { name: "Origin Cash", kind: "cash", currency: "BDT", openingDate: "2026-01-01" };

    const foreign = await call("POST", "/accounts", { cookie, body: account, headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ statusCode: 403, error: "origin_rejected", requestId: foreign.headers.get("x-request-id") });

    const viaReferer = await call("POST", "/accounts", { cookie, body: account, headers: { referer: "https://evil.example/form" } });
    expect(viaReferer.status).toBe(403);

    expect((await call("POST", "/accounts", { cookie, body: account, headers: { origin: appOrigin } })).status).toBe(201);
    // Server Actions: the web server forwards the cookie and names no origin.
    expect((await call("POST", "/accounts", { cookie, body: { ...account, name: "Server Cash" } })).status).toBe(201);
    // Reads are never blocked.
    expect((await call("GET", "/accounts", { cookie, headers: { origin: "https://evil.example" } })).status).toBe(200);
  });

  it("leaves Better Auth to its own origin checks", async () => {
    const response = await call("POST", "/auth/sign-in/email", {
      body: { email: "nobody@example.test", password: "wrong password here" },
      headers: { origin: appOrigin, cookie: "ew.session_token=stale" },
    });
    expect(response.body?.error).not.toBe("origin_rejected");
  });
});

describe("browser error reports", () => {
  it("accepts a small report without a session and refuses oversized ones", async () => {
    const accepted = await call("POST", "/system/client-errors", {
      body: {
        message: "Cannot read properties of undefined (reading 'map')",
        digest: "123",
        url: "https://books.example.com/reports?token=x",
        source: "boundary",
      },
      headers: { origin: appOrigin },
    });
    expect(accepted.status).toBe(204);

    const invalid = await call("POST", "/system/client-errors", { body: { message: "" } });
    expect(invalid.status).toBe(400);

    const oversized = await call("POST", "/system/client-errors", { raw: JSON.stringify({ message: "x", stack: "y".repeat(40_000) }) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: "invalid_body" });
  });
});
