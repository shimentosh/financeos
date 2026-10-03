import { employeeUpdate, payrollItemUpdate, payrollRunInput } from "@financeos/core";
import {
  type EmployeeCreateInput,
  employeeCreateInput,
  employeeQuery,
  type FinanceRangeQuery,
  financeRangeQuery,
} from "@financeos/core/contracts/business-extra";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import type { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import { Ctx, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { PayrollService } from "./payroll.service.js";
import { ProjectFinanceService } from "./project-finance.service.js";
import { RevenueService } from "./revenue.service.js";

const uuidParam = new ParseUUIDPipe({ version: "7" });

@Controller("projects")
@WorkspaceScoped()
export class ProjectFinanceController {
  constructor(@Inject(ProjectFinanceService) private readonly service: ProjectFinanceService) {}

  @Get("finance")
  overview(@Ctx() ctx: WorkspaceContext, @Query(zod(financeRangeQuery)) query: FinanceRangeQuery) {
    return this.service.overview(ctx, query);
  }

  @Get(":id/finance")
  profile(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Query(zod(financeRangeQuery)) query: FinanceRangeQuery) {
    return this.service.profile(ctx, id, query);
  }
}

@Controller("revenue")
@WorkspaceScoped()
export class RevenueController {
  constructor(@Inject(RevenueService) private readonly service: RevenueService) {}

  @Get()
  analytics(@Ctx() ctx: WorkspaceContext, @Query(zod(financeRangeQuery)) query: FinanceRangeQuery) {
    return this.service.analytics(ctx, query);
  }
}

@Controller("payroll")
@WorkspaceScoped()
export class PayrollController {
  constructor(@Inject(PayrollService) private readonly service: PayrollService) {}

  @Get("employees")
  employees(@Ctx() ctx: WorkspaceContext, @Query(zod(employeeQuery)) query: z.input<typeof employeeQuery>) {
    return this.service.listEmployees(ctx, query);
  }

  @Get("employees/:id")
  employee(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.employeeDetail(ctx, id);
  }

  @Post("employees")
  createEmployee(@Ctx() ctx: WorkspaceContext, @Body(zod(employeeCreateInput)) input: EmployeeCreateInput) {
    return this.service.createEmployee(ctx, input);
  }

  @Patch("employees/:id")
  updateEmployee(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string, @Body(zod(employeeUpdate)) input: z.input<typeof employeeUpdate>) {
    return this.service.updateEmployee(ctx, id, input);
  }

  @Delete("employees/:id")
  removeEmployee(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.removeEmployee(ctx, id);
  }

  @Get("runs")
  runs(@Ctx() ctx: WorkspaceContext) {
    return this.service.listRuns(ctx);
  }

  @Get("runs/:id")
  run(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.runDetail(ctx, id);
  }

  @Post("runs")
  createRun(@Ctx() ctx: WorkspaceContext, @Body(zod(payrollRunInput)) input: z.input<typeof payrollRunInput>) {
    return this.service.createRun(ctx, input);
  }

  @Delete("runs/:id")
  deleteRun(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.deleteRun(ctx, id);
  }

  @Patch("runs/:id/items/:itemId")
  updateItem(
    @Ctx() ctx: WorkspaceContext,
    @Param("id", uuidParam) id: string,
    @Param("itemId", uuidParam) itemId: string,
    @Body(zod(payrollItemUpdate)) input: z.input<typeof payrollItemUpdate>,
  ) {
    return this.service.updateItem(ctx, id, itemId, input);
  }

  @Post("runs/:id/post")
  @HttpCode(200)
  post(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.post(ctx, id);
  }

  @Post("runs/:id/unpost")
  @HttpCode(200)
  unpost(@Ctx() ctx: WorkspaceContext, @Param("id", uuidParam) id: string) {
    return this.service.unpost(ctx, id);
  }
}
