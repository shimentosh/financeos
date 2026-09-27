import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { SchedulerService } from "../jobs/scheduler.service.js";
import { JobsService } from "../system/jobs.service.js";
import { BudgetsService } from "./budgets.service.js";
import { systemContext } from "./planning.shared.js";
import { RemindersService } from "./reminders.service.js";

export const REMINDERS_JOB = "planning.reminders";
export const BUDGET_ALERTS_JOB = "planning.budget_alerts";

/** `yyyy-mm-dd-hh` (UTC): one job per workspace per hour. */
export function hourKey(now = new Date()): string {
  return now.toISOString().slice(0, 13).replace("T", "-");
}

/**
 * Background work for planning. Each scheduled task fans out one job per
 * workspace; the jobs themselves are idempotent (dedupe keys on every
 * notification and Inbox item), so a retried or repeated run is harmless.
 */
@Injectable()
export class PlanningJobs implements OnModuleInit {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(RemindersService) private readonly reminders: RemindersService,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
  ) {}

  onModuleInit() {
    this.jobs.register(REMINDERS_JOB, async (_payload, job) => {
      const ctx = job.workspaceId ? await systemContext(job.workspaceId) : null;
      if (!ctx) return { skipped: "workspace not found" };
      return this.reminders.scan(ctx);
    });
    this.jobs.register(BUDGET_ALERTS_JOB, async (_payload, job) => {
      const ctx = job.workspaceId ? await systemContext(job.workspaceId) : null;
      if (!ctx) return { skipped: "workspace not found" };
      return this.budgets.scanThresholds(ctx);
    });
    this.scheduler.register(REMINDERS_JOB, "5 * * * *", "Renewal and payment reminders, overdue payments, subscription statuses, goal achievements", () =>
      this.enqueueAll(REMINDERS_JOB),
    );
    this.scheduler.register(BUDGET_ALERTS_JOB, "20 * * * *", "Budget threshold alerts", () => this.enqueueAll(BUDGET_ALERTS_JOB));
  }

  async enqueueAll(type: string, now = new Date()) {
    const hour = hourKey(now);
    let enqueued = 0;
    for (const workspaceId of await this.scheduler.workspaceIds()) {
      const id = await this.jobs.enqueue(type, {}, { workspaceId, dedupeKey: `${type}:${workspaceId}:${hour}`, maxAttempts: 3 });
      if (id) enqueued += 1;
    }
    return { enqueued };
  }
}
