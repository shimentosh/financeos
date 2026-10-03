import { type AgentMemoryInput, agentMemoryInput, type CopilotActionsInput, type CopilotAskInput, copilotActionsInput, copilotAskInput } from "@financeos/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import type { WorkspaceContext } from "../../common/context.js";
import { AllowViewer, Ctx, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { AgentMemoryService } from "./agent-memory.service.js";
import { CopilotService } from "./copilot.service.js";

const id = new ParseUUIDPipe();

/**
 * Questions about the workspace (viewers may ask too) and the changes the
 * copilot suggests, which only take effect when a member confirms them.
 */
@Controller("copilot")
@WorkspaceScoped()
export class CopilotController {
  constructor(
    @Inject(CopilotService) private readonly copilot: CopilotService,
    @Inject(AgentMemoryService) private readonly memory: AgentMemoryService,
  ) {}

  @Get("threads")
  threads(@Ctx() ctx: WorkspaceContext) {
    return this.copilot.threads(ctx);
  }

  @Get("threads/:id")
  thread(@Ctx() ctx: WorkspaceContext, @Param("id", id) threadId: string) {
    return this.copilot.thread(ctx, threadId);
  }

  @Delete("threads/:id")
  @AllowViewer()
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", id) threadId: string) {
    return this.copilot.remove(ctx, threadId);
  }

  @Post("ask")
  @HttpCode(200)
  @AllowViewer()
  @RateLimit("copilot", 20, 60)
  ask(@Ctx() ctx: WorkspaceContext, @Body(zod(copilotAskInput)) body: CopilotAskInput) {
    return this.copilot.ask(ctx, body);
  }

  /** Confirms suggestions in an answer: the given ones, or every open one. */
  @Post("messages/:id/actions/apply")
  @HttpCode(200)
  @RateLimit("copilot-actions", 60, 60)
  apply(@Ctx() ctx: WorkspaceContext, @Param("id", id) messageId: string, @Body(zod(copilotActionsInput)) body: CopilotActionsInput) {
    return this.copilot.applyActions(ctx, messageId, body);
  }

  @Post("messages/:id/actions/discard")
  @HttpCode(200)
  discard(@Ctx() ctx: WorkspaceContext, @Param("id", id) messageId: string, @Body(zod(copilotActionsInput)) body: CopilotActionsInput) {
    return this.copilot.discardActions(ctx, messageId, body);
  }

  /** What the assistant remembers for this workspace. */
  @Get("memory")
  memoryList(@Ctx() ctx: WorkspaceContext) {
    return this.memory.list(ctx);
  }

  @Post("memory")
  memoryAdd(@Ctx() ctx: WorkspaceContext, @Body(zod(agentMemoryInput)) body: AgentMemoryInput) {
    return this.memory.add(ctx, body as { text: string });
  }

  @Delete("memory/:memoryId")
  memoryRemove(@Ctx() ctx: WorkspaceContext, @Param("memoryId", id) memoryId: string) {
    return this.memory.remove(ctx, memoryId);
  }
}
