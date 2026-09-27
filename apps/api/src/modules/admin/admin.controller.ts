import { pagination } from "@expensewise/core";
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminGuard } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { AdminService } from "./admin.service.js";

const listQuery = pagination.extend({ q: z.string().trim().max(120).optional() });
type ListQuery = z.output<typeof listQuery>;

/**
 * /api/admin/* — platform administrators only. User management (ban, role,
 * impersonation, sessions) goes through Better Auth's admin plugin at
 * /api/auth/admin/*, which enforces the same admin role.
 */
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get("overview")
  overview() {
    return this.admin.overview();
  }

  @Get("users")
  users(@Query(zod(listQuery)) query: ListQuery) {
    return this.admin.users(query);
  }

  @Get("workspaces")
  workspaces(@Query(zod(listQuery)) query: ListQuery) {
    return this.admin.workspaces(query);
  }

  @Get("jobs")
  jobs(
    @Query(zod(z.object({ status: z.enum(["queued", "running", "succeeded", "failed", "dead"]).optional() }))) query: {
      status?: "queued" | "running" | "succeeded" | "failed" | "dead";
    },
  ) {
    return this.admin.jobList(query.status);
  }

  @Post("jobs/:id/retry")
  @HttpCode(200)
  async retry(@Param("id", ParseUUIDPipe) id: string) {
    await this.admin.retryJob(id);
    return { ok: true };
  }

  @Post("schedules/run")
  @HttpCode(200)
  runSchedule(@Body(zod(z.object({ name: z.string().min(1).max(100) }))) body: { name: string }) {
    return this.admin.runSchedule(body.name);
  }

  @Get("events")
  events() {
    return this.admin.eventQueue();
  }

  @Post("events/dispatch")
  @HttpCode(200)
  dispatch() {
    return this.admin.dispatchEvents();
  }

  @Get("ai-usage")
  aiUsage(@Query(zod(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }))) query: { days: number }) {
    return this.admin.aiUsage(query.days);
  }

  @Get("integrations")
  integrations() {
    return this.admin.integrations();
  }

  @Get("audit")
  audit(@Query(zod(pagination.extend({ action: z.string().max(80).optional() }))) query: { page: number; pageSize: number; action?: string }) {
    return this.admin.audit(query);
  }

  /** Actions on the installation itself: admin changes to users, account and workspace deletions. */
  @Get("platform-audit")
  platformAudit(@Query(zod(pagination.extend({ action: z.string().max(80).optional() }))) query: { page: number; pageSize: number; action?: string }) {
    return this.admin.platformAudit(query);
  }
}
