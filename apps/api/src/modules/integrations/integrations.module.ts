import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module.js";
import { ConnectionsService } from "./connections.service.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { ImportsController } from "./imports/imports.controller.js";
import { ImportsService } from "./imports/imports.service.js";
import { IntegrationsController, SyncRunsController, WebhooksController } from "./integrations.controller.js";
import { PipelineService } from "./pipeline.service.js";
import { ApiKeyGuard } from "./public-api/api-key.guard.js";
import { ApiKeysService } from "./public-api/api-keys.service.js";
import { ApiKeysController, PublicApiController } from "./public-api/public-api.controller.js";
import { PublicApiService } from "./public-api/public-api.service.js";
import { SyncService } from "./sync.service.js";
import { WebhooksService } from "./webhooks.service.js";

/**
 * Integrations: the connector framework and registry, the sync engine and its
 * jobs, inbound webhooks, CSV/Excel imports, API keys and the public API v1.
 */
@Module({
  imports: [LedgerModule],
  controllers: [IntegrationsController, SyncRunsController, WebhooksController, ImportsController, ApiKeysController, PublicApiController],
  providers: [
    ConnectorRegistry,
    PipelineService,
    SyncService,
    WebhooksService,
    ConnectionsService,
    ImportsService,
    ApiKeysService,
    ApiKeyGuard,
    PublicApiService,
  ],
  exports: [ConnectorRegistry, SyncService, ConnectionsService, ImportsService, ApiKeysService],
})
export class IntegrationsModule {}
