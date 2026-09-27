import { describe, expect, it } from "vitest";
import { extractAmount, extractReference, parseEntry } from "../src/index.ts";

const today = "2026-09-26";

describe("amount extraction", () => {
  it("prefers the figure marked by a currency word over larger unmarked ones", () => {
    expect(extractAmount("Paid 1200 tk at Star Kabab")?.value).toBe(1200);
    expect(extractAmount("৫০০ টাকা বাজার")?.value).toBe(500);
    expect(extractAmount("Tk 1,250.00 paid")?.value).toBe(1250);
  });

  it("skips balances, fees and the digits of dates and times in a wallet SMS", () => {
    const sms = "You have paid Tk 1,250.00 to Star Kabab. Fee Tk 0.00. Balance Tk 3,750.00. TrxID BGH7K2L9QX at 26/09/2026 13:45";
    expect(extractAmount(sms)?.value).toBe(1250);
    expect(extractAmount("Balance Tk 9,999.00 after payment of 300")?.value).toBe(300);
    expect(extractAmount("at 26/09/2026 13:45")).toBeNull();
  });

  it("keeps the existing multiplier and year behaviour", () => {
    expect(extractAmount("1.5 lakh")?.value).toBe(150_000);
    expect(extractAmount("15k")?.value).toBe(15_000);
    expect(extractAmount("in 2026 I paid 500")?.value).toBe(500);
  });
});

describe("references", () => {
  it("finds wallet and bank transaction ids", () => {
    expect(extractReference("... TrxID BGH7K2L9QX at 26/09/2026")).toBe("BGH7K2L9QX");
    expect(extractReference("Txn ID: 8A1B2C3D9")).toBe("8A1B2C3D9");
    expect(extractReference("Ref no. 20260926001")).toBe("20260926001");
  });

  it("ignores words that only look like one", () => {
    expect(extractReference("reference please call me")).toBeNull();
    expect(extractReference("paid for lunch")).toBeNull();
  });
});

describe("parseEntry", () => {
  it("reads a pasted bKash SMS completely", () => {
    const entry = parseEntry("You have paid Tk 1,250.00 to Star Kabab. Fee Tk 0.00. Balance Tk 3,750.00. TrxID BGH7K2L9QX at 26/09/2026 13:45", { today });
    expect(entry).toMatchObject({
      type: "expense",
      amount: 125_000,
      currency: "BDT",
      date: "2026-09-26",
      dateSource: "explicit",
      merchant: "Star Kabab",
      reference: "BGH7K2L9QX",
    });
    expect(entry.confidence.amount).toBeGreaterThanOrEqual(0.8);
  });

  it("says where the date came from", () => {
    expect(parseEntry("Paid 1200 tk at Star Kabab today with bkash", { today })).toMatchObject({
      dateSource: "relative",
      date: today,
      merchant: "Star Kabab",
      accountHint: "bkash",
    });
    expect(parseEntry("gave 500 to rahim yesterday", { today })).toMatchObject({
      dateSource: "relative",
      date: "2026-09-25",
    });
    const undated = parseEntry("spent $20 on ChatGPT Plus", { today });
    expect(undated).toMatchObject({
      dateSource: "default",
      date: today,
      currency: "USD",
      amount: 2_000,
    });
    expect(undated.confidence.date).toBeLessThan(0.8);
  });

  it("does not read a name containing 'aj' as today", () => {
    expect(parseEntry("Paid Raj 500 tk on 20/09/2026", { today })).toMatchObject({ date: "2026-09-20", dateSource: "explicit" });
  });

  it("drops trailing words that are not part of a merchant name", () => {
    expect(parseEntry("Paid 300 tk to Rahim Today", { today }).merchant).toBe("Rahim");
    expect(parseEntry("Bought a domain from Namecheap.com for $12", { today }).merchant).toBe("Namecheap.com");
  });
});
