import { LedgerError } from "@expensewise/core";
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import type { AppRequest } from "./context.js";
import { reportError } from "./error-reporter.js";
import { DomainError } from "./errors.js";
import { requestIdOf } from "./request-context.js";

type PgError = { code?: string; constraint?: string; detail?: string; cause?: unknown };

function pgError(error: unknown): PgError | null {
  let current: unknown = error;
  // Drizzle wraps driver errors; the SQLSTATE lives on the cause.
  for (let depth = 0; depth < 3 && current; depth++) {
    const candidate = current as PgError;
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * Every error becomes JSON: `{ statusCode, error, message, requestId, ... }`.
 * Expected failures (DomainError, ledger rules, constraint violations) keep
 * their meaning; anything else is a bug: a 500 without details, logged with
 * its stack and sent to error reporting with the request id the caller sees.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exceptions");

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<AppRequest | undefined>();
    const requestId = requestIdOf(request);
    const send = (statusCode: number, error: string, message: string, extra?: Record<string, unknown>) => {
      if (statusCode >= 500) this.report(exception, request, requestId);
      if (response.headersSent) return;
      return response.status(statusCode).json({ statusCode, error, message, ...extra, ...(requestId ? { requestId } : {}) });
    };

    if (exception instanceof DomainError) {
      return send(exception.status, exception.code, exception.message, exception.details ? { issues: exception.details } : undefined);
    }
    if (exception instanceof LedgerError) {
      return send(422, exception.code, exception.message);
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      return send(exception.getStatus(), "http_error", Array.isArray(message) ? message.join(", ") : message);
    }

    const pg = pgError(exception);
    if (pg?.code === "23505") return send(409, "duplicate", "A record with these details already exists", { constraint: pg.constraint });
    if (pg?.code === "23503") return send(400, "invalid_reference", "A referenced record does not exist or is still in use", { constraint: pg.constraint });
    if (pg?.code === "23514") return send(422, "invariant_violated", "The change would break a ledger rule", { constraint: pg.constraint });
    if (pg?.code === "22P02") return send(400, "invalid_input", "Invalid identifier or value");

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return send(500, "internal_error", "Something went wrong. It has been logged.");
  }

  private report(exception: unknown, request: AppRequest | undefined, requestId: string | undefined) {
    void reportError(exception, {
      mechanism: "http",
      handled: false,
      requestId,
      userId: request?.user?.id ?? null,
      request: request ? { method: request.method, url: request.originalUrl, headers: request.headers as Record<string, unknown> } : undefined,
      tags: { workspaceId: request?.ctx?.workspaceId, service: process.env.EW_WORKER_PROCESS === "1" ? "worker" : "api" },
    });
  }
}
