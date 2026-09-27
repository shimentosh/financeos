import { describe, expect, it } from "vitest";
import {
  applyRules,
  detectLargeTransaction,
  detectRecurring,
  detectRevenueDrop,
  detectSpikes,
  extractAmount,
  findDuplicates,
  forecastCash,
  formatMoney,
  merchantKey,
  nameSimilarity,
  normalizeName,
  parseEntry,
  type Rule,
  scoreDuplicate,
} from "../src/index.ts";

const bdt = (minor: number) => formatMoney(minor, "BDT");

describe("merchant names", () => {
  it("normalizes processor noise and store numbers", () => {
    expect(normalizeName("OPENAI *ChatGPT Subscr #1234")).toBe("openai chatgpt subscr");
    expect(normalizeName("OpenAI, Inc.")).toBe("openai");
    expect(merchantKey("PAYPAL *Spotify AB")).toBe("spotify");
    expect(nameSimilarity("Shwapno Gulshan", "SHWAPNO - Gulshan 2")).toBeGreaterThan(0.8);
    expect(nameSimilarity("Netflix", "Foodpanda")).toBeLessThan(0.3);
  });
});

describe("duplicates", () => {
  const manual = { id: "m", date: "2026-09-10", amount: 20_000, currency: "USD", merchant: "Claude.ai", accountId: "card" };

  it("treats the same wallet transaction id as the same money", () => {
    const result = scoreDuplicate({ ...manual, reference: "BKA9X7Y2Z1" }, { ...manual, id: "x", amount: 999, reference: "bka9x7y2z1" });
    expect(result).toMatchObject({ score: 1, exact: true });
  });

  it("scores an imported copy of a manually recorded payment", () => {
    const imported = { id: "i", date: "2026-09-11", amount: 20_000, currency: "USD", merchant: "ANTHROPIC CLAUDE AI", accountId: "card" };
    const matches = findDuplicates(imported, [manual, { ...manual, id: "other", amount: 1_500 }]);
    expect(matches.map((m) => m.id)).toEqual(["m"]);
    expect(matches[0]?.reasons).toContain("Same amount");
  });

  it("does not match different amounts or distant dates", () => {
    expect(scoreDuplicate(manual, { ...manual, amount: 25_000 }).score).toBe(0);
    // Distinct transaction ids, or distinct ids from the same import source, are two payments.
    expect(scoreDuplicate({ ...manual, reference: "TXN000001" }, { ...manual, id: "x", reference: "TXN000002" }).score).toBe(0);
    expect(scoreDuplicate({ ...manual, externalKey: "stripe:c1:ch_1" }, { ...manual, id: "x", externalKey: "stripe:c1:ch_2" }).score).toBe(0);
    // A different source may be a second copy of the same money.
    expect(scoreDuplicate({ ...manual, externalKey: "stripe:c1:ch_1" }, { ...manual, id: "x", externalKey: "csv:c2:row_9" }).score).toBeGreaterThan(0.7);
    expect(scoreDuplicate(manual, { ...manual, date: "2026-10-10" }).score).toBeLessThan(0.7);
  });
});

describe("recurring detection", () => {
  it("finds a monthly subscription and a yearly renewal", () => {
    const tx = [
      { id: "1", date: "2026-06-05", amount: 240_000, merchant: "OPENAI *CHATGPT" },
      { id: "2", date: "2026-07-05", amount: 240_000, merchant: "OpenAI" },
      { id: "3", date: "2026-08-05", amount: 240_000, merchant: "OPENAI *CHATGPT" },
      { id: "4", date: "2026-09-05", amount: 240_000, merchant: "OPENAI" },
      { id: "5", date: "2025-09-20", amount: 1_200_000, merchant: "Cloudflare" },
      { id: "6", date: "2026-09-20", amount: 1_250_000, merchant: "Cloudflare" },
      { id: "7", date: "2026-09-12", amount: 50_000, merchant: "Random shop" },
    ];
    const candidates = detectRecurring(tx, "2026-09-26");
    const openai = candidates.find((c) => c.key === "openai");
    expect(openai).toMatchObject({ cadence: "monthly", occurrences: 4, typicalAmount: 240_000, nextExpected: "2026-10-05" });
    expect(candidates.find((c) => c.key === "cloudflare")?.cadence).toBe("yearly");
    expect(candidates.find((c) => c.key === "random")).toBeUndefined();
  });

  it("ignores patterns that stopped long ago", () => {
    const tx = ["2025-01-05", "2025-02-05", "2025-03-05"].map((date, i) => ({ id: String(i), date, amount: 1000, merchant: "Gym" }));
    expect(detectRecurring(tx, "2026-09-26")).toHaveLength(0);
  });
});

describe("anomalies", () => {
  it("flags a category far above its own history, with evidence", () => {
    const [anomaly] = detectSpikes(
      [
        { key: "software", label: "Software", history: [5_000_000, 5_200_000, 4_900_000], current: 8_000_000, transactionIds: ["t1", "t2"] },
        { key: "food", label: "Food", history: [2_000_000, 2_100_000, 1_900_000], current: 2_150_000, transactionIds: [] },
      ],
      { minAbsolute: 500_000, format: bdt, period: "this month" },
    );
    expect(anomaly).toMatchObject({ key: "software", kind: "category_spike", transactionIds: ["t1", "t2"] });
    expect(anomaly?.title).toBe("Software spending is 58.9% above normal");
  });

  it("needs history and a meaningful absolute increase", () => {
    expect(
      detectSpikes([{ key: "x", label: "X", history: [100, 100], current: 900, transactionIds: [] }], { minAbsolute: 1, format: bdt, period: "" }),
    ).toHaveLength(0);
    expect(
      detectSpikes([{ key: "x", label: "X", history: [100, 110, 90], current: 500, transactionIds: [] }], { minAbsolute: 10_000, format: bdt, period: "" }),
    ).toHaveLength(0);
  });

  it("flags a payment far above a merchant's usual amount", () => {
    const anomaly = detectLargeTransaction({ id: "t", amount: 1_500_000, merchant: "Foodpanda", date: "2026-09-20" }, [60_000, 45_000, 80_000], [], bdt);
    expect(anomaly?.kind).toBe("large_transaction");
    expect(detectLargeTransaction({ id: "t", amount: 90_000, merchant: "Foodpanda", date: "2026-09-20" }, [60_000, 45_000, 80_000], [], bdt)).toBeNull();
  });

  it("ignores a large ratio when the absolute excess is pocket change", () => {
    const fee = { id: "t", amount: 600, merchant: "Stripe", date: "2026-09-20" } as const;
    expect(detectLargeTransaction(fee, [150, 172, 160], [], bdt)?.kind).toBe("large_transaction");
    expect(detectLargeTransaction(fee, [150, 172, 160], [], bdt, { minExcess: 100_000 })).toBeNull();
  });

  it("flags a revenue drop", () => {
    const drop = detectRevenueDrop(
      [
        { month: "2026-06", amount: 1_000_000 },
        { month: "2026-07", amount: 1_100_000 },
        { month: "2026-08", amount: 900_000 },
        { month: "2026-09", amount: 400_000 },
      ],
      bdt,
    );
    expect(drop?.severity).toBe("critical");
  });
});

describe("cash forecast", () => {
  it("applies scheduled events on their dates and daily spending in between", () => {
    const forecast = forecastCash({
      startBalance: 1_000_000,
      today: "2026-09-26",
      horizonDays: 10,
      dailyDiscretionary: 10_000,
      dailyDeviation: 5_000,
      events: [
        { date: "2026-09-28", amount: -500_000, label: "Rent", kind: "commitment", certainty: "confirmed" },
        { date: "2026-10-01", amount: 2_000_000, label: "Salary", kind: "income", certainty: "expected" },
        { date: "2026-12-01", amount: -1, label: "Out of range", kind: "commitment", certainty: "confirmed" },
      ],
    });
    expect(forecast.days).toHaveLength(10);
    expect(forecast.endBalance).toBe(1_000_000 - 500_000 + 2_000_000 - 100_000);
    expect(forecast.lowest).toEqual({ date: "2026-09-30", balance: 460_000 });
    expect(forecast.events).toHaveLength(2);
    const last = forecast.days[9];
    expect(last && last.high - last.low).toBeGreaterThan(forecast.days[0] ? forecast.days[0].high - forecast.days[0].low : 0);
  });
});

describe("rules", () => {
  const rules: Rule[] = [
    {
      id: "openai",
      name: "OpenAI is AI",
      enabled: true,
      priority: 10,
      match: "all",
      conditions: [{ field: "merchant", operator: "contains", value: "OpenAI" }],
      actions: { categoryId: "ai" },
      stopProcessing: false,
    },
    {
      id: "large",
      name: "Large needs review",
      enabled: true,
      priority: 20,
      match: "all",
      conditions: [{ field: "amount", operator: "gt", value: 5_000_000 }],
      actions: { requireReview: true, categoryId: "should-not-win" },
      stopProcessing: false,
    },
    {
      id: "off",
      name: "Disabled",
      enabled: false,
      priority: 1,
      match: "all",
      conditions: [{ field: "merchant", operator: "contains", value: "openai" }],
      actions: { categoryId: "disabled" },
      stopProcessing: false,
    },
  ];

  it("applies in priority order without later rules overwriting earlier ones", () => {
    const outcome = applyRules(rules, { merchant: "OPENAI *CHATGPT", amount: 6_000_000 });
    expect(outcome.actions).toEqual({ categoryId: "ai", requireReview: true });
    expect(outcome.matchedRuleIds).toEqual(["openai", "large"]);
    expect(outcome.decidedBy.categoryId).toBe("openai");
  });

  it("stops processing when a rule says so", () => {
    const stopping = rules.map((rule) => (rule.id === "openai" ? { ...rule, stopProcessing: true } : rule));
    expect(applyRules(stopping, { merchant: "openai", amount: 6_000_000 }).matchedRuleIds).toEqual(["openai"]);
  });
});

describe("natural-language entry", () => {
  const today = "2026-09-26";

  it("parses the Bangla business example", () => {
    const entry = parseEntry("আজকে business-এর জন্য ১৫ হাজার টাকার monitor কিনলাম।", { today });
    expect(entry).toMatchObject({
      type: "expense",
      amount: 1_500_000,
      currency: "BDT",
      date: today,
      categoryHint: "Equipment",
      workspaceHint: "business",
    });
    expect(entry.missing).toEqual(["account"]);
  });

  it("parses income, dollars, yesterday and a project", () => {
    const entry = parseEntry("Yesterday received $250 from a ClipMesh client via Payoneer", { today, projects: ["ClipMesh"] });
    expect(entry).toMatchObject({ type: "income", amount: 25_000, currency: "USD", date: "2026-09-25", projectHint: "ClipMesh", accountHint: "payoneer" });
  });

  it("parses Bangla groceries by bKash and lakh amounts", () => {
    expect(parseEntry("গতকাল বিকাশে ১২০০ টাকার বাজার করলাম", { today })).toMatchObject({
      amount: 120_000,
      date: "2026-09-25",
      categoryHint: "Groceries",
      accountHint: "bkash",
    });
    expect(extractAmount("1.5 lakh")?.value).toBe(150_000);
    expect(extractAmount("15k")?.value).toBe(15_000);
    expect(extractAmount("in 2026 I paid 500")?.value).toBe(500);
  });

  it("asks for the amount when there is none", () => {
    expect(parseEntry("paid the internet bill", { today }).missing[0]).toBe("amount");
  });
});
