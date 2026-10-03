import { inboxActionInput, textCaptureInput } from "@financeos/core";
import {
  aiUsageQuery,
  type CaptureConfirmInput,
  type CaptureListQuery,
  type CaptureUploadKind,
  captureConfirmInput,
  captureListQuery,
  captureRetryInput,
  captureUploadFields,
  type InboxQuery,
  type InboxTrackInput,
  inboxDuplicateInput,
  inboxQuery,
  inboxTrackInput,
  type UncategorizedApplyInput,
  type UncategorizedQuery,
  uncategorizedApplyInput,
  uncategorizedQuery,
} from "@financeos/core/contracts/ai-extra";
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { badRequest } from "../../common/errors.js";
import { Ctx, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { uploadInterceptor } from "../storage/files.controller.js";
import { RateLimit } from "../system/rate-limit.js";
import { CaptureService } from "./capture/capture.service.js";
import { AiGateway } from "./gateway/ai.gateway.js";
import { AiInboxService } from "./inbox/ai-inbox.service.js";
import { AiUsageService } from "./usage.service.js";

const id = new ParseUUIDPipe();

@Controller("captures")
@WorkspaceScoped()
export class CapturesController {
  constructor(@Inject(CaptureService) private readonly captures: CaptureService) {}

  /** Multipart: `file` (image or PDF, ≤ 12 MB) and optional `kind` (screenshot | receipt | pdf). */
  @Post()
  @RateLimit("capture", 30, 60)
  @UseInterceptors(uploadInterceptor())
  upload(
    @Ctx() ctx: WorkspaceContext,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(zod(captureUploadFields)) fields: z.output<typeof captureUploadFields>,
    @Query(zod(captureUploadFields)) query: z.output<typeof captureUploadFields>,
  ) {
    if (!file) throw badRequest("Attach a screenshot, photo or PDF in the `file` field");
    const kind: CaptureUploadKind | undefined = fields.kind ?? query.kind;
    return this.captures.createFromUpload(
      ctx,
      {
        buffer: file.buffer,
        filename: file.originalname,
        contentType: file.mimetype,
      },
      kind,
    );
  }

  /** A typed note, or a voice note already transcribed by the browser. */
  @Post("text")
  @RateLimit("capture", 30, 60)
  text(@Ctx() ctx: WorkspaceContext, @Body(zod(textCaptureInput)) input: z.output<typeof textCaptureInput>) {
    return this.captures.createFromText(ctx, input);
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(captureListQuery)) query: CaptureListQuery) {
    return this.captures.list(ctx, query);
  }

  @Get(":id")
  get(@Ctx() ctx: WorkspaceContext, @Param("id", id) captureId: string) {
    return this.captures.view(ctx, captureId);
  }

  @Post(":id/confirm")
  @HttpCode(200)
  confirm(@Ctx() ctx: WorkspaceContext, @Param("id", id) captureId: string, @Body(zod(captureConfirmInput)) input: CaptureConfirmInput) {
    return this.captures.confirm(ctx, captureId, input);
  }

  @Post(":id/discard")
  @HttpCode(200)
  discard(@Ctx() ctx: WorkspaceContext, @Param("id", id) captureId: string) {
    return this.captures.discard(ctx, captureId);
  }

  @Post(":id/retry")
  @HttpCode(200)
  @RateLimit("capture", 30, 60)
  retry(@Ctx() ctx: WorkspaceContext, @Param("id", id) captureId: string, @Body(zod(captureRetryInput)) input: z.input<typeof captureRetryInput>) {
    return this.captures.retry(ctx, captureId, input);
  }
}

@Controller("inbox")
@WorkspaceScoped()
export class InboxController {
  constructor(@Inject(AiInboxService) private readonly inbox: AiInboxService) {}

  @Get()
  overview(@Ctx() ctx: WorkspaceContext, @Query(zod(inboxQuery)) query: InboxQuery) {
    return this.inbox.overview(ctx, query);
  }

  @Get("uncategorized")
  uncategorized(@Ctx() ctx: WorkspaceContext, @Query(zod(uncategorizedQuery)) query: UncategorizedQuery) {
    return this.inbox.uncategorized(ctx, query);
  }

  @Post("uncategorized/apply")
  @HttpCode(200)
  apply(@Ctx() ctx: WorkspaceContext, @Body(zod(uncategorizedApplyInput)) input: UncategorizedApplyInput) {
    return this.inbox.applyCategories(ctx, input);
  }

  @Post(":id/action")
  @HttpCode(200)
  act(@Ctx() ctx: WorkspaceContext, @Param("id", id) itemId: string, @Body(zod(inboxActionInput)) input: z.input<typeof inboxActionInput>) {
    return this.inbox.act(ctx, itemId, input);
  }

  @Post(":id/duplicate")
  @HttpCode(200)
  duplicate(@Ctx() ctx: WorkspaceContext, @Param("id", id) itemId: string, @Body(zod(inboxDuplicateInput)) input: z.input<typeof inboxDuplicateInput>) {
    return this.inbox.resolveDuplicate(ctx, itemId, input);
  }

  @Post(":id/track")
  @HttpCode(200)
  track(@Ctx() ctx: WorkspaceContext, @Param("id", id) itemId: string, @Body(zod(inboxTrackInput)) input: InboxTrackInput) {
    return this.inbox.track(ctx, itemId, input);
  }
}

@Controller("ai")
@WorkspaceScoped()
export class AiController {
  constructor(
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AiUsageService) private readonly usage: AiUsageService,
  ) {}

  @Get("status")
  status(@Ctx() ctx: WorkspaceContext) {
    return this.gateway.status(ctx);
  }

  @Get("usage")
  report(@Ctx() ctx: WorkspaceContext, @Query(zod(aiUsageQuery)) query: z.output<typeof aiUsageQuery>) {
    return this.usage.report(ctx, query.month);
  }
}
