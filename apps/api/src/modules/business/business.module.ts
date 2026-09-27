import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { WealthModule } from "../wealth/wealth.module.js";
import { PayrollController, ProjectFinanceController, RevenueController } from "./business.controller.js";
import { PayrollService } from "./payroll.service.js";
import { ProjectFinanceService } from "./project-finance.service.js";
import { RevenueService } from "./revenue.service.js";

const services = [ProjectFinanceService, RevenueService, PayrollService];

/**
 * Business: project finance (revenue, cost, burn, runway), revenue analytics,
 * and payroll. Reads the ledger and the wealth module's receivables and
 * payables; payroll posts through the ledger's TransactionsService.
 */
@Module({
  imports: [LedgerModule, PlanningModule, WealthModule],
  controllers: [ProjectFinanceController, RevenueController, PayrollController],
  providers: services,
  exports: services,
})
export class BusinessModule {}
