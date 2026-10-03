import {
  type AdminCreditsInput,
  type AdminPlanInput,
  adminBillingPaymentsQuery,
  adminBillingUsersQuery,
  adminCreditsWithPaymentInput,
  adminPlanWithPaymentInput,
  type BillingConfigInput,
  type BillingTestInput,
  billingConfigInput,
  billingTestInput,
} from "@financeos/core";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import type { AppRequest, SessionUser } from "../../common/context.js";
import { AdminGuard, CurrentUser } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { BillingAdminService } from "./billing-admin.service.js";

/** /api/admin/billing — plans, prices, providers and the people paying. Platform administrators only. */
@Controller("admin/billing")
@UseGuards(AdminGuard)
export class BillingAdminController {
  constructor(@Inject(BillingAdminService) private readonly admin: BillingAdminService) {}

  private actor(user: SessionUser, request: AppRequest) {
    return { id: user.id, email: user.email, ip: request.ip ?? null };
  }

  @Get()
  view() {
    return this.admin.view();
  }

  @Put()
  update(@Body(zod(billingConfigInput)) body: BillingConfigInput, @CurrentUser() user: SessionUser, @Req() request: AppRequest) {
    return this.admin.update(body, this.actor(user, request));
  }

  @Post("test")
  @HttpCode(200)
  @RateLimit("billing-config-test", 12, 60)
  test(@Body(zod(billingTestInput)) body: BillingTestInput) {
    return this.admin.test(body);
  }

  @Get("summary")
  summary() {
    return this.admin.summary();
  }

  @Get("users")
  users(@Query(zod(adminBillingUsersQuery)) query: z.output<typeof adminBillingUsersQuery>) {
    return this.admin.users(query);
  }

  @Post("users/:userId/plan")
  @HttpCode(200)
  setPlan(
    @Param("userId") userId: string,
    @Body(zod(adminPlanWithPaymentInput)) body: AdminPlanInput,
    @CurrentUser() user: SessionUser,
    @Req() request: AppRequest,
  ) {
    return this.admin.setPlan(userId, body, this.actor(user, request));
  }

  @Post("users/:userId/credits")
  @HttpCode(200)
  addCredits(
    @Param("userId") userId: string,
    @Body(zod(adminCreditsWithPaymentInput)) body: AdminCreditsInput,
    @CurrentUser() user: SessionUser,
    @Req() request: AppRequest,
  ) {
    return this.admin.addCredits(userId, body, this.actor(user, request));
  }

  @Get("payments")
  payments(@Query(zod(adminBillingPaymentsQuery)) query: z.output<typeof adminBillingPaymentsQuery>) {
    return this.admin.paymentsList(query);
  }
}
