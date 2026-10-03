import { type StorageConfigInput, type StorageConfigTestInput, storageConfigInput, storageConfigTestInput } from "@financeos/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Query, UseGuards } from "@nestjs/common";
import type { SessionUser } from "../../common/context.js";
import { AdminGuard, CurrentUser } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { StorageAdminService } from "./storage-admin.service.js";

/** /api/admin/storage — where the installation keeps files (Cloudflare R2, S3…). Platform administrators only. */
@Controller("admin/storage")
@UseGuards(AdminGuard)
export class StorageAdminController {
  constructor(@Inject(StorageAdminService) private readonly storage: StorageAdminService) {}

  @Get()
  view() {
    return this.storage.view();
  }

  /** Tested before it is saved; a bucket that fails the test is not saved. */
  @Put()
  update(@Body(zod(storageConfigInput)) body: StorageConfigInput, @CurrentUser() user: SessionUser) {
    return this.storage.update(body, user.id);
  }

  @Post("test")
  @HttpCode(200)
  @RateLimit("storage-config-test", 12, 60)
  test(@Body(zod(storageConfigTestInput)) body: StorageConfigTestInput) {
    return this.storage.test(body);
  }

  @Post("copy")
  @HttpCode(200)
  copy(@CurrentUser() user: SessionUser) {
    return this.storage.copyToActive(user.id);
  }

  @Delete()
  reset(@CurrentUser() user: SessionUser, @Query("force") force?: string) {
    return this.storage.reset(user.id, force === "true" || force === "1");
  }
}
