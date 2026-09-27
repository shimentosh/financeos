import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { EventsService } from "../system/events.service.js";
import { recordHeartbeat } from "../system/heartbeat.js";
import { JobsService } from "../system/jobs.service.js";
import { runsWorker } from "./worker-mode.js";

const POLL_MS = 2000;

/**
 * The background loop: delivers domain events, then runs due jobs. Nothing
 * here blocks a request; a slow AI extraction or sync only delays the next
 * poll of this loop.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Worker");
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  onApplicationBootstrap() {
    if (!runsWorker()) return;
    this.logger.log(`Worker ${this.jobs.workerId} started (${this.jobs.registeredTypes().length} job types)`);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Also callable from /api/system/tick for cron-driven hosts. */
  async tick(): Promise<{ events: number; jobs: number }> {
    if (this.busy) return { events: 0, jobs: 0 };
    this.busy = true;
    try {
      // At most once a minute: the admin panel shows when a worker was last alive.
      await recordHeartbeat(this.jobs.workerId).catch((error: unknown) =>
        this.logger.warn(`Heartbeat not recorded: ${error instanceof Error ? error.message : String(error)}`),
      );
      const events = await this.events.dispatchPending();
      const jobs = await this.jobs.runDue();
      return { events, jobs };
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
      return { events: 0, jobs: 0 };
    } finally {
      this.busy = false;
    }
  }
}
