import { type BillingInterval, currencyDecimals, minorToInput, type PlanId, toMinor } from "@expensewise/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { unprocessable } from "../../common/errors.js";
import { randomBase62 } from "../integrations/crypto.js";
import { appLink } from "../system/email.service.js";
import { type BillingConfig, loadBillingConfig } from "./billing-config.js";
import { BILLING_FETCH, type BillingFetch } from "./http.js";
import { PaymentsService } from "./payments.service.js";

const HOSTS = { sandbox: "https://sandbox.sslcommerz.com", live: "https://securepay.sslcommerz.com" };

export const SSLCOMMERZ_CALLBACKS = {
  success: "/api/billing/sslcommerz/success",
  fail: "/api/billing/sslcommerz/fail",
  cancel: "/api/billing/sslcommerz/cancel",
  ipn: "/api/billing/sslcommerz/ipn",
} as const;

/** Minor units as the fixed-point major amount SSLCommerz expects: 60000 BDT → "600.00". */
export function majorAmount(minor: number, currency: string): string {
  const digits = currencyDecimals(currency);
  const whole = Math.trunc(minor / 10 ** digits);
  const fraction = minor - whole * 10 ** digits;
  return digits ? `${whole}.${String(fraction).padStart(digits, "0")}` : String(whole);
}

export type CheckoutOutcome = "success" | "failed" | "canceled";

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);

/**
 * SSLCommerz (Bangladesh: bKash, Nagad, Rocket, local and international
 * cards). Payments are one-time, so a plan is a prepaid month or year. The
 * browser is sent to SSLCommerz's page and comes back with a form POST; every
 * payment is confirmed server to server with the validation API before
 * anything is granted, and the IPN does the same in case the browser never
 * returns.
 */
@Injectable()
export class SslcommerzService {
  private readonly logger = new Logger("SSLCommerz");

  constructor(
    @Inject(BILLING_FETCH) private readonly fetcher: BillingFetch,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  private host(config: BillingConfig) {
    return config.sslcommerz.sandbox ? HOSTS.sandbox : HOSTS.live;
  }

  private credentials(config: BillingConfig) {
    const { storeId, storePassword } = config.sslcommerz;
    if (!storeId || !storePassword) throw unprocessable("SSLCommerz isn't set up on this server", "sslcommerz_not_configured");
    return { storeId, storePassword };
  }

  /** Starts a payment session; returns the SSLCommerz page to send the browser to. */
  private async initSession(config: BillingConfig, fields: Record<string, string>) {
    const { storeId, storePassword } = this.credentials(config);
    const body = new URLSearchParams({
      store_id: storeId,
      store_passwd: storePassword,
      success_url: appLink(SSLCOMMERZ_CALLBACKS.success),
      fail_url: appLink(SSLCOMMERZ_CALLBACKS.fail),
      cancel_url: appLink(SSLCOMMERZ_CALLBACKS.cancel),
      ipn_url: appLink(SSLCOMMERZ_CALLBACKS.ipn),
      shipping_method: "NO",
      num_of_item: "1",
      product_category: "Software",
      product_profile: "non-physical-goods",
      cus_add1: "N/A",
      cus_city: "Dhaka",
      cus_postcode: "1000",
      cus_country: "Bangladesh",
      cus_phone: "N/A",
      ...fields,
    });
    const response = await this.fetcher(`${this.host(config)}/gwprocess/v4/api.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return json;
  }

  /** Checks the store credentials with a throwaway session (nothing is charged). */
  async test(config: BillingConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const json = await this.initSession(config, {
        total_amount: "10.00",
        currency: "BDT",
        tran_id: `EWTEST-${randomBase62(10)}`,
        cus_name: "Expense Wise",
        cus_email: "test@example.com",
        product_name: "Credential check",
      });
      if (json.status === "SUCCESS") return { ok: true, message: `Store credentials accepted (${config.sslcommerz.sandbox ? "sandbox" : "live"})` };
      return { ok: false, message: str(json.failedreason) ?? "SSLCommerz rejected the store credentials" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async checkout(
    config: BillingConfig,
    user: { id: string; email: string; name: string },
    item:
      | { purpose: "plan"; plan: PlanId; interval: BillingInterval; amount: number; currency: string }
      | { purpose: "credits"; packId: string; credits: number; amount: number; currency: string },
  ): Promise<{ url: string }> {
    this.credentials(config);
    const tranId = `EW-${Date.now().toString(36)}-${randomBase62(8)}`.slice(0, 30);
    const product =
      item.purpose === "plan"
        ? `Expense Wise ${config.plans[item.plan].name} (${item.interval === "year" ? "1 year" : "1 month"})`
        : `${item.credits.toLocaleString("en-US")} AI credits`;
    const payment = await this.payments.create({
      userId: user.id,
      provider: "sslcommerz",
      providerRef: tranId,
      purpose: item.purpose,
      plan: item.purpose === "plan" ? item.plan : null,
      interval: item.purpose === "plan" ? item.interval : null,
      credits: item.purpose === "credits" ? item.credits : null,
      amount: item.amount,
      currency: item.currency,
      metadata: item.purpose === "credits" ? { packId: item.packId } : {},
    });
    if (!payment) throw unprocessable("Could not start the payment; try again", "payment_conflict");
    const json = await this.initSession(config, {
      total_amount: majorAmount(item.amount, item.currency),
      currency: item.currency.toUpperCase(),
      tran_id: tranId,
      cus_name: user.name || user.email,
      cus_email: user.email,
      product_name: product,
      value_a: payment.id,
      value_b: user.id,
    });
    const url = str(json.GatewayPageURL);
    if (json.status !== "SUCCESS" || !url) {
      const reason = str(json.failedreason) ?? "SSLCommerz did not start the payment";
      await this.payments.markUnpaid(payment.id, "failed", { reason });
      throw unprocessable(`SSLCommerz: ${reason}`, "sslcommerz_error");
    }
    return { url };
  }

  /** Asks SSLCommerz whether a payment really went through. */
  private async validate(config: BillingConfig, valId: string): Promise<Record<string, unknown>> {
    const { storeId, storePassword } = this.credentials(config);
    const query = new URLSearchParams({ val_id: valId, store_id: storeId, store_passwd: storePassword, format: "json", v: "1" });
    const response = await this.fetcher(`${this.host(config)}/validator/api/validationserverAPI.php?${query.toString()}`, { method: "GET" });
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /**
   * The browser's return (success, fail, cancel) or the IPN. Whatever the
   * form says, a payment is granted only after the validation API confirms
   * it: status VALID or VALIDATED, and the transaction, amount and currency
   * of the payment this server started.
   */
  async handleCallback(kind: "success" | "fail" | "cancel" | "ipn", body: Record<string, unknown>): Promise<CheckoutOutcome> {
    const tranId = str(body.tran_id);
    if (!tranId) return kind === "cancel" ? "canceled" : "failed";
    const payment = await this.payments.byRef("sslcommerz", tranId);
    if (!payment) {
      this.logger.warn(`${kind} for unknown transaction ${tranId}`);
      return "failed";
    }
    if (payment.status === "paid") return "success";
    const status = str(body.status)?.toUpperCase();
    if (kind === "cancel" || (kind === "ipn" && status === "CANCELLED")) {
      await this.payments.markUnpaid(payment.id, "canceled");
      return "canceled";
    }
    const valId = str(body.val_id);
    if (kind === "fail" || !valId || (kind === "ipn" && status && status !== "VALID" && status !== "VALIDATED")) {
      await this.payments.markUnpaid(payment.id, "failed", { reason: str(body.error) ?? str(body.failedreason) ?? status ?? "failed" });
      return "failed";
    }

    const config = await loadBillingConfig();
    let validation: Record<string, unknown>;
    try {
      validation = await this.validate(config, valId);
    } catch (error) {
      this.logger.warn(`Validation of ${tranId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
    const validStatus = str(validation.status)?.toUpperCase();
    const currency = (str(validation.currency_type) ?? str(validation.currency) ?? "").toUpperCase();
    const amountText = str(validation.currency_amount) ?? str(validation.amount);
    let amount: number | null = null;
    try {
      amount = amountText ? toMinor(amountText, payment.currency) : null;
    } catch {
      amount = null;
    }
    const problems = [
      validStatus === "VALID" || validStatus === "VALIDATED" ? null : `status ${validStatus ?? "unknown"}`,
      str(validation.tran_id) === payment.providerRef ? null : "transaction id does not match",
      currency === payment.currency ? null : `currency ${currency || "?"} instead of ${payment.currency}`,
      amount === payment.amount ? null : `amount ${amountText ?? "?"} instead of ${minorToInput(payment.amount, payment.currency)}`,
    ].filter((p): p is string => p !== null);
    if (problems.length) {
      this.logger.warn(`Rejected SSLCommerz payment ${tranId}: ${problems.join("; ")}`);
      await this.payments.markUnpaid(payment.id, "failed", { reason: `Validation failed: ${problems.join("; ")}`, valId });
      return "failed";
    }
    await this.payments.markPaid(payment.id, {
      providerPaymentId: str(validation.bank_tran_id) ?? valId,
      metadata: { valId, cardType: str(validation.card_type), riskLevel: str(validation.risk_level) },
    });
    return "success";
  }
}
