import { Module } from "@nestjs/common";
import { AccountsService } from "./accounts.service.js";
import { CategoriesService, CounterpartiesService, ProjectsService, RulesService } from "./catalog.service.js";
import { FxService } from "./fx.service.js";
import {
  AccountsController,
  CategoriesController,
  CounterpartiesController,
  ExchangeRatesController,
  ProjectsController,
  RulesController,
  TransactionsController,
} from "./ledger.controller.js";
import { TransactionsService } from "./transactions.service.js";

const services = [FxService, AccountsService, CategoriesService, CounterpartiesService, ProjectsService, RulesService, TransactionsService];

/** The ledger: accounts, transactions and the catalog around them. */
@Module({
  controllers: [
    TransactionsController,
    AccountsController,
    CategoriesController,
    CounterpartiesController,
    ProjectsController,
    RulesController,
    ExchangeRatesController,
  ],
  providers: services,
  exports: services,
})
export class LedgerModule {}
