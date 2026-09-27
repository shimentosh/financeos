import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { SchedulerService } from "../jobs/scheduler.service.js";
import { JobsService } from "../system/jobs.service.js";
import { RECEIVABLES_JOB, ReceivablesService } from "./receivables.service.js";

export const RECEIVABLES_TASK = "wealth.receivables";

/** The wealth module's background work: the daily overdue-receivables pass. */
@Injectable()
export class WealthJobs implements OnModuleInit {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(ReceivablesService) private readonly receivables: ReceivablesService,
  ) {}

  onModuleInit() {
    this.jobs.register(RECEIVABLES_JOB, async (payload, job) => {
      const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : job.workspaceId;
      if (!workspaceId) throw new Error(`${RECEIVABLES_JOB} needs a workspaceId`);
      return this.receivables.scanOverdue(workspaceId);
    });
    this.scheduler.register(RECEIVABLES_TASK, "15 6 * * *", "Overdue receivables: inbox items, notices and invoice.overdue events at 1, 7 and 30 days", () =>
      this.enqueueAll(),
    );
  }

  /** One job per workspace; the dedupe key keeps a slow run from being queued twice. */
  async enqueueAll(): Promise<number> {
    const ids = await this.scheduler.workspaceIds();
    let queued = 0;
    for (const workspaceId of ids) {
      const id = await this.jobs.enqueue(
        RECEIVABLES_JOB,
        { workspaceId },
        { workspaceId, dedupeKey: `${RECEIVABLES_JOB}:${workspaceId}:${new Date().toISOString().slice(0, 10)}` },
      );
      if (id) queued += 1;
    }
    return queued;
  }
}
