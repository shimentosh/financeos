import { Module } from "@nestjs/common";
import { SupportAdminController, SupportController } from "./support.controller.js";
import { SupportService } from "./support.service.js";

/** Messages to the people running the service: the help form and the public contact page. */
@Module({
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService],
})
export class SupportModule {}
