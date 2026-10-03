import { connectInput } from "@financeos/core";
import { connectionPatch, connectionRecordsQuery, syncRunQuery, webhookTestInput } from "@financeos/core/contracts/integrations-extra";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { z } from "zod";
import type { AppRequest, WorkspaceContext } from "../../common/context.js";
import { Ctx, Public, RequireManage, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { ConnectionsService } from "./connections.service.js";
import { SyncService } from "./sync.service.js";
import { WebhooksService } from "./webhooks.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });

@Controller("integrations")
@WorkspaceScoped()
export class IntegrationsController {
  constructor(
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}

  /** Every provider: connectable ones with their form fields, the file importer, and "coming soon". */
  @Get("catalog")
  catalog() {
    return this.connections.catalog();
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.connections.list(ctx);
  }

  @Post()
  @RequireManage()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(connectInput)) input: z.output<typeof connectInput>) {
    return this.connections.create(ctx, input);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.connections.detail(ctx, id);
  }

  @Patch(":id")
  @RequireManage()
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(connectionPatch)) input: z.output<typeof connectionPatch>) {
    return this.connections.update(ctx, id, input);
  }

  @Delete(":id")
  @RequireManage()
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.connections.remove(ctx, id);
  }

  @Post(":id/test")
  @RequireManage()
  @HttpCode(200)
  test(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.connections.test(ctx, id);
  }

  @Post(":id/sync")
  @RequireManage()
  @HttpCode(202)
  syncNow(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.sync.start(ctx, id, "manual");
  }

  @Post(":id/disconnect")
  @RequireManage()
  @HttpCode(200)
  disconnect(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.connections.disconnect(ctx, id);
  }

  @Post(":id/webhook/rotate")
  @RequireManage()
  @HttpCode(200)
  rotate(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.connections.rotateWebhook(ctx, id);
  }

  @Post(":id/webhook/test")
  @RequireManage()
  @HttpCode(200)
  testWebhook(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(webhookTestInput)) input: z.output<typeof webhookTestInput>) {
    return this.connections.sendTestWebhook(ctx, id, input.eventType);
  }

  @Get(":id/webhook-events")
  webhookEvents(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.connections.webhookEvents(ctx, id);
  }

  @Get(":id/records")
  records(
    @Ctx() ctx: WorkspaceContext,
    @Param("id", uuidParam) id: string,
    @Query(zod(connectionRecordsQuery)) query: z.output<typeof connectionRecordsQuery>,
  ) {
    return this.connections.records(ctx, id, query);
  }
}

@Controller("sync-runs")
@WorkspaceScoped()
export class SyncRunsController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(syncRunQuery)) query: z.output<typeof syncRunQuery>) {
    return this.sync.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.sync.get(ctx, id);
  }

  @Post(":id/retry")
  @RequireManage()
  @HttpCode(202)
  retry(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.sync.retry(ctx, id);
  }
}

/** Inbound provider webhooks. No session: the connection's signature is the authentication. */
@Controller("webhooks")
@Public()
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Post(":publicId")
  @HttpCode(200)
  receive(@Param("publicId") publicId: string, @Req() request: AppRequest) {
    return this.webhooks.receive(publicId, request.headers, request.rawBody);
  }
}
