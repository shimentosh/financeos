import { ConsoleLogger, type LoggerService, type LogLevel } from "@nestjs/common";
import { currentRequestId } from "./request-context.js";

export type LogFormat = "text" | "json";

/** Nest's level names as log collectors spell them. */
const JSON_LEVEL: Record<LogLevel, string> = { fatal: "fatal", error: "error", warn: "warn", log: "info", debug: "debug", verbose: "verbose" };

export function logLevelsFor(nodeEnv: string | undefined): LogLevel[] {
  return nodeEnv === "production" ? ["fatal", "error", "warn", "log"] : ["fatal", "error", "warn", "log", "debug"];
}

const STACK = /\n\s+at\s/;

/**
 * Nest's logger arguments are variadic: `(message, ...params, context)`, and
 * for errors `(message, stack?, context)`. Splits them apart.
 */
export function splitParams(level: LogLevel, params: unknown[]): { context?: string; stack?: string; extra: unknown[] } {
  const rest = [...params];
  const isError = level === "error" || level === "fatal";
  let context: string | undefined;
  const last = rest.at(-1);
  if (typeof last === "string" && !(isError && rest.length === 1 && STACK.test(last))) {
    context = last;
    rest.pop();
  }
  let stack: string | undefined;
  if (isError && rest.length > 0 && (typeof rest[0] === "string" || rest[0] === undefined)) {
    stack = rest.shift() as string | undefined;
  }
  return { context, stack, extra: rest.filter((value) => value !== undefined) };
}

function serialise(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** One log record as a plain object: level, time, context, message, requestId, then the rest. */
export function formatLogLine(level: LogLevel, message: unknown, params: unknown[], now = new Date()): Record<string, unknown> {
  const { context, stack, extra } = splitParams(level, params);
  const line: Record<string, unknown> = { level: JSON_LEVEL[level], time: now.toISOString() };
  if (context) line.context = context;
  if (message instanceof Error) {
    line.message = message.message;
    line.stack = stack ?? message.stack;
  } else {
    line.message = typeof message === "string" ? message : serialise(message);
    if (stack) line.stack = stack;
  }
  const requestId = currentRequestId();
  if (requestId) line.requestId = requestId;
  if (extra.length) line.extra = extra.map(serialise);
  return line;
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  } catch {
    return JSON.stringify({ level: value.level, time: value.time, context: value.context, message: String(value.message) });
  }
}

type Writer = (line: string, level: LogLevel) => void;

const defaultWriter: Writer = (line, level) => {
  (level === "error" || level === "fatal" ? process.stderr : process.stdout).write(`${line}\n`);
};

/**
 * The application logger. With LOG_FORMAT=json it writes one JSON object per
 * line (level, time, context, message, requestId, stack), which log
 * collectors index without parsing; otherwise Nest's usual coloured format.
 */
export class AppLogger implements LoggerService {
  private readonly text: ConsoleLogger;
  private levels: Set<LogLevel>;
  private readonly write: Writer;

  constructor(private readonly options: { format: LogFormat; levels: LogLevel[]; write?: Writer }) {
    this.levels = new Set(options.levels);
    this.text = new ConsoleLogger({ logLevels: options.levels });
    this.write = options.write ?? defaultWriter;
  }

  get format(): LogFormat {
    return this.options.format;
  }

  log(message: unknown, ...params: unknown[]) {
    this.emit("log", message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.emit("error", message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.emit("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.emit("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.emit("verbose", message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.emit("fatal", message, params);
  }

  setLogLevels(levels: LogLevel[]) {
    this.levels = new Set(levels);
    this.text.setLogLevels(levels);
  }

  /** A structured record outside Nest's API (access logs): JSON mode only. */
  record(level: LogLevel, message: string, fields: Record<string, unknown>) {
    if (this.options.format !== "json" || !this.levels.has(level)) return;
    this.write(safeStringify({ level: JSON_LEVEL[level], time: new Date().toISOString(), message, ...fields }), level);
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]) {
    if (this.options.format === "text") {
      this.text[level](message, ...params);
      return;
    }
    if (!this.levels.has(level)) return;
    this.write(safeStringify(formatLogLine(level, message, params)), level);
  }
}
