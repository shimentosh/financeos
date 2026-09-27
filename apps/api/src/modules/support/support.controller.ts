import { pagination, SUPPORT_STATUSES, type SupportRequestInput, supportRequestInput } from "@expensewise/core";
import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { auth } from "../../auth/auth.js";
import type { AppRequest, SessionUser } from "../../common/context.js";
import { AdminGuard, CurrentUser, Public, readCookie, resolveWorkspace, WORKSPACE_COOKIE } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { SupportService } from "./support.service.js";

// `website` is a trap field: people never see it, form-filling bots do.
const submission = supportRequestInput.extend({ website: z.string().max(500).optional() });
const listQuery = pagination.extend({ status: z.enum(SUPPORT_STATUSES).optional() });
const statusInput = z.object({ ids: z.array(z.uuid()).min(1).max(100), status: z.enum(SUPPORT_STATUSES) });

/** /api/support — anyone may write in; signed-in people are linked to their account. */
@Controller("support")
@Public()
export class SupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Post()
  @HttpCode(200)
  @RateLimit("support", 5, 3600)
  async create(@Body(zod(submission)) body: SupportRequestInput & { website?: string }, @Req() request: AppRequest) {
    if (body.website) return { id: null, reference: "RECEIVED" };
    let userId: string | null = null;
    let workspaceId: string | null = null;
    if (request.headers.cookie) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) }).catch(() => null);
      if (session) {
        userId = session.user.id;
        const user: SessionUser = { id: session.user.id, name: session.user.name, email: session.user.email, role: "user", image: session.user.image };
        workspaceId = await resolveWorkspace(user, readCookie(request.headers.cookie, WORKSPACE_COOKIE))
          .then((ctx) => ctx.workspaceId)
          .catch(() => null);
      }
    }
    const { website: _trap, ...input } = body;
    return this.support.create(input, { userId, workspaceId, ip: request.ip ?? null });
  }
}

/** /api/admin/support — platform administrators read and close requests. */
@Controller("admin/support")
@UseGuards(AdminGuard)
export class SupportAdminController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get()
  list(@Query(zod(listQuery)) query: z.output<typeof listQuery>) {
    return this.support.list(query);
  }

  @Patch()
  setStatus(@Body(zod(statusInput)) body: z.output<typeof statusInput>, @CurrentUser() user: SessionUser) {
    return this.support.setStatus(body.ids, body.status, user);
  }
}
