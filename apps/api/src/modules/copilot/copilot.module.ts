import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { BusinessModule } from "../business/business.module.js";
import { IntegrationsModule } from "../integrations/integrations.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { WealthModule } from "../wealth/wealth.module.js";
import { AgentMemoryService } from "./agent-memory.service.js";
import { CopilotActions } from "./copilot.actions.js";
import { CopilotController } from "./copilot.controller.js";
import { CopilotQueries } from "./copilot.queries.js";
import { CopilotService } from "./copilot.service.js";
import { McpController } from "./mcp.controller.js";
import { McpService } from "./mcp.service.js";

/**
 * The AI copilot: questions answered through a read-only query layer over the
 * ledger, and changes prepared as suggestions the user confirms. The same
 * tools are served to outside agents over MCP.
 */
@Module({
  imports: [LedgerModule, AnalyticsModule, PlanningModule, WealthModule, BusinessModule, AiModule, IntegrationsModule],
  controllers: [CopilotController, McpController],
  providers: [CopilotQueries, CopilotService, CopilotActions, AgentMemoryService, McpService],
  exports: [CopilotQueries, CopilotService],
})
export class CopilotModule {}
