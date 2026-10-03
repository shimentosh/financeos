import { describe, expect, it, vi } from "vitest";
import {
  authHeader,
  buildEnvelope,
  buildEvent,
  ErrorReporter,
  parseDsn,
  parseStack,
  scrub,
  scrubHeaders,
  stripQuery,
} from "../../src/common/error-reporter.js";
import { requestStorage } from "../../src/common/request-context.js";

describe("DSN parsing", () => {
  it("turns a Sentry DSN into the envelope endpoint", () => {
    expect(parseDsn("https://abc123@o42.ingest.sentry.io/4507")).toEqual({
      key: "abc123",
      host: "o42.ingest.sentry.io",
      projectId: "4507",
      envelopeUrl: "https://o42.ingest.sentry.io/api/4507/envelope/",
      dsn: "https://abc123@o42.ingest.sentry.io/4507",
    });
  });

  it("keeps a path prefix and port (self-hosted Sentry, GlitchTip)", () => {
    const dsn = parseDsn("http://key@errors.internal:9000/sentry/7");
    expect(dsn?.envelopeUrl).toBe("http://errors.internal:9000/sentry/api/7/envelope/");
    expect(dsn?.dsn).toBe("http://key@errors.internal:9000/sentry/7");
  });

  it("ignores a legacy secret in the DSN and rejects malformed values", () => {
    expect(parseDsn("https://public:secret@sentry.example.com/12")?.key).toBe("public");
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "not a url",
      "https://sentry.example.com/12",
      "https://key@sentry.example.com/",
      "https://key@sentry.example.com/abc",
      "ftp://key@host/1",
    ]) {
      expect(parseDsn(bad), String(bad)).toBeNull();
    }
  });

  it("builds the X-Sentry-Auth header", () => {
    expect(authHeader({ key: "abc123" })).toBe("Sentry sentry_version=7, sentry_key=abc123, sentry_client=financeos/0.1");
  });
});

describe("scrubbing", () => {
  it("filters cookies, authorization and secret-looking headers", () => {
    expect(
      scrubHeaders({
        Cookie: "ew.session_token=abc",
        authorization: "Bearer ew_live_x",
        "x-cron-secret": "s3cret",
        "x-api-key": "k",
        "x-webhook-signature": "sig",
        "user-agent": "Mozilla/5.0",
        "x-forwarded-for": ["1.2.3.4", "10.0.0.1"],
        "x-empty": undefined,
      }),
    ).toEqual({
      cookie: "[Filtered]",
      authorization: "[Filtered]",
      "x-cron-secret": "[Filtered]",
      "x-api-key": "[Filtered]",
      "x-webhook-signature": "[Filtered]",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "1.2.3.4, 10.0.0.1",
    });
  });

  it("filters secret-named keys at any depth and caps long values", () => {
    const out = scrub({
      password: "p",
      nested: { apiKey: "k", accessToken: "t", note: "fine", list: [{ webhookSecret: "w" }] },
      long: "x".repeat(5000),
    }) as Record<string, unknown>;
    expect(out.password).toBe("[Filtered]");
    expect(out.nested).toEqual({ apiKey: "[Filtered]", accessToken: "[Filtered]", note: "fine", list: [{ webhookSecret: "[Filtered]" }] });
    expect((out.long as string).length).toBeLessThan(2100);
  });

  it("drops query strings, where reset tokens travel", () => {
    expect(stripQuery("/reset-password?token=abc#x")).toBe("/reset-password");
    expect(stripQuery("https://books.example.com/a/b?c=d")).toBe("https://books.example.com/a/b");
    expect(stripQuery(undefined)).toBeUndefined();
  });
});

describe("events", () => {
  it("parses V8 and Firefox stacks into frames, oldest first", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at TransactionsService.create (file:///app/apps/api/dist/modules/ledger/transactions.service.js:10:5)",
        "    at async /app/node_modules/@nestjs/core/router/router-execution-context.js:46:28",
        "    at node:internal/process/task_queues:95:5",
      ].join("\n"),
    );
    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({ function: "TransactionsService.create", lineno: 10, colno: 5, in_app: true });
    expect(frames[1]).toMatchObject({ in_app: false });
    expect(frames[0]).toMatchObject({ in_app: false });
    expect(parseStack("render@https://books.example.com/_next/static/chunks/app.js:1:2345")).toEqual([
      { function: "render", filename: "https://books.example.com/_next/static/chunks/app.js", lineno: 1, colno: 2345, in_app: true },
    ]);
  });

  it("describes the error, the scrubbed request, the user and the request id", () => {
    const error = new TypeError("Cannot read properties of undefined");
    const event = requestStorage.run({ requestId: "req-abcdef12" }, () =>
      buildEvent(
        error,
        {
          mechanism: "http",
          handled: false,
          userId: "user_1",
          request: { method: "POST", url: "/api/transactions?token=secret", headers: { cookie: "ew.session_token=abc", "user-agent": "UA" } },
          tags: { workspaceId: "ws_1", empty: undefined },
          extra: { password: "p", count: 3 },
        },
        { environment: "production", release: "1.2.3", serverName: "api-1" },
      ),
    );
    expect(event).toMatchObject({
      platform: "node",
      level: "error",
      environment: "production",
      release: "1.2.3",
      server_name: "api-1",
      user: { id: "user_1" },
      tags: { workspaceId: "ws_1", requestId: "req-abcdef12" },
      request: { method: "POST", url: "/api/transactions", headers: { cookie: "[Filtered]", "user-agent": "UA" } },
      extra: { password: "[Filtered]", count: 3 },
    });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.exception.values[0]).toMatchObject({
      type: "TypeError",
      value: "Cannot read properties of undefined",
      mechanism: { type: "http", handled: false },
    });
    expect(JSON.stringify(event)).not.toContain("ew.session_token=abc");
    expect(JSON.stringify(event)).not.toContain("token=secret");
  });

  it("wraps an envelope: header, item header, event", () => {
    const dsn = parseDsn("https://abc@sentry.example.com/1");
    if (!dsn) throw new Error("dsn");
    const event = buildEvent(new Error("x"), {}, {});
    const lines = buildEnvelope(event, dsn).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event_id: event.event_id, dsn: "https://abc@sentry.example.com/1" });
    expect(JSON.parse(lines[1] as string)).toEqual({ type: "event" });
    expect(JSON.parse(lines[2] as string).event_id).toBe(event.event_id);
  });
});

describe("ErrorReporter", () => {
  it("does nothing without a DSN", async () => {
    const fetch = vi.fn();
    const reporter = new ErrorReporter({ dsn: undefined, fetch: fetch as unknown as typeof globalThis.fetch });
    expect(reporter.enabled).toBe(false);
    expect(await reporter.capture(new Error("x"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the envelope with the auth header", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const reporter = new ErrorReporter({ dsn: "https://abc@sentry.example.com/9", fetch: fetch as unknown as typeof globalThis.fetch, release: "1.0.0" });
    expect(await reporter.capture(new Error("boom"), { request: { headers: { authorization: "Bearer x" } } })).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sentry.example.com/api/9/envelope/");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-sentry-auth"]).toBe("Sentry sentry_version=7, sentry_key=abc, sentry_client=financeos/0.1");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-sentry-envelope");
    expect(String(init.body)).toContain('"release":"1.0.0"');
    expect(String(init.body)).not.toContain("Bearer x");
  });

  it("never throws, whatever the transport does", async () => {
    const failing = new ErrorReporter({
      dsn: "https://abc@sentry.example.com/9",
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(failing.capture(new Error("x"))).resolves.toBe(false);
    const rejected = new ErrorReporter({
      dsn: "https://abc@sentry.example.com/9",
      fetch: (async () => new Response("", { status: 429 })) as unknown as typeof globalThis.fetch,
    });
    await expect(rejected.capture("a string reason")).resolves.toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(rejected.capture(circular)).resolves.toBe(false);
  });

  it("stops sending after the per-minute budget", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const reporter = new ErrorReporter({ dsn: "https://abc@sentry.example.com/9", fetch: fetch as unknown as typeof globalThis.fetch, maxPerMinute: 2 });
    for (let i = 0; i < 5; i++) await reporter.capture(new Error(`e${i}`));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
