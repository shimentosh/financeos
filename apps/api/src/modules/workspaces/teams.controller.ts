import {
  type AssignableRole,
  acceptInvitationInput,
  deleteWorkspaceInput,
  invitationInput,
  invitationLookupQuery,
  memberRoleInput,
  resendInvitationInput,
  transferOwnershipInput,
} from "@financeos/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type { Response } from "express";
import type { z } from "zod";
import { auth } from "../../auth/auth.js";
import type { AppRequest, SessionUser, WorkspaceContext } from "../../common/context.js";
import { AllowViewer, Ctx, CurrentUser, Public, RequireManage, WorkspaceScoped } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { RateLimit } from "../system/rate-limit.js";
import { TeamsService } from "./teams.service.js";
import { setWorkspaceCookie } from "./workspace-cookie.js";

/**
 * The people in the active workspace: members, their roles, invitations,
 * leaving, handing over ownership, and deleting the workspace. Managing people
 * needs owner or admin; the finer rules (nobody touches the owner, admins
 * manage only members and viewers) live in TeamsService.
 */
@Controller("workspaces/current")
@WorkspaceScoped()
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @Get("members")
  members(@Ctx() ctx: WorkspaceContext) {
    return this.teams.listMembers(ctx);
  }

  /** Kept for older clients: adding someone by email now sends them an invitation. */
  @Post("members")
  @RequireManage()
  @RateLimit("invitations", 60, 3600)
  addMember(@Ctx() ctx: WorkspaceContext, @CurrentUser() user: SessionUser, @Body(zod(invitationInput)) input: z.output<typeof invitationInput>) {
    return this.teams.invite(ctx, input, user);
  }

  @Patch("members/:memberId")
  @RequireManage()
  changeRole(@Ctx() ctx: WorkspaceContext, @Param("memberId", ParseUUIDPipe) memberId: string, @Body(zod(memberRoleInput)) input: { role: AssignableRole }) {
    return this.teams.changeRole(ctx, memberId, input.role);
  }

  @Delete("members/:memberId")
  @RequireManage()
  removeMember(@Ctx() ctx: WorkspaceContext, @Param("memberId", ParseUUIDPipe) memberId: string) {
    return this.teams.removeMember(ctx, memberId);
  }

  /** Anyone but the owner, viewers included (leaving changes nothing in the books). */
  @Post("leave")
  @AllowViewer()
  @HttpCode(200)
  async leave(@Ctx() ctx: WorkspaceContext, @Res({ passthrough: true }) response: Response) {
    const result = await this.teams.leave(ctx);
    setWorkspaceCookie(response, result.workspaceId);
    return result;
  }

  @Post("transfer")
  @RequireManage()
  @HttpCode(200)
  transfer(@Ctx() ctx: WorkspaceContext, @CurrentUser() user: SessionUser, @Body(zod(transferOwnershipInput)) input: { userId: string }) {
    return this.teams.transferOwnership(ctx, input.userId, user);
  }

  @Delete()
  @RequireManage()
  async deleteWorkspace(
    @Ctx() ctx: WorkspaceContext,
    @CurrentUser() user: SessionUser,
    @Body(zod(deleteWorkspaceInput)) input: { confirmName: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.teams.deleteWorkspace(ctx, input.confirmName, user);
    setWorkspaceCookie(response, result.workspaceId);
    return result;
  }

  @Get("invitations")
  @RequireManage()
  invitations(@Ctx() ctx: WorkspaceContext) {
    return this.teams.listInvitations(ctx);
  }

  @Post("invitations")
  @RequireManage()
  @RateLimit("invitations", 60, 3600)
  invite(@Ctx() ctx: WorkspaceContext, @CurrentUser() user: SessionUser, @Body(zod(invitationInput)) input: z.output<typeof invitationInput>) {
    return this.teams.invite(ctx, input, user);
  }

  @Post("invitations/:id/resend")
  @RequireManage()
  @RateLimit("invitations", 60, 3600)
  @HttpCode(200)
  resend(
    @Ctx() ctx: WorkspaceContext,
    @CurrentUser() user: SessionUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(zod(resendInvitationInput)) input: z.output<typeof resendInvitationInput>,
  ) {
    return this.teams.resend(ctx, id, input, user);
  }

  @Delete("invitations/:id")
  @RequireManage()
  revoke(@Ctx() ctx: WorkspaceContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.teams.revoke(ctx, id);
  }
}

/** The invitation link: readable by anyone holding it, accepted only by the invited person. */
@Controller("invitations")
export class InvitationsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  @Get("lookup")
  @Public()
  @RateLimit("invitation-lookup", 30, 60)
  async lookup(@Req() request: AppRequest, @Query(zod(invitationLookupQuery)) query: { token: string }) {
    // Public, so the session guard did not run: read the session, if any, to say who would accept.
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) }).catch(() => null);
    return this.teams.lookup(query.token, session?.user.id ?? null);
  }

  @Post("accept")
  @RateLimit("invitation-accept", 20, 60)
  @HttpCode(200)
  async accept(
    @Req() request: AppRequest,
    @CurrentUser() user: SessionUser,
    @Body(zod(acceptInvitationInput)) input: { token: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.teams.accept(user, input.token, request.ip);
    setWorkspaceCookie(response, result.workspaceId);
    return result;
  }
}
