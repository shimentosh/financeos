import { Module } from "@nestjs/common";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { AccountController, AdminUsersController, AuthOptionsController } from "./account.controller.js";
import { AccountService } from "./account.service.js";
import { AccountExportService } from "./account-export.service.js";

/** Your own account: first-run setup, data export, account deletion. */
@Module({
  imports: [WorkspacesModule],
  controllers: [AuthOptionsController, AccountController, AdminUsersController],
  providers: [AccountService, AccountExportService],
})
export class AccountModule {}
