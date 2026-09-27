import { Body, Controller, HttpCode, Logger, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type { AppRequest } from "../../common/context.js";
import { reportError, stripQuery } from "../../common/error-reporter.js";
import { Public } from "../../common/guards.js";
import { requestIdOf } from "../../common/request-context.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "./rate-limit.js";

/** The route main.ts gives its own small body limit. */
export const CLIENT_ERRORS_PATH = "/api/system/client-errors";
export const CLIENT_ERRORS_BODY_LIMIT = "16kb";

const clientError = z.object({
  message: z.string().trim().min(1).max(1000),
  name: z.string().trim().max(120).optional(),
  stack: z.string().max(8000).optional(),
  digest: z.string().max(200).optional(),
  /** The page, without its query string (tokens travel there). */
  url: z.string().max(2000).optional(),
  /** Which boundary caught it. */
  source: z.enum(["boundary", "global"]).optional(),
});
type ClientError = z.output<typeof clientError>;

/**
 * POST /api/system/client-errors — errors the browser's error boundaries
 * caught, forwarded to error reporting. Public (the root boundary may render
 * for signed-out visitors), rate limited per IP, body capped at 16 KB.
 */
@Controller("system")
export class ClientErrorsController {
  private readonly logger = new Logger("ClientErrors");

  @Post("client-errors")
  @Public()
  @HttpCode(204)
  @RateLimit("client-errors", 20, 60)
  report(@Body(zod(clientError)) body: ClientError, @Req() request: AppRequest) {
    const page = stripQuery(body.url);
    this.logger.warn(`Browser error${page ? ` on ${page}` : ""}: ${body.message}${body.digest ? ` (digest ${body.digest})` : ""}`);
    const error = new Error(body.message);
    error.name = body.name || "ClientError";
    // Chrome's stack starts with "Name: message"; Firefox's and Safari's go straight to frames.
    const frames = body.stack?.split("\n") ?? [];
    if (frames[0]?.includes(body.message)) frames.shift();
    error.stack = `${error.name}: ${body.message}\n${frames.join("\n")}`;
    // Fire and forget: the browser does not wait for the report.
    void reportError(error, {
      mechanism: "browser",
      requestId: requestIdOf(request),
      request: { method: "GET", url: page, headers: { "user-agent": request.headers["user-agent"] } },
      tags: { source: "browser", boundary: body.source, digest: body.digest },
    });
  }
}
