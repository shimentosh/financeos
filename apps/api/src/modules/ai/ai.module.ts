import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { ReportsService } from "../analytics/reports.service.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { AiController, CapturesController, InboxController } from "./ai.controller.js";
import { AiConfigController } from "./ai-config.controller.js";
import { AiConfigService } from "./ai-config.service.js";
import { CaptureService } from "./capture/capture.service.js";
import { DraftBuilder } from "./capture/draft-builder.js";
import { DetectionService } from "./detection/detection.service.js";
import { AiGateway } from "./gateway/ai.gateway.js";
import { createAiProvider } from "./gateway/provider.factory.js";
import { RoutingProvider } from "./gateway/router.provider.js";
import { AI_PROVIDER, type AiProvider } from "./gateway/types.js";
import { AiInboxService } from "./inbox/ai-inbox.service.js";
import { narrativeWriter } from "./narrative.js";
import { AiRateLimiter, AiUsageService } from "./usage.service.js";

/**
 * AI: the provider-neutral gateway (usage, budget, rate limits), the capture
 * pipeline, the AI Inbox, daily recurring/anomaly detection and report
 * narratives. Tests replace AI_PROVIDER with a fake; nothing else knows which
 * vendor answers.
 */
@Module({
  imports: [LedgerModule, PlanningModule, AnalyticsModule],
  controllers: [CapturesController, InboxController, AiController, AiConfigController],
  providers: [
    { provide: AI_PROVIDER, useFactory: createAiProvider },
    AiUsageService,
    AiRateLimiter,
    AiGateway,
    AiConfigService,
    DraftBuilder,
    CaptureService,
    AiInboxService,
    DetectionService,
  ],
  exports: [AI_PROVIDER, AiGateway, AiUsageService, CaptureService, AiInboxService, DetectionService],
})
export class AiModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  onModuleDestroy() {
    if (this.provider instanceof RoutingProvider) this.provider.stopPolling();
  }

  onModuleInit() {
    // Report narratives from the gateway; the template stands in whenever it declines.
    this.reports.setNarrativeWriter(narrativeWriter(this.gateway));
  }
}
