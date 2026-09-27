import { Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { memoryStorage } from "multer";
import type { WorkspaceContext } from "../../common/context.js";
import { badRequest } from "../../common/errors.js";
import { Ctx, WorkspaceScoped } from "../../common/guards.js";
import { ALLOWED_TYPES, type FileKind, MAX_UPLOAD_BYTES, StorageService } from "./storage.service.js";

const KINDS: FileKind[] = ["screenshot", "receipt", "statement", "import", "attachment", "report", "other"];

/** Shared multipart settings: in memory, size-capped, one file. */
export const uploadInterceptor = () => FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

@Controller("files")
@WorkspaceScoped()
export class FilesController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Post()
  @UseInterceptors(uploadInterceptor())
  async upload(@Ctx() ctx: WorkspaceContext, @UploadedFile() file: Express.Multer.File | undefined, @Query("kind") kind?: string) {
    if (!file) throw badRequest("Attach a file in the `file` field");
    const fileKind = KINDS.includes(kind as FileKind) ? (kind as FileKind) : "attachment";
    const allowed = [...(ALLOWED_TYPES.image ?? []), ...(ALLOWED_TYPES.pdf ?? []), ...(fileKind === "import" ? (ALLOWED_TYPES.sheet ?? []) : [])];
    const saved = await this.storage.save(ctx, { buffer: file.buffer, filename: file.originalname, contentType: file.mimetype }, fileKind, allowed);
    return { id: saved.id, filename: saved.filename, contentType: saved.contentType, size: saved.size, duplicateOf: saved.duplicateOf };
  }

  /** A file's name, type and size, for showing an attachment without downloading it. */
  @Get(":id/info")
  async info(@Ctx() ctx: WorkspaceContext, @Param("id", ParseUUIDPipe) id: string) {
    const file = await this.storage.meta(ctx, id);
    return { id: file.id, filename: file.filename, contentType: file.contentType, size: file.size, createdAt: file.createdAt };
  }

  /** Streams a file after checking it belongs to the caller's workspace. */
  @Get(":id")
  async download(@Ctx() ctx: WorkspaceContext, @Param("id", ParseUUIDPipe) id: string, @Res() response: Response, @Query("download") download?: string) {
    const { file, body } = await this.storage.read(ctx, id);
    const inline = !download && (file.contentType.startsWith("image/") || file.contentType === "application/pdf");
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Length", String(body.length));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    response.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.filename)}"`);
    response.end(body);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.storage.remove(ctx, id);
  }
}
