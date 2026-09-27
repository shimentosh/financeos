import { Logger, type LogLevel } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLogger, formatLogLine, logLevelsFor, splitParams } from "../../src/common/logger.js";
import { acceptRequestId, requestStorage, routeOf } from "../../src/common/request-context.js";

function capture(levels: LogLevel[] = ["fatal", "error", "warn", "log"]) {
  const lines: Array<{ line: Record<string, unknown>; level: LogLevel }> = [];
  const logger = new AppLogger({ format: "json", levels, write: (line, level) => lines.push({ line: JSON.parse(line), level }) });
  return { logger, lines };
}

afterEach(() => {
  Logger.overrideLogger(false);
});

describe("JSON logger", () => {
  it("splits Nest's variadic arguments into context, stack and extras", () => {
    expect(splitParams("log", ["Scheduler"])).toEqual({ context: "Scheduler", stack: undefined, extra: [] });
    expect(splitParams("error", [undefined, "Exceptions"])).toEqual({ context: "Exceptions", stack: undefined, extra: [] });
    expect(splitParams("error", ["Error: x\n    at a (b.js:1:2)", "Exceptions"])).toEqual({
      context: "Exceptions",
      stack: "Error: x\n    at a (b.js:1:2)",
      extra: [],
    });
    // A lone stack is a stack, not a context.
    expect(splitParams("error", ["Error: x\n    at a (b.js:1:2)"]).stack).toContain("at a");
    expect(splitParams("warn", [{ id: 1 }, "Jobs"])).toEqual({ context: "Jobs", stack: undefined, extra: [{ id: 1 }] });
  });

  it("writes one object per line with level, time, context, message and the request id", () => {
    const now = new Date("2026-09-26T10:00:00.000Z");
    expect(formatLogLine("log", "Worker started", ["Worker"], now)).toEqual({
      level: "info",
      time: "2026-09-26T10:00:00.000Z",
      context: "Worker",
      message: "Worker started",
    });
    const line = requestStorage.run({ requestId: "req-00000001" }, () =>
      formatLogLine("error", "boom", ["Error: boom\n    at x (y.js:1:1)", "Exceptions"], now),
    );
    expect(line).toEqual({
      level: "error",
      time: "2026-09-26T10:00:00.000Z",
      context: "Exceptions",
      message: "boom",
      stack: "Error: boom\n    at x (y.js:1:1)",
      requestId: "req-00000001",
    });
    const fromError = formatLogLine("error", new Error("bad"), ["Ctx"], now);
    expect(fromError).toMatchObject({ message: "bad", context: "Ctx" });
    expect(String(fromError.stack)).toContain("Error: bad");
  });

  it("serves as Nest's logger: Logger instances write JSON lines through it, filtered by level", () => {
    const { logger, lines } = capture();
    Logger.overrideLogger(logger);
    const scheduler = new Logger("Scheduler");
    scheduler.log("5 scheduled tasks active");
    scheduler.debug("not shown in production");
    scheduler.error("Task failed");
    new Logger("Exceptions").error("Unhandled", "Error: Unhandled\n    at z (q.js:3:4)");
    expect(lines.map((entry) => entry.line.level)).toEqual(["info", "error", "error"]);
    expect(lines[0]?.line).toMatchObject({ context: "Scheduler", message: "5 scheduled tasks active" });
    expect(lines[1]?.line).toMatchObject({ context: "Scheduler", message: "Task failed" });
    expect(lines[1]?.line.stack).toBeUndefined();
    expect(lines[2]?.line).toMatchObject({ context: "Exceptions", stack: "Error: Unhandled\n    at z (q.js:3:4)" });
    expect(lines[1]?.level).toBe("error");
  });

  it("writes access records only in JSON mode", () => {
    const { logger, lines } = capture();
    logger.record("log", "request", { requestId: "r", method: "GET", route: "/api/x", status: 200, ms: 1.5 });
    expect(lines[0]?.line).toMatchObject({ level: "info", message: "request", method: "GET", route: "/api/x", status: 200, ms: 1.5 });
    const write = vi.fn();
    new AppLogger({ format: "text", levels: ["log"], write }).record("log", "request", {});
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps Nest's text format when LOG_FORMAT=text", () => {
    const write = vi.fn();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      new AppLogger({ format: "text", levels: ["log"], write }).log("hello", "Ctx");
      expect(write).not.toHaveBeenCalled();
      expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toMatch(/\[Ctx\].*hello/);
    } finally {
      stdout.mockRestore();
    }
  });

  it("logs debug outside production only", () => {
    expect(logLevelsFor("production")).not.toContain("debug");
    expect(logLevelsFor("development")).toContain("debug");
  });
});

describe("request ids and routes", () => {
  it("reuses a sane incoming x-request-id and replaces anything else", () => {
    expect(acceptRequestId("lb-4f2a9c1e-77")).toBe("lb-4f2a9c1e-77");
    expect(acceptRequestId(["abcdefgh1", "second"])).toBe("abcdefgh1");
    for (const bad of [undefined, "", "short", "has spaces in it", "x".repeat(200), "<script>alert(1)</script>"]) {
      expect(acceptRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("logs route patterns, never ids, tokens or query strings", () => {
    expect(routeOf({ originalUrl: "/api/transactions/abc", baseUrl: "", route: { path: "/api/transactions/:id" } })).toBe("/api/transactions/:id");
    expect(routeOf({ originalUrl: "/api/transactions/0199a000-0000-7000-8000-000000000001?x=1", baseUrl: "" })).toBe("/api/transactions/:id");
    expect(routeOf({ originalUrl: "/api/auth/reset-password/Xk3Yq9Zr8Wt7Vu6Ts5Rp4?callbackURL=/", baseUrl: "" })).toBe("/api/auth/reset-password/:token");
    expect(routeOf({ originalUrl: "/api/reports/2026/weekly", baseUrl: "" })).toBe("/api/reports/:n/weekly");
  });
});
