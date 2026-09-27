import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { AssetsService } from "./assets.service.js";
import { InvestmentsService } from "./investments.service.js";
import { LiabilitiesService } from "./liabilities.service.js";
import { NetWorthService } from "./net-worth.service.js";
import { ReceivablesService } from "./receivables.service.js";
import {
  AssetsController,
  InvestmentsController,
  LiabilitiesController,
  NetWorthController,
  PayablesController,
  ReceivablesController,
} from "./wealth.controller.js";
import { WealthJobs } from "./wealth.jobs.js";

const services = [AssetsService, InvestmentsService, LiabilitiesService, ReceivablesService, NetWorthService];

/**
 * Wealth: assets, investments, liabilities and payables, receivables, and net
 * worth. Money moving in or out of any of them is a ledger transaction linked
 * to the record; these services read those links to compute values.
 */
@Module({
  imports: [LedgerModule, PlanningModule],
  controllers: [AssetsController, InvestmentsController, LiabilitiesController, PayablesController, ReceivablesController, NetWorthController],
  providers: [...services, WealthJobs],
  exports: services,
})
export class WealthModule {}
