import { apiKeyInput } from "@expensewise/core";
import { publicExpenseInput, publicRevenueInput, publicTransactionInput, publicTransactionQuery } from "@expensewise/core/contracts/integrations-extra";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { z } from "zod";
import type { WorkspaceContext } from "../../../common/context.js";
import { Ctx, Public, RequireManage, WorkspaceScoped } from "../../../common/guards.js";
import { zod } from "../../../common/zod.js";
import { ApiKeyGuard } from "./api-key.guard.js";
import { ApiKeysService } from "./api-keys.service.js";
import { PublicApiService } from "./public-api.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });

/** Managing keys: owners and admins only. */
@Controller("api-keys")
@WorkspaceScoped()
@RequireManage()
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.keys.list(ctx);
  }

  /** Returns the full key once, as `key`. */
  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(apiKeyInput)) input: z.output<typeof apiKeyInput>) {
    return this.keys.create(ctx, input);
  }

  @Delete(":id")
  revoke(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.keys.revoke(ctx, id);
  }
}

/** The public API, authenticated by API key: `Authorization: Bearer ew_live_…`. */
@Controller("v1")
@Public()
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(@Inject(PublicApiService) private readonly api: PublicApiService) {}

  @Get("accounts")
  accounts(@Ctx() ctx: WorkspaceContext) {
    return this.api.listAccounts(ctx);
  }

  @Get("transactions")
  transactions(@Ctx() ctx: WorkspaceContext, @Query(zod(publicTransactionQuery)) query: z.output<typeof publicTransactionQuery>) {
    return this.api.listTransactions(ctx, query);
  }

  @Post("transactions")
  async createTransaction(
    @Ctx() ctx: WorkspaceContext,
    @Body(zod(publicTransactionInput)) input: z.output<typeof publicTransactionInput>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.api.createTransaction(ctx, input);
    response.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Post("revenue")
  async revenue(
    @Ctx() ctx: WorkspaceContext,
    @Body(zod(publicRevenueInput)) input: z.output<typeof publicRevenueInput>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.api.createRevenue(ctx, input);
    response.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Post("expenses")
  async expenses(
    @Ctx() ctx: WorkspaceContext,
    @Body(zod(publicExpenseInput)) input: z.output<typeof publicExpenseInput>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.api.createExpense(ctx, input);
    response.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Get("summary")
  @HttpCode(200)
  summary(@Ctx() ctx: WorkspaceContext) {
    return this.api.summary(ctx);
  }
}
