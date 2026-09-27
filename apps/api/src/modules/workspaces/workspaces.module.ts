import { Module } from "@nestjs/common";
import { InvitationsController, TeamsController } from "./teams.controller.js";
import { TeamsService } from "./teams.service.js";
import { WorkspaceDeletionService } from "./workspace-deletion.service.js";
import { MeController, MembershipCheckController, NotificationsController, WorkspacesController } from "./workspaces.controller.js";

@Module({
  controllers: [MeController, WorkspacesController, TeamsController, InvitationsController, NotificationsController, MembershipCheckController],
  providers: [WorkspaceDeletionService, TeamsService],
  exports: [WorkspaceDeletionService, TeamsService],
})
export class WorkspacesModule {}
