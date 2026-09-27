import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { AppExceptionFilter } from "./common/exception.filter.js";
import { SessionGuard } from "./common/guards.js";
import { AccountModule } from "./modules/account/account.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { AiModule } from "./modules/ai/ai.module.js";
import { AnalyticsModule } from "./modules/analytics/analytics.module.js";
import { BillingModule } from "./modules/billing/billing.module.js";
import { BusinessModule } from "./modules/business/business.module.js";
import { CopilotModule } from "./modules/copilot/copilot.module.js";
import { IntegrationsModule } from "./modules/integrations/integrations.module.js";
import { JobsModule } from "./modules/jobs/jobs.module.js";
import { LedgerModule } from "./modules/ledger/ledger.module.js";
import { PlanningModule } from "./modules/planning/planning.module.js";
import { StorageModule } from "./modules/storage/storage.module.js";
import { SupportModule } from "./modules/support/support.module.js";
import { HealthController } from "./modules/system/health.controller.js";
import { RateLimitGuard } from "./modules/system/rate-limit.js";
import { SystemModule } from "./modules/system/system.module.js";
import { WealthModule } from "./modules/wealth/wealth.module.js";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module.js";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SystemModule,
    BillingModule,
    JobsModule,
    StorageModule,
    WorkspacesModule,
    LedgerModule,
    PlanningModule,
    WealthModule,
    BusinessModule,
    AnalyticsModule,
    AiModule,
    CopilotModule,
    IntegrationsModule,
    AdminModule,
    AccountModule,
    SupportModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate first, then rate-limit per user.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
