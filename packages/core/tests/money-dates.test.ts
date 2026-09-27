import { describe, expect, it } from "vitest";
import {
  addMonths,
  convertMinor,
  currencyDecimals,
  diffDays,
  formatMoney,
  minorToInput,
  parseDay,
  parseMoneyInput,
  percentChange,
  presetRange,
  previousRange,
  startOfYear,
  toMinor,
} from "../src/index.ts";

describe("money", () => {
  it("knows minor-unit digits per currency", () => {
    expect(currencyDecimals("BDT")).toBe(2);
    expect(currencyDecimals("usd")).toBe(2);
    expect(currencyDecimals("JPY")).toBe(0);
  });

  it("parses typed amounts including lakh grouping and Bangla digits", () => {
    expect(parseMoneyInput("40,000.50")).toBe(4_000_050);
    expect(parseMoneyInput("1,00,000")).toBe(10_000_000);
    expect(parseMoneyInput("১৫০০০")).toBe(1_500_000);
    expect(parseMoneyInput("12.345")).toBeNull();
    expect(parseMoneyInput("-5")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("500", "JPY")).toBe(500);
  });

  it("round-trips minor units to input text", () => {
    expect(minorToInput(4_000_050, "BDT")).toBe("40000.5");
    expect(minorToInput(1_500_000, "BDT")).toBe("15000");
    expect(minorToInput(-250, "USD")).toBe("-2.5");
    expect(toMinor(19.99, "USD")).toBe(1999);
    expect(toMinor("20", "USD")).toBe(2000);
  });

  it("converts exactly with decimal rates and rounds half away from zero", () => {
    // $200.00 at 122 BDT/USD = ৳24,400.00
    expect(convertMinor(20_000, "USD", "BDT", "122")).toBe(2_440_000);
    // $0.01 at 121.995 → 1.21995 poisha → 1
    expect(convertMinor(1, "USD", "BDT", "121.995")).toBe(122);
    // Half rounds away from zero, including negatives.
    expect(convertMinor(1, "USD", "BDT", "0.005")).toBe(0);
    expect(convertMinor(100, "USD", "BDT", "0.505")).toBe(51);
    expect(convertMinor(-100, "USD", "BDT", "0.505")).toBe(-51);
    // Different minor digits: ¥1,000 at 0.82 BDT = ৳820.00
    expect(convertMinor(1000, "JPY", "BDT", "0.82")).toBe(82_000);
    expect(convertMinor(12_345, "BDT", "BDT", "1")).toBe(12_345);
  });

  it("formats with the narrow symbol and lakh grouping by default", () => {
    expect(formatMoney(5_070_000, "BDT")).toBe("৳50,700.00");
    expect(formatMoney(10_000_000, "BDT")).toBe("৳1,00,000.00");
    expect(formatMoney(10_000_000, "BDT", { locale: "en-US" })).toBe("৳100,000.00");
    expect(formatMoney(20_000, "USD", { trimZeroFraction: true })).toBe("$200");
  });

  it("computes percent change and guards zero", () => {
    expect(percentChange(18_000, 22_000)).toBe(22.2);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(0, 5)).toBeNull();
  });
});

describe("dates", () => {
  it("clamps month ends and keeps the anchor day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("parses statement date formats day-first", () => {
    expect(parseDay("26/09/2026")).toBe("2026-09-26");
    expect(parseDay("09/26/2026")).toBe("2026-09-26");
    expect(parseDay("03/04/2026")).toBe("2026-04-03");
    expect(parseDay("03/04/2026", "MM/DD/YYYY")).toBe("2026-03-04");
    expect(parseDay("26 Sep 2026")).toBe("2026-09-26");
    expect(parseDay("Sep 26, 2026")).toBe("2026-09-26");
    expect(parseDay("২৬/০৯/২০২৬")).toBe("2026-09-26");
    expect(parseDay("2026-09-26T19:20:00Z")).toBe("2026-09-26");
    expect(parseDay("31/02/2026")).toBeNull();
  });

  it("builds period ranges, including fiscal years", () => {
    expect(presetRange("last_month", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("this_quarter", "2026-08-10")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(startOfYear("2026-03-01", 7)).toBe("2025-07-01");
    expect(presetRange("this_year", "2026-09-26", 7)).toEqual({ from: "2026-07-01", to: "2027-06-30" });
    expect(previousRange({ from: "2026-09-01", to: "2026-09-30" })).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(diffDays("2026-09-26", "2027-09-26")).toBe(365);
  });
});
