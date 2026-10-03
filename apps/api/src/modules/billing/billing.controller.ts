import { type CheckoutInput, checkoutInput } from "@financeos/core";
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AppRequest, SessionUser } from "../../common/context.js";
import { CurrentUser, Public } from "../../common/guards.js";
import { zod } from "../../common/zod.js";
import { appLink } from "../system/email.service.js";
import { RateLimit } from "../system/rate-limit.js";
import { BillingService } from "./billing.service.js";
import { type CheckoutOutcome, SslcommerzService } from "./sslcommerz.service.js";
import { StripeService } from "./stripe.service.js";

const back = (outcome: CheckoutOutcome) => appLink(`/settings/billing?checkout=${outcome}`);

/**
 * /api/billing — the signed-in user's plan (not tied to a workspace: a plan
 * covers every workspace the user owns), the public price list, and the
 * payment providers' callbacks. The callbacks are public and come from other
 * sites; each is verified on its own terms (Stripe's signature, SSLCommerz's
 * validation API), never by a session.
 */
@Controller("billing")
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(StripeService) private readonly stripe: StripeService,
    @Inject(SslcommerzService) private readonly sslcommerz: SslcommerzService,
  ) {}

  /** Plans, prices, credit packs and which providers take payments: the public pricing page. */
  @Get("plans")
  @Public()
  plans() {
    return this.billing.plans();
  }

  @Get()
  overview(@CurrentUser() user: SessionUser) {
    return this.billing.overview(user);
  }

  @Post("checkout")
  @HttpCode(200)
  @RateLimit("billing-checkout", 10, 60)
  checkout(@Body(zod(checkoutInput)) body: CheckoutInput, @CurrentUser() user: SessionUser) {
    return this.billing.checkout(user, body);
  }

  @Post("portal")
  @HttpCode(200)
  @RateLimit("billing-portal", 10, 60)
  portal(@CurrentUser() user: SessionUser) {
    return this.billing.portal(user);
  }

  @Post("cancel")
  @HttpCode(200)
  cancel(@CurrentUser() user: SessionUser) {
    return this.billing.cancel(user);
  }

  @Post("resume")
  @HttpCode(200)
  resume(@CurrentUser() user: SessionUser) {
    return this.billing.resume(user);
  }

  /** Stripe's webhook: verified by the Stripe-Signature header over the raw body. */
  @Post("webhooks/stripe")
  @Public()
  @HttpCode(200)
  stripeWebhook(@Req() request: AppRequest, @Headers("stripe-signature") signature: string | undefined) {
    return this.stripe.handleWebhook(request.rawBody, signature);
  }

  // SSLCommerz sends the browser back with a form POST, then we redirect it to Plan & billing.

  @Post("sslcommerz/success")
  @Public()
  async sslSuccess(@Req() request: AppRequest, @Res() response: Response) {
    response.redirect(303, back(await this.sslcommerz.handleCallback("success", (request.body ?? {}) as Record<string, unknown>)));
  }

  @Post("sslcommerz/fail")
  @Public()
  async sslFail(@Req() request: AppRequest, @Res() response: Response) {
    response.redirect(303, back(await this.sslcommerz.handleCallback("fail", (request.body ?? {}) as Record<string, unknown>)));
  }

  @Post("sslcommerz/cancel")
  @Public()
  async sslCancel(@Req() request: AppRequest, @Res() response: Response) {
    response.redirect(303, back(await this.sslcommerz.handleCallback("cancel", (request.body ?? {}) as Record<string, unknown>)));
  }

  /** Server-to-server notice from SSLCommerz, in case the browser never comes back. */
  @Post("sslcommerz/ipn")
  @Public()
  @HttpCode(200)
  async sslIpn(@Req() request: AppRequest) {
    const outcome = await this.sslcommerz.handleCallback("ipn", (request.body ?? {}) as Record<string, unknown>);
    return { received: true, outcome };
  }
}
