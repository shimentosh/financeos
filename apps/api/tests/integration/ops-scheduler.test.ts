import { SchedulerRegistry } from "@nestjs/schedule";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { jobs, rateLimits, schedulerRuns } from "../../src/db/schema/index.js";
import { SchedulerService, slotFor } from "../../src/modules/jobs/scheduler.service.js";
import { hit } from "../../src/modules/system/rate-limit.js";
import { RECEIVABLES_TASK } from "../../src/modules/wealth/wealth.jobs.js";
import { createUser, resetDatabase, service, shutdown } from "./harness.js";

// Several processes run the cron (API instances with the in-process worker,
// worker replicas): each firing must run its task exactly once.

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await shutdown();
});

function instance(counter: { runs: number }) {
  const scheduler = new SchedulerService(new SchedulerRegistry());
  scheduler.register("ops.test", "*/5 * * * *", "Test task", async () => {
    counter.runs += 1;
    // Long enough that the other instance's claim overlaps the run.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return scheduler;
}

describe("scheduler: one run per slot", () => {
  it("truncates a firing to its minute", () => {
    expect(slotFor(new Date("2026-09-26T03:45:00.004Z")).toISOString()).toBe("2026-09-26T03:45:00.000Z");
    expect(slotFor(new Date("2026-09-26T03:45:59.999Z")).toISOString()).toBe("2026-09-26T03:45:00.000Z");
  });

  it("runs a task once when instances race for the same slot", async () => {
    const counter = { runs: 0 };
    const [a, b, c] = [instance(counter), instance(counter), instance(counter)];
    const fired = new Date("2026-09-26T03:45:00.010Z");
    const results = await Promise.all([
      a.runScheduled("ops.test", fired),
      b.runScheduled("ops.test", new Date(fired.getTime() + 150)),
      c.runScheduled("ops.test", new Date(fired.getTime() + 2_000)),
    ]);
    expect(counter.runs).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    const claims = await db.select().from(schedulerRuns).where(eq(schedulerRuns.name, "ops.test"));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.slot.toISOString()).toBe("2026-09-26T03:45:00.000Z");

    // The next slot runs again, once.
    const next = new Date("2026-09-26T03:50:00.001Z");
    await Promise.all([a.runScheduled("ops.test", next), b.runScheduled("ops.test", next)]);
    expect(counter.runs).toBe(2);
  });

  it("always runs a task started by hand (admin → Run now)", async () => {
    const counter = { runs: 0 };
    const scheduler = instance(counter);
    await scheduler.runScheduled("ops.test", new Date("2026-09-26T04:00:00Z"));
    await scheduler.runTask("ops.test");
    await scheduler.runTask("ops.test");
    expect(counter.runs).toBe(3);
  });

  it("the app's scheduler claims slots for the registered tasks too", async () => {
    const scheduler = await service(SchedulerService);
    const user = await createUser("Scheduler Owner");
    const fired = new Date();
    expect(await scheduler.runScheduled(RECEIVABLES_TASK, fired)).toBe(true);
    expect(await scheduler.runScheduled(RECEIVABLES_TASK, fired)).toBe(false);
    const queued = await db.select().from(jobs).where(eq(jobs.type, "wealth.receivables-overdue"));
    expect(queued.map((job) => job.workspaceId).sort()).toEqual([user.personal.workspaceId, user.business.workspaceId].sort());
    // Dedupe keys carry the day, so tomorrow's run is not blocked by today's.
    const day = new Date().toISOString().slice(0, 10);
    expect(queued.every((job) => job.dedupeKey?.endsWith(`:${day}`))).toBe(true);
  });
});

describe("pruning operational tables", () => {
  it("drops old schedule claims and expired rate-limit counters, daily", async () => {
    const scheduler = await service(SchedulerService);
    expect(scheduler.list().map((task) => task.name)).toContain("system.prune-ops");

    const day = 86_400_000;
    await db.insert(schedulerRuns).values([
      { name: "old.task", slot: new Date(Date.now() - 40 * day), instance: "a" },
      { name: "recent.task", slot: new Date(Date.now() - 2 * day), instance: "a" },
    ]);
    await hit("ops-test:fresh", 10, 60);
    await db.insert(rateLimits).values({ key: "ops-test:stale", windowStart: new Date(Date.now() - 2 * day), count: 3 });

    await scheduler.runTask("system.prune-ops");

    expect((await db.select().from(schedulerRuns)).map((row) => row.name)).toEqual(["recent.task"]);
    expect((await db.select().from(rateLimits).where(like(rateLimits.key, "ops-test:%"))).map((row) => row.key)).toEqual(["ops-test:fresh"]);
    expect(scheduler.list().find((task) => task.name === "system.prune-ops")?.lastRun).toMatchObject({ ok: true });
  });
});
