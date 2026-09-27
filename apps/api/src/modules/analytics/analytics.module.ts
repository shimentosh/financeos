import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { contextFor } from "../../common/context.js";
import { db } from "../../db/index.js";
import { workspaces } from "../../db/schema/index.js";
import { SchedulerService } from "../jobs/scheduler.service.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { JobsService } from "../system/jobs.service.js";
import { WealthModule } from "../wealth/wealth.module.js";
import { AnalyticsController, ReportsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { OverviewService } from "./overview.service.js";
import { ReportsService } from "./reports.service.js";

const services = [AnalyticsService, OverviewService, ReportsService];

/** Read models: dashboard, cash flow, forecasts, reports. */
@Module({
  imports: [LedgerModule, WealthModule, PlanningModule],
  controllers: [AnalyticsController, ReportsController],
  providers: services,
  exports: services,
})
export class AnalyticsModule implements OnModuleInit {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  onModuleInit() {
    // Weekly briefs every Saturday morning (the Bangladesh work week starts
    // Sunday) and monthly reports on the 1st, one job per workspace.
    this.jobs.register("reports.generate", async (payload) => {
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, String(payload.workspaceId)));
      if (!workspace) return { skipped: "workspace gone" };
      const ctx = contextFor(workspace, { userId: null, actorType: "system" });
      const report = await this.reports.generate(ctx, { kind: payload.kind as "weekly" | "monthly", withNarrative: true });
      return { reportId: report?.id };
    });
    const fanOut = (kind: "weekly" | "monthly") => async () => {
      const period = new Date().toISOString().slice(0, 10);
      for (const workspaceId of await this.scheduler.workspaceIds()) {
        await this.jobs.enqueue("reports.generate", { workspaceId, kind }, { workspaceId, dedupeKey: `reports:${kind}:${workspaceId}:${period}` });
      }
    };
    this.scheduler.register("reports.weekly", "0 7 * * 6", "Weekly brief for every workspace", fanOut("weekly"));
    this.scheduler.register("reports.monthly", "0 7 1 * *", "Monthly report for every workspace", fanOut("monthly"));
  }
}
