import { dayString, reportGenerateInput } from "@financeos/core";
import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { Ctx, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { AnalyticsService } from "./analytics.service.js";
import { OverviewService } from "./overview.service.js";
import { ReportsService } from "./reports.service.js";

const rangeQuery = z.object({
  from: dayString.optional(),
  to: dayString.optional(),
  projectId: z.uuid().optional(),
  kind: z.enum(["expense", "income"]).default("expense"),
  accountIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined)),
});
type RangeQuery = z.output<typeof rangeQuery>;

@Controller("analytics")
@WorkspaceScoped()
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(OverviewService) private readonly overviewService: OverviewService,
  ) {}

  private range(ctx: WorkspaceContext, query: RangeQuery) {
    const month = this.analytics.monthRange(ctx);
    return { from: query.from ?? month.from, to: query.to ?? query.from ?? todayFor(ctx) };
  }

  @Get("overview")
  overview(@Ctx() ctx: WorkspaceContext) {
    return this.overviewService.overview(ctx);
  }

  @Get("summary")
  summary(@Ctx() ctx: WorkspaceContext, @Query(zod(rangeQuery)) query: RangeQuery) {
    return this.analytics.compare(ctx, this.range(ctx, query));
  }

  @Get("monthly")
  monthly(
    @Ctx() ctx: WorkspaceContext,
    @Query(zod(z.object({ months: z.coerce.number().int().min(1).max(36).default(12), projectId: z.uuid().optional() }))) query: {
      months: number;
      projectId?: string;
    },
  ) {
    return this.analytics.monthly(ctx, query.months, { projectId: query.projectId });
  }

  @Get("categories")
  categories(@Ctx() ctx: WorkspaceContext, @Query(zod(rangeQuery)) query: RangeQuery) {
    return this.analytics.byCategory(ctx, this.range(ctx, query), query.kind, { projectId: query.projectId });
  }

  @Get("merchants")
  merchants(@Ctx() ctx: WorkspaceContext, @Query(zod(rangeQuery)) query: RangeQuery) {
    return this.analytics.topMerchants(ctx, this.range(ctx, query), query.kind);
  }

  @Get("cash-flow")
  cashFlow(@Ctx() ctx: WorkspaceContext, @Query(zod(rangeQuery)) query: RangeQuery) {
    return this.analytics.cashFlow(ctx, this.range(ctx, query), query.accountIds);
  }

  @Get("cash-flow/series")
  cashFlowSeries(
    @Ctx() ctx: WorkspaceContext,
    @Query(zod(z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }))) query: { months: number },
  ) {
    return this.analytics.cashFlowSeries(ctx, query.months);
  }

  @Get("forecast")
  forecast(@Ctx() ctx: WorkspaceContext, @Query(zod(z.object({ days: z.coerce.number().int().min(7).max(180).default(90) }))) query: { days: number }) {
    return this.analytics.forecast(ctx, query.days);
  }
}

@Controller("reports")
@WorkspaceScoped()
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.reports.list(ctx);
  }

  /** A report's data without saving it (the live Reports page). */
  @Get("preview")
  preview(
    @Ctx() ctx: WorkspaceContext,
    @Query(
      zod(z.object({ kind: z.enum(["weekly", "monthly", "quarterly", "custom"]).default("monthly"), from: dayString.optional(), to: dayString.optional() })),
    )
    query: { kind: "weekly" | "monthly" | "quarterly" | "custom"; from?: string; to?: string },
  ) {
    const range = this.reports.rangeFor(ctx, query.kind, query.from, query.to);
    return this.reports.build(ctx, range).then((data) => ({ data, narrative: this.reports.template(data) }));
  }

  @Post()
  @RateLimit("reports", 20, 3600)
  generate(@Ctx() ctx: WorkspaceContext, @Body(zod(reportGenerateInput)) input: z.output<typeof reportGenerateInput>) {
    return this.reports.generate(ctx, input);
  }

  @Get(":id")
  get(@Ctx() ctx: WorkspaceContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.reports.get(ctx, id);
  }

  @Delete(":id")
  remove(@Ctx() ctx: WorkspaceContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.reports.remove(ctx, id);
  }
}
