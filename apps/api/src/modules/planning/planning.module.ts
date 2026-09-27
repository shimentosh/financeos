import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module.js";
import { BudgetsService } from "./budgets.service.js";
import { PlanningCalendarService } from "./calendar.service.js";
import { CommitmentsService } from "./commitments.service.js";
import { GoalsService } from "./goals.service.js";
import { OccurrencesService } from "./occurrences.service.js";
import { BudgetsController, CommitmentsController, GoalsController, OccurrencesController, SubscriptionsController } from "./planning.controller.js";
import { PlanningJobs } from "./planning.jobs.js";
import { RemindersService } from "./reminders.service.js";
import { SubscriptionsService } from "./subscriptions.service.js";

const services = [CommitmentsService, OccurrencesService, SubscriptionsService, PlanningCalendarService, BudgetsService, GoalsService, RemindersService];

/** Planning: commitments, subscriptions, renewals, budgets, goals. */
@Module({
  imports: [LedgerModule],
  controllers: [CommitmentsController, OccurrencesController, SubscriptionsController, BudgetsController, GoalsController],
  providers: [...services, PlanningJobs],
  exports: services,
})
export class PlanningModule {}
