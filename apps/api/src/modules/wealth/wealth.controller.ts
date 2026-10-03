import {
  assetInput,
  assetUpdate,
  investmentFlowInput,
  investmentInput,
  investmentUpdate,
  liabilityInput,
  liabilityUpdate,
  receivableInput,
  receivablePaymentInput,
  receivableUpdate,
  valuationInput,
} from "@financeos/core";
import {
  type AssetQuery,
  type AssetSellInput,
  assetQuery,
  assetSellInput,
  type InvestmentQuery,
  investmentQuery,
  type LiabilityPaymentRequest,
  type LiabilityQuery,
  liabilityPaymentRequest,
  liabilityQuery,
  netWorthHistoryQuery,
  type PayablesQuery,
  payablesQuery,
  type ReceivableQuery,
  receivableQuery,
  removeLinkedQuery,
} from "@financeos/core/contracts/wealth-extra";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { Ctx, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { AssetsService } from "./assets.service.js";
import { InvestmentsService } from "./investments.service.js";
import { LiabilitiesService } from "./liabilities.service.js";
import { NetWorthService } from "./net-worth.service.js";
import { ReceivablesService } from "./receivables.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });
type RemoveQuery = z.output<typeof removeLinkedQuery>;

@Controller("assets")
@WorkspaceScoped()
export class AssetsController {
  constructor(@Inject(AssetsService) private readonly service: AssetsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(assetQuery)) query: AssetQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(assetInput)) input: z.input<typeof assetInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(assetUpdate)) input: z.input<typeof assetUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(removeLinkedQuery)) query: RemoveQuery) {
    return this.service.remove(ctx, id, query);
  }

  @Get(":id/valuations")
  valuations(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.valuations(ctx, id);
  }

  @Post(":id/valuations")
  addValuation(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(valuationInput)) input: z.input<typeof valuationInput>) {
    return this.service.addValuation(ctx, id, input);
  }

  @Delete(":id/valuations/:valuationId")
  removeValuation(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Param("valuationId", uuidParam) valuationId: string) {
    return this.service.removeValuation(ctx, id, valuationId);
  }

  @Post(":id/sell")
  @HttpCode(200)
  sell(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(assetSellInput)) input: AssetSellInput) {
    return this.service.sell(ctx, id, input);
  }
}

@Controller("investments")
@WorkspaceScoped()
export class InvestmentsController {
  constructor(@Inject(InvestmentsService) private readonly service: InvestmentsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(investmentQuery)) query: InvestmentQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(investmentInput)) input: z.input<typeof investmentInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(investmentUpdate)) input: z.input<typeof investmentUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(removeLinkedQuery)) query: RemoveQuery) {
    return this.service.remove(ctx, id, query);
  }

  @Get(":id/flows")
  flows(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.flows(ctx, id);
  }

  @Post(":id/flows")
  recordFlow(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(investmentFlowInput)) input: z.input<typeof investmentFlowInput>) {
    return this.service.recordFlow(ctx, id, input);
  }

  @Get(":id/valuations")
  valuations(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.valuations(ctx, id);
  }

  @Post(":id/valuations")
  addValuation(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(valuationInput)) input: z.input<typeof valuationInput>) {
    return this.service.addValuation(ctx, id, input);
  }

  @Delete(":id/valuations/:valuationId")
  removeValuation(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Param("valuationId", uuidParam) valuationId: string) {
    return this.service.removeValuation(ctx, id, valuationId);
  }
}

@Controller("liabilities")
@WorkspaceScoped()
export class LiabilitiesController {
  constructor(@Inject(LiabilitiesService) private readonly service: LiabilitiesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(liabilityQuery)) query: LiabilityQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(liabilityInput)) input: z.input<typeof liabilityInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(liabilityUpdate)) input: z.input<typeof liabilityUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(removeLinkedQuery)) query: RemoveQuery) {
    return this.service.remove(ctx, id, query);
  }

  @Get(":id/payments")
  async payments(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    await this.service.get(ctx, id);
    return this.service.linkedTransactions(ctx, id);
  }

  @Post(":id/payments")
  pay(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(liabilityPaymentRequest)) input: LiabilityPaymentRequest) {
    return this.service.pay(ctx, id, input);
  }
}

@Controller("payables")
@WorkspaceScoped()
export class PayablesController {
  constructor(@Inject(LiabilitiesService) private readonly service: LiabilitiesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(payablesQuery)) query: PayablesQuery) {
    return this.service.payables(ctx, query);
  }
}

@Controller("receivables")
@WorkspaceScoped()
export class ReceivablesController {
  constructor(@Inject(ReceivablesService) private readonly service: ReceivablesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query(zod(receivableQuery)) query: ReceivableQuery) {
    return this.service.list(ctx, query);
  }

  @Get(":id")
  detail(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.detail(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body(zod(receivableInput)) input: z.input<typeof receivableInput>) {
    return this.service.create(ctx, input);
  }

  @Patch(":id")
  update(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(receivableUpdate)) input: z.input<typeof receivableUpdate>) {
    return this.service.update(ctx, id, input);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(removeLinkedQuery)) query: RemoveQuery) {
    return this.service.remove(ctx, id, query);
  }

  @Get(":id/payments")
  async payments(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    await this.service.get(ctx, id);
    return this.service.linkedTransactions(ctx, id);
  }

  @Post(":id/payments")
  pay(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(receivablePaymentInput)) input: z.input<typeof receivablePaymentInput>) {
    return this.service.pay(ctx, id, input);
  }
}

@Controller("net-worth")
@WorkspaceScoped()
export class NetWorthController {
  constructor(@Inject(NetWorthService) private readonly service: NetWorthService) {}

  @Get()
  current(@Ctx() ctx: WorkspaceContext) {
    return this.service.current(ctx);
  }

  @Get("history")
  history(@Ctx() ctx: WorkspaceContext, @Query(zod(netWorthHistoryQuery)) query: z.output<typeof netWorthHistoryQuery>) {
    return this.service.history(ctx, query.months);
  }

  @Get("summary")
  summary(@Ctx() ctx: WorkspaceContext) {
    return this.service.summary(ctx);
  }
}
