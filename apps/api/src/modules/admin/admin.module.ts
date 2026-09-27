import { Module } from "@nestjs/common";
import { AdminGuard } from "../../common/guards.js";
import { AdminController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";

/** Platform administration (instance-wide, admin role only). */
@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
