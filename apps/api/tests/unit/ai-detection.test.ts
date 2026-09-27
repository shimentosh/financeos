import { describe, expect, it } from "vitest";
import { isFee, isScheduledOrPayroll } from "../../src/modules/ai/detection/detection.service.js";

describe("detection filters", () => {
  const row = (metadata: Record<string, unknown> = {}, counterpartyKind: string | null = "merchant", scheduled = false) => ({
    metadata,
    counterpartyKind,
    scheduled,
  });

  it("treats payroll, commitment payments and employees as planned money", () => {
    expect(isScheduledOrPayroll(row({ payrollRunId: "run_1" }))).toBe(true);
    expect(isScheduledOrPayroll(row({ commitmentId: "c_1" }))).toBe(true);
    expect(isScheduledOrPayroll(row({}, "merchant", true))).toBe(true);
    expect(isScheduledOrPayroll(row({}, "employee"))).toBe(true);
    expect(isScheduledOrPayroll(row())).toBe(false);
  });

  it("recognises fee and charge lines", () => {
    expect(isFee(row({ fee: 500 }), null)).toBe(true);
    expect(isFee(row(), "Fees & Charges")).toBe(true);
    expect(isFee(row(), "Payment processing fees")).toBe(true);
    expect(isFee(row(), "Charity")).toBe(false);
    expect(isFee(row(), "Restaurants")).toBe(false);
    expect(isFee(row(), null)).toBe(false);
  });
});
