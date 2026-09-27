import type { NestExpressApplication } from "@nestjs/platform-express";
import { toNodeHandler } from "better-auth/node";
import express, { type NextFunction, type Request, type Response } from "express";
import { auth } from "../auth/auth.js";
import { CLIENT_ERRORS_BODY_LIMIT, CLIENT_ERRORS_PATH } from "../modules/system/client-errors.controller.js";
import type { AppRequest } from "./context.js";
import type { AppLogger } from "./logger.js";
import { originCheck } from "./origin-check.js";
import { requestContext, requestIdOf, restoreRequestContext } from "./request-context.js";
import { parseTrustProxy } from "./trust-proxy.js";

export type HttpOptions = {
  appUrl: string;
  trustProxy: string;
  /** Writes one access line per request (LOG_FORMAT=json). */
  logger?: AppLogger | null;
};

/**
 * The Express stack in front of Nest's routes, in order. main.ts uses it, and
 * so do the HTTP integration tests, so they exercise exactly this.
 */
export function configureHttpServer(app: NestExpressApplication, options: HttpOptions) {
  const server = app.getHttpAdapter().getInstance();
  // Decides request.ip (rate limits, audit): see TRUST_PROXY in .env.example.
  server.set("trust proxy", parseTrustProxy(options.trustProxy));
  server.disable("x-powered-by");

  // First: a request id for every request (echoed as x-request-id, in logs and
  // error bodies) and, with LOG_FORMAT=json, one access line per request.
  const logger = options.logger;
  server.use(requestContext({ accessLog: logger?.format === "json" ? (fields) => logger.record("log", "request", fields) : null }));
  // Cookie-authenticated writes must come from APP_URL (CSRF). Better Auth,
  // webhooks, payment callbacks and the key-authenticated APIs are exempt.
  server.use(originCheck(options.appUrl));

  // Nest's body parser is off: Better Auth must read the raw request itself,
  // and webhook routes need the exact bytes to verify signatures.
  server.all("/api/auth/{*path}", toNodeHandler(auth));

  // Browser error reports are small; a bigger body is refused before parsing.
  const clientErrorsJson = express.json({ limit: CLIENT_ERRORS_BODY_LIMIT });
  server.use(CLIENT_ERRORS_PATH, (request: Request, response: Response, next: NextFunction) =>
    clientErrorsJson(request, response, (error?: unknown) => {
      if (!error) return next();
      const status = (error as { status?: number }).status ?? 400;
      const requestId = requestIdOf(request);
      response
        .status(status)
        .json({ statusCode: status, error: "invalid_body", message: "Report too large or malformed", ...(requestId ? { requestId } : {}) });
    }),
  );

  const keepRaw = (request: AppRequest, _response: unknown, buffer: Buffer) => {
    request.rawBody = buffer;
  };
  server.use(express.json({ limit: "2mb", verify: keepRaw as never }));
  server.use(express.urlencoded({ extended: false, limit: "2mb" }));
  // Body parsers finish outside the request's async context; re-enter it.
  server.use(restoreRequestContext);

  app.setGlobalPrefix("api", { exclude: [] });
}
