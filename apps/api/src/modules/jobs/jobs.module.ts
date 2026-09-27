import { timingSafeEqual } from "node:crypto";
import { Controller, Global, Headers, HttpCode, Inject, Module, type OnModuleInit, Post } from "@nestjs/common";
import { unauthorized } from "../../common/errors.js";
import { Public } from "../../common/guards.js";
import { env } from "../../env.js";
import { EventsService } from "../system/events.service.js";
import { JobsService } from "../system/jobs.service.js";
import { pruneRateLimits } from "../system/rate-limit.js";
import { SchedulerService } from "./scheduler.service.js";
import { WorkerService } from "./worker.service.js";

@Controller("system")
export class SystemTickController {
  constructor(@Inject(WorkerService) private readonly worker: WorkerService) {}

  /** For hosts without a long-running worker: an external cron calls this. */
  @Post("tick")
  @Public()
  @HttpCode(200)
  tick(@Headers("x-cron-secret") secret: string | undefined) {
    const expected = env.CRON_SECRET;
    if (!expected || !secret || secret.length !== expected.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) {
      throw unauthorized("Invalid cron secret");
    }
    return this.worker.tick();
  }
}

@Global()
@Module({
  controllers: [SystemTickController],
  providers: [WorkerService, SchedulerService],
  exports: [WorkerService, SchedulerService],
})
export class JobsModule implements OnModuleInit {
  constructor(
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  onModuleInit() {
    this.scheduler.register("system.prune", "30 3 * * *", "Prune finished jobs and delivered events", async () => {
      await this.jobs.prune();
      await this.events.prune();
    });
    this.scheduler.register("system.prune-ops", "45 3 * * *", "Prune schedule claims older than 30 days and expired rate-limit counters", () =>
      this.pruneOps(),
    );
  }

  async pruneOps() {
    const schedulerRuns = await this.scheduler.pruneRuns(30);
    const rateLimits = await pruneRateLimits(24);
    return { schedulerRuns, rateLimits };
  }
}
