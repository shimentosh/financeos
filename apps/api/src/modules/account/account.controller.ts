import { deleteAccountInput, onboardingInput, today } from "@financeos/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, StreamableFile, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import { authFeatures } from "../../auth/auth.js";
import type { AppRequest, SessionUser, WorkspaceContext } from "../../common/context.js";
import { AdminGuard, Ctx, CurrentUser, Public, RequireManage, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { AccountService } from "./account.service.js";
import { AccountExportService, fileSlug } from "./account-export.service.js";

function download(content: string, filename: string, type: string) {
  const buffer = Buffer.from(content, "utf8");
  return new StreamableFile(buffer, { type, length: buffer.length, disposition: `attachment; filename="${filename}"` });
}

/** What the sign-in and sign-up pages offer on this installation. */
@Controller("auth-options")
export class AuthOptionsController {
  @Get()
  @Public()
  options() {
    return authFeatures;
  }
}

/** /api/account: your own account — first-run setup, data export, deletion. */
@Controller("account")
export class AccountController {
  constructor(
    @Inject(AccountService) private readonly account: AccountService,
    @Inject(AccountExportService) private readonly exports: AccountExportService,
  ) {}

  /** Every record of the current workspace as JSON. Owners and admins only. */
  @Get("export")
  @WorkspaceScoped()
  @RequireManage()
  @RateLimit("account-export", 30, 3600)
  async exportWorkspace(@Ctx() ctx: WorkspaceContext, @CurrentUser() user: SessionUser) {
    const data = await this.exports.workspace(ctx, user);
    return download(JSON.stringify(data, null, 2), `financeos-${fileSlug(ctx.workspaceName)}-${today(ctx.timezone)}.json`, "application/json; charset=utf-8");
  }

  /** The current workspace's transactions as CSV. Owners and admins only. */
  @Get("export/transactions.csv")
  @WorkspaceScoped()
  @RequireManage()
  @RateLimit("account-export", 30, 3600)
  async exportTransactions(@Ctx() ctx: WorkspaceContext) {
    const csv = await this.exports.transactionsCsv(ctx);
    return download(csv, `financeos-${fileSlug(ctx.workspaceName)}-transactions-${today(ctx.timezone)}.csv`, "text/csv; charset=utf-8");
  }

  /** Your profile, preferences, memberships and sign-in history. */
  @Get("me/export")
  @RateLimit("account-export", 30, 3600)
  async exportMe(@CurrentUser() user: SessionUser) {
    const data = await this.exports.user(user);
    return download(JSON.stringify(data, null, 2), `financeos-profile-${new Date().toISOString().slice(0, 10)}.json`, "application/json; charset=utf-8");
  }

  /** Which of your workspaces would be deleted, and which block deleting the account. */
  @Get("deletion-check")
  deletionCheck(@CurrentUser() user: SessionUser) {
    return this.account.deletionCheck(user.id);
  }

  @Delete()
  @HttpCode(200)
  @RateLimit("account-delete", 5, 3600)
  remove(@CurrentUser() user: SessionUser, @Body(zod(deleteAccountInput)) input: z.output<typeof deleteAccountInput>, @Req() request: AppRequest) {
    return this.account.deleteAccount(user, input.confirmEmail, request.ip);
  }

  @Post("onboarding")
  @HttpCode(200)
  onboarding(@CurrentUser() user: SessionUser, @Body(zod(onboardingInput)) input: z.output<typeof onboardingInput>, @Req() request: AppRequest) {
    return this.account.onboard(user, input, request.ip);
  }
}

/**
 * /api/admin/users/:userId — platform admins delete a user through the same
 * path as self-service deletion. Better Auth's bare /admin/remove-user is
 * blocked, since it would leave that person's workspaces without an owner.
 */
@Controller("admin/users")
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  @Get(":userId/deletion-check")
  deletionCheck(@Param("userId") userId: string) {
    return this.account.deletionCheck(userId);
  }

  @Delete(":userId")
  @HttpCode(200)
  remove(@Param("userId") userId: string, @CurrentUser() admin: SessionUser, @Req() request: AppRequest) {
    return this.account.adminDelete(userId, admin, request.ip);
  }
}
