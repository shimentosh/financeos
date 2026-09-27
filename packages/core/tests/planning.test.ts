import { describe, expect, it } from "vitest";
import {
  budgetDetailQuery,
  budgetQuery,
  calendarQuery,
  markPaidRequest,
  queryBoolean,
  subscriptionCreateRequest,
  subscriptionQuery,
  upcomingQuery,
} from "../src/contracts/planning-extra.ts";

describe("planning request contracts", () => {
  it("reads query-string booleans literally", () => {
    expect(queryBoolean.parse("false")).toBe(false);
    expect(queryBoolean.parse("0")).toBe(false);
    expect(queryBoolean.parse("true")).toBe(true);
    expect(queryBoolean.parse(true)).toBe(true);
    expect(() => queryBoolean.parse("maybe")).toThrow();
    expect(budgetQuery.parse({ active: "false" }).active).toBe(false);
    expect(budgetQuery.parse({}).active).toBeUndefined();
  });

  it("defaults the upcoming window and splits list params", () => {
    expect(upcomingQuery.parse({})).toMatchObject({ days: 30, includeOverdue: true });
    expect(upcomingQuery.parse({ days: "7", includeOverdue: "false", kind: "rent,subscription" })).toMatchObject({
      days: 7,
      includeOverdue: false,
      kind: ["rent", "subscription"],
    });
    expect(() => upcomingQuery.parse({ days: "0" })).toThrow();
  });

  it("bounds calendar ranges", () => {
    expect(calendarQuery.parse({ from: "2026-09-01", to: "2026-09-30" })).toMatchObject({ includeSettled: true });
    expect(() => calendarQuery.parse({ from: "2026-10-01", to: "2026-09-01" })).toThrow(/on or before/);
    expect(() => calendarQuery.parse({ from: "2026-01-01", to: "2027-12-31" })).toThrow(/at most 400 days/);
  });

  it("filters subscriptions by cycle, month and auto-renew", () => {
    expect(subscriptionQuery.parse({ billingCycle: ["yearly"], autoRenew: "true", renewingIn: "2026-10" })).toMatchObject({
      billingCycle: ["yearly"],
      autoRenew: true,
      renewingIn: "2026-10",
      sort: "renewal_asc",
    });
    expect(() => subscriptionQuery.parse({ renewingIn: "2026-13" })).toThrow();
  });

  it("does not force a duplicate payment unless asked", () => {
    expect(markPaidRequest.parse({ paidOn: "2026-09-01" })).toMatchObject({ force: false, updateFutureAmount: false });
    expect(markPaidRequest.parse({ paidOn: "2026-09-01", force: true }).force).toBe(true);
  });

  it("accepts a purchase transaction to link on subscription create", () => {
    const parsed = subscriptionCreateRequest.parse({
      provider: "Anthropic",
      amount: 20_000,
      currency: "usd",
      billingCycle: "yearly",
      startDate: "2026-09-26",
      nextRenewalDate: "2027-09-26",
      purchaseTransactionId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    });
    expect(parsed).toMatchObject({ currency: "USD", autoRenew: true, status: "active" });
    expect(budgetDetailQuery.parse({})).toMatchObject({ periods: 6 });
  });
});
