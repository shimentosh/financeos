import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { currentRequestId } from "./request-context.js";

/**
 * A minimal Sentry-compatible error client (Sentry, GlitchTip, self-hosted
 * Sentry): events go to the DSN's envelope endpoint with `fetch`. It never
 * throws, never blocks a request for long, and does nothing without SENTRY_DSN.
 * Cookies, authorization headers and anything named like a secret are
 * removed before an event leaves the process.
 */

export type Dsn = { key: string; host: string; projectId: string; envelopeUrl: string; dsn: string };

/** `https://<key>@<host>[/<path>]/<projectId>` → where and how to send envelopes. */
export function parseDsn(value: string | undefined | null): Dsn | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const key = decodeURIComponent(url.username);
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!key || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return {
    key,
    host: url.host,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    dsn: `${url.protocol}//${key}@${url.host}${prefix}/${projectId}`,
  };
}

export function authHeader(dsn: Pick<Dsn, "key">): string {
  return `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=expensewise/0.1`;
}

const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization", "x-cron-secret", "x-api-key"]);
const SENSITIVE_KEY = /pass(word)?|secret|token|auth|cookie|session|api[-_]?key|signature|credential|private|encrypted/i;
const FILTERED = "[Filtered]";

export function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    out[lower] = SENSITIVE_HEADERS.has(lower) || SENSITIVE_KEY.test(lower) ? FILTERED : Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** Deep copy with secret-looking keys filtered, strings capped, depth limited. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 5) return "[Truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = SENSITIVE_KEY.test(key) ? FILTERED : scrub(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** A URL without its query string or fragment (tokens travel there). */
export function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.split(/[?#]/)[0];
}

type Frame = { function?: string; filename?: string; lineno?: number; colno?: number; in_app?: boolean };

/** Stack lines (V8's "at fn (file:1:2)", Firefox/Safari's "fn@file:1:2") → Sentry frames, oldest first. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(0, 60)) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line) ?? /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [, fn, filename, lineno, colno] = match;
    frames.push({
      function: fn || "?",
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: Boolean(filename) && !filename?.includes("node_modules") && !filename?.startsWith("node:"),
    });
  }
  return frames.reverse();
}

export type ReportContext = {
  level?: "fatal" | "error" | "warning";
  /** How the error was caught: "http", "unhandledRejection", "uncaughtException", "browser", … */
  mechanism?: string;
  handled?: boolean;
  request?: { method?: string; url?: string; headers?: Record<string, unknown> };
  userId?: string | null;
  requestId?: string;
  tags?: Record<string, string | undefined>;
  extra?: Record<string, unknown>;
};

export type ReporterOptions = {
  dsn?: string | null;
  environment?: string;
  release?: string;
  serverName?: string;
  /** Events per minute this process may send; the rest are dropped. */
  maxPerMinute?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

export function buildEvent(error: unknown, context: ReportContext, meta: { environment?: string; release?: string; serverName?: string }) {
  const err = asError(error);
  const requestId = context.requestId ?? currentRequestId();
  const tags = Object.fromEntries(Object.entries({ ...context.tags, requestId }).filter(([, value]) => typeof value === "string" && value !== ""));
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: context.level ?? "error",
    logger: "expensewise",
    server_name: meta.serverName,
    environment: meta.environment,
    release: meta.release,
    exception: {
      values: [
        {
          type: err.name || "Error",
          value: err.message.slice(0, 8000),
          stacktrace: { frames: parseStack(err.stack) },
          mechanism: { type: context.mechanism ?? "generic", handled: context.handled ?? true },
        },
      ],
    },
    ...(context.request
      ? {
          request: {
            method: context.request.method,
            url: stripQuery(context.request.url),
            headers: scrubHeaders(context.request.headers),
          },
        }
      : {}),
    ...(context.userId ? { user: { id: context.userId } } : {}),
    tags,
    ...(context.extra ? { extra: scrub(context.extra) } : {}),
  };
}

export function buildEnvelope(event: { event_id: string }, dsn: Dsn): string {
  const header = { event_id: event.event_id, sent_at: new Date().toISOString(), dsn: dsn.dsn };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

export class ErrorReporter {
  private readonly dsn: Dsn | null;
  private readonly send: typeof fetch;
  private windowStart = 0;
  private sentInWindow = 0;

  constructor(private readonly options: ReporterOptions = {}) {
    this.dsn = parseDsn(options.dsn);
    this.send = options.fetch ?? ((...args) => fetch(...args));
  }

  get enabled(): boolean {
    return this.dsn !== null;
  }

  /** Sends one event. Resolves to whether it was accepted; never rejects. */
  async capture(error: unknown, context: ReportContext = {}): Promise<boolean> {
    try {
      if (!this.dsn) return false;
      const now = Date.now();
      if (now - this.windowStart > 60_000) {
        this.windowStart = now;
        this.sentInWindow = 0;
      }
      if (this.sentInWindow >= (this.options.maxPerMinute ?? 60)) return false;
      this.sentInWindow += 1;
      const event = buildEvent(error, context, this.options);
      const response = await this.send(this.dsn.envelopeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": authHeader(this.dsn) },
        body: buildEnvelope(event, this.dsn),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function packageVersion(): string | undefined {
  try {
    // src/common or dist/common → apps/api/package.json
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The running build: APP_VERSION (set by the Docker build) or the package version. */
export const appVersion: string = process.env.APP_VERSION?.trim() || packageVersion() || "0.0.0";

let shared: ErrorReporter | null = null;

/** The process-wide reporter, configured from SENTRY_DSN on first use. */
export function errorReporter(): ErrorReporter {
  shared ??= new ErrorReporter({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    release: appVersion,
    serverName: hostname(),
  });
  return shared;
}

export function reportError(error: unknown, context: ReportContext = {}): Promise<boolean> {
  return errorReporter().capture(error, context);
}

type ProcessLogger = { error: (message: unknown, ...params: unknown[]) => void; fatal?: (message: unknown, ...params: unknown[]) => void };

/**
 * Last-resort handlers for the API and worker processes. An unhandled
 * rejection is logged and reported and the process keeps serving; an
 * uncaught exception leaves the process in an unknown state, so after
 * reporting it (at most three seconds) the process exits for the supervisor
 * to restart it.
 */
export function installProcessHandlers(logger: ProcessLogger, service: "api" | "worker") {
  process.on("unhandledRejection", (reason) => {
    const error = asError(reason);
    logger.error(`Unhandled rejection: ${error.message}`, error.stack, "Process");
    void reportError(error, { mechanism: "unhandledRejection", handled: false, tags: { service } });
  });
  process.on("uncaughtException", (error) => {
    (logger.fatal ?? logger.error).call(logger, `Uncaught exception: ${error.message}`, error.stack, "Process");
    setTimeout(() => process.exit(1), 3000).unref();
    void reportError(error, { level: "fatal", mechanism: "uncaughtException", handled: false, tags: { service } }).finally(() => process.exit(1));
  });
}
