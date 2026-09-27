import { Global, Module } from "@nestjs/common";
import { AdminSystemController } from "./admin-system.controller.js";
import { AuditService } from "./audit.service.js";
import { ClientErrorsController } from "./client-errors.controller.js";
import { EmailService } from "./email.service.js";
import { EventsService } from "./events.service.js";
import { JobsService } from "./jobs.service.js";
import { InboxService, NotificationsService } from "./notify.service.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { RateLimitGuard } from "./rate-limit.js";

/** Cross-cutting services every domain module uses. */
@Global()
@Module({
  // Operations: GET /api/admin/system, POST /api/system/client-errors.
  controllers: [AdminSystemController, ClientErrorsController],
  providers: [AuditService, EmailService, EventsService, JobsService, NotificationsService, InboxService, PlatformAuditService, RateLimitGuard],
  exports: [AuditService, EmailService, EventsService, JobsService, NotificationsService, InboxService, PlatformAuditService, RateLimitGuard],
})
export class SystemModule {}
