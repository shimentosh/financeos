import {
  importCommitInput,
  importDeleteQuery,
  importListQuery,
  importMappingRequest,
  importRowsQuery,
  importUploadFields,
} from "@expensewise/core/contracts/integrations-extra";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import type { z } from "zod";
import type { WorkspaceContext } from "../../../common/context.js";
import { badRequest } from "../../../common/errors.js";
import { Ctx, WorkspaceScoped } from "../../../common/guards.js";
import { zod } from "../../../common/zod.js";
import { uploadInterceptor } from "../../storage/files.controller.js";
import { ImportsService } from "./imports.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });

@Controller("imports")
@WorkspaceScoped()
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  /** multipart/form-data: `file` (CSV or .xlsx), optional `sheet`. */
  @Post()
  @UseInterceptors(uploadInterceptor())
  upload(
    @Ctx() ctx: WorkspaceContext,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(zod(importUploadFields)) fields: z.output<typeof importUploadFields>,
  ) {
    if (!file) throw badRequest("Attach the statement in the `file` field");
    return this.imports.upload(ctx, { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype }, fields);
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(importListQuery)) query: z.output<typeof importListQuery>) {
    return this.imports.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.imports.get(ctx, id);
  }

  @Put(":id/mapping")
  mapping(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(importMappingRequest)) input: z.output<typeof importMappingRequest>) {
    return this.imports.setMapping(ctx, id, input);
  }

  @Get(":id/rows")
  rows(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(importRowsQuery)) query: z.output<typeof importRowsQuery>) {
    return this.imports.rows(ctx, id, query);
  }

  @Post(":id/commit")
  @HttpCode(200)
  commit(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(importCommitInput)) input: z.output<typeof importCommitInput>) {
    return this.imports.commit(ctx, id, input);
  }

  @Delete(":id")
  cancel(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(importDeleteQuery)) query: z.output<typeof importDeleteQuery>) {
    return this.imports.cancel(ctx, id, { revert: query.revert });
  }
}
