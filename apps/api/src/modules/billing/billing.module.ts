import { Global, Module } from "@nestjs/common";
import { BillingController } from "./billing.controller.js";
import { BillingJobs } from "./billing.jobs.js";
import { BillingService } from "./billing.service.js";
import { BillingAdminController } from "./billing-admin.controller.js";
import { BillingAdminService } from "./billing-admin.service.js";
import { CreditsService } from "./credits.service.js";
import { EntitlementsService } from "./entitlements.service.js";
import { BILLING_FETCH, defaultBillingFetch } from "./http.js";
import { PaymentsService } from "./payments.service.js";
import { SslcommerzService } from "./sslcommerz.service.js";
import { StripeService } from "./stripe.service.js";

/**
 * Plans, payments and AI credits for the hosted service. Global so any module
 * can ask the entitlements service whether something is allowed, and the AI
 * gateway can charge credits.
 */
@Global()
@Module({
  controllers: [BillingController, BillingAdminController],
  providers: [
    { provide: BILLING_FETCH, useValue: defaultBillingFetch },
    EntitlementsService,
    CreditsService,
    PaymentsService,
    StripeService,
    SslcommerzService,
    BillingService,
    BillingAdminService,
    BillingJobs,
  ],
  exports: [EntitlementsService, CreditsService, PaymentsService, BillingService],
})
export class BillingModule {}
