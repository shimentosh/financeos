import { Controller, Delete, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { type AppRequest, contextFor } from "../../common/context.js";
import { DomainError } from "../../common/errors.js";
import { Public } from "../../common/guards.js";
import { env } from "../../env.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { API_KEY_RATE_LIMIT } from "../integrations/public-api/api-key.guard.js";
import { ApiKeysService } from "../integrations/public-api/api-keys.service.js";
import { loadWorkspace } from "../integrations/store.js";
import { hit } from "../system/rate-limit.js";
import { type JsonRpcResponse, McpService } from "./mcp.service.js";

const rpcError = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: null, error: { code, message } });

/**
 * /api/mcp — the MCP endpoint. Authenticated with a workspace API key
 * (`Authorization: Bearer ew_live_…`): read keys get the queries, keys with
 * the write scope also get the actions. The key decides the workspace; the
 * request can't choose another.
 */
@Controller("mcp")
@Public()
export class McpController {
  constructor(
    @Inject(ApiKeysService) private readonly keys: ApiKeysService,
    @Inject(McpService) private readonly mcp: McpService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  @Post()
  @HttpCode(200)
  async post(@Req() request: AppRequest, @Res() response: Response) {
    // Browsers send Origin; a page on another site must not drive the endpoint (DNS-rebinding guard).
    const origin = request.headers.origin;
    if (origin && origin !== new URL(env.APP_URL).origin) {
      response.status(403).json(rpcError(-32600, "Requests from other websites are not allowed"));
      return;
    }
    const header = request.headers.authorization;
    const token = typeof header === "string" ? header.match(/^Bearer\s+(\S+)\s*$/i)?.[1] : undefined;
    const key = token ? await this.keys.authenticate(token) : null;
    if (!key) {
      response
        .status(401)
        .setHeader("WWW-Authenticate", 'Bearer realm="financeos"')
        .json(rpcError(-32001, token ? "This API key is invalid, revoked or expired" : "Send a workspace API key as Authorization: Bearer ew_live_…"));
      return;
    }
    if (!(await hit(`api:${key.id}`, API_KEY_RATE_LIMIT, 60))) {
      response.status(429).json(rpcError(-32002, `Rate limit: ${API_KEY_RATE_LIMIT} requests a minute per key`));
      return;
    }
    // AI agents (MCP) come with the workspace owner's plan.
    try {
      await this.entitlements.assertApiAccess(key.workspaceId);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      response.status(error.status).json(rpcError(-32003, error.message));
      return;
    }
    const ctx = contextFor(await loadWorkspace(key.workspaceId), { userId: null, actorType: "api", apiKeyId: key.id, role: "member", ip: request.ip });
    const canWrite = key.scopes.includes("write");

    const body = request.body as unknown;
    if (Array.isArray(body)) {
      // Older clients may batch; answer every request in the batch, skip notifications.
      const replies = (await Promise.all(body.slice(0, 20).map((message) => this.mcp.handle(ctx, canWrite, message ?? {})))).filter(Boolean);
      if (replies.length) response.json(replies);
      else response.status(202).end();
      return;
    }
    if (!body || typeof body !== "object") {
      response.status(400).json(rpcError(-32700, "Parse error: send a JSON-RPC message as application/json"));
      return;
    }
    const reply = await this.mcp.handle(ctx, canWrite, body as Record<string, unknown>);
    if (reply) response.json(reply);
    else response.status(202).end();
  }

  /** No server-initiated stream: every answer comes back on its own POST. */
  @Get()
  stream(@Res() response: Response) {
    response.status(405).setHeader("Allow", "POST").json(rpcError(-32000, "This MCP server answers POST requests only"));
  }

  /** Stateless: there is no session to end. */
  @Delete()
  end(@Res() response: Response) {
    response.status(405).setHeader("Allow", "POST").end();
  }
}
