import { parseEntry } from "@expensewise/core";
import { describe, expect, it } from "vitest";
import { accountsForMethod, DraftBuilder, type ResolvedDraft } from "../../src/modules/ai/capture/draft-builder.js";
import {
  amountToMinor,
  buildSubscriptionSuggestion,
  candidateFromParsed,
  candidatesFromExtraction,
  detectSubscriptionHint,
  mapType,
  mergeParserIntoAi,
  normalizeCurrency,
  normalizeDate,
  normalizeTime,
  occurredAtFor,
} from "../../src/modules/ai/capture/normalize.js";
import { extracted, extraction } from "../fixtures/ai/fake-provider.js";

const today = "2026-09-26";

describe("field normalisation", () => {
  it("maps currency symbols and words to ISO codes", () => {
    expect(normalizeCurrency("৳")).toBe("BDT");
    expect(normalizeCurrency("Tk")).toBe("BDT");
    expect(normalizeCurrency("TK.")).toBe("BDT");
    expect(normalizeCurrency("টাকা")).toBe("BDT");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency("US$")).toBe("USD");
    expect(normalizeCurrency("€")).toBe("EUR");
    expect(normalizeCurrency("inr")).toBe("INR");
    expect(normalizeCurrency("sgd")).toBe("SGD");
    expect(normalizeCurrency("??")).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });

  it("turns major units into minor units and rejects unusable amounts", () => {
    expect(amountToMinor(1250.5, "BDT")).toBe(125_050);
    expect(amountToMinor(0.1 + 0.2, "USD")).toBe(30);
    expect(amountToMinor(-20, "USD")).toBe(2_000);
    expect(amountToMinor(1500, "JPY")).toBe(1_500);
    expect(amountToMinor(0, "BDT")).toBeNull();
    expect(amountToMinor(null, "BDT")).toBeNull();
    expect(amountToMinor(Number.NaN, "BDT")).toBeNull();
  });

  it("reads day-first dates and 12-hour times", () => {
    expect(normalizeDate("2026-09-05")).toBe("2026-09-05");
    expect(normalizeDate("05/09/2026")).toBe("2026-09-05");
    expect(normalizeDate("5 Sep 2026")).toBe("2026-09-05");
    expect(normalizeDate("31/02/2026")).toBeNull();
    expect(normalizeTime("1:45 pm")).toBe("13:45");
    expect(normalizeTime("12:05 AM")).toBe("00:05");
    expect(normalizeTime("23:59:10")).toBe("23:59");
    expect(normalizeTime("25:00")).toBeNull();
    expect(occurredAtFor("2026-09-25", "13:45", "Asia/Dhaka")).toBe("2026-09-25T07:45:00.000Z");
    expect(occurredAtFor("2026-09-25", null, "Asia/Dhaka")).toBeNull();
  });

  it("keeps type and direction consistent", () => {
    expect(mapType("income", "out")).toEqual({
      type: "income",
      direction: "in",
    });
    expect(mapType("refund", "in")).toEqual({
      type: "refund",
      direction: "in",
    });
    expect(mapType("unknown", "out")).toEqual({ type: null, direction: "out" });
  });
});

describe("extraction mapping", () => {
  it("normalises every transaction and keeps per-field confidence honest", () => {
    const output = extraction([
      extracted({
        amount: 1250,
        currency: "USD",
        date: "2026-09-25",
        paymentMethod: "bkash",
        merchant: "Star Kabab",
        time: "13:45",
        confidence: { currency: 0.4 },
      }),
      extracted({
        amount: 30,
        currency: null,
        date: "2027-01-01",
        merchant: null,
      }),
      extracted({ amount: null, date: null }),
    ]);
    const [wallet, future, unreadable] = candidatesFromExtraction(output, {
      baseCurrency: "BDT",
      today,
    });
    // bKash only moves taka, whatever the model read.
    expect(wallet).toMatchObject({
      currency: "BDT",
      amount: 125_000,
      time: "13:45",
      paymentMethod: "bkash",
    });
    expect(wallet?.confidence.currency).toBe(0.95);
    expect(wallet?.notes[0]).toMatch(/bkash payments are in BDT/);
    // No currency printed: the base currency, at a confidence that forces a check.
    expect(future).toMatchObject({ currency: "BDT", amount: 3_000 });
    expect(future?.confidence.currency).toBe(0.4);
    // A date in the future is suspicious.
    expect(future?.confidence.date).toBeLessThanOrEqual(0.4);
    expect(future?.confidence.merchant).toBe(0);
    expect(unreadable).toMatchObject({ amount: null, date: null });
    expect(unreadable?.confidence.amount).toBe(0);
    expect(unreadable?.confidence.date).toBe(0);
  });

  it("lets the parser fill what the model left empty in a note", () => {
    const text = "Paid 500 tk to Rahim yesterday TrxID AB12CD34EF";
    const parser = candidateFromParsed(parseEntry(text, { today }), text);
    const [model] = candidatesFromExtraction(
      extraction([
        extracted({
          amount: null,
          merchant: "Rahim",
          date: null,
          reference: null,
        }),
      ]),
      { baseCurrency: "BDT", today },
    );
    const merged = mergeParserIntoAi(model as NonNullable<typeof model>, parser);
    expect(merged).toMatchObject({
      amount: 50_000,
      date: "2026-09-25",
      reference: "AB12CD34EF",
      merchant: "Rahim",
    });
    expect(merged.sources).toMatchObject({
      amount: "parser",
      date: "parser",
      reference: "parser",
    });
  });
});

describe("subscriptions", () => {
  it("recognises a known provider only together with billing language", () => {
    expect(detectSubscriptionHint("Netflix", "Netflix Standard monthly")).toEqual({ provider: "Netflix", billingCycle: "monthly" });
    expect(detectSubscriptionHint("OPENAI *CHATGPT SUBSCR", "ChatGPT Plus subscription renews")).toEqual({ provider: "OpenAI", billingCycle: null });
    expect(detectSubscriptionHint("Netflix", "gift card")).toBeNull();
    expect(detectSubscriptionHint("Star Kabab", "monthly dinner")).toBeNull();
  });

  it("uses printed dates and flags an estimated renewal", () => {
    const candidates = candidatesFromExtraction(
      extraction([
        extracted({
          amount: 20,
          currency: "USD",
          date: "2026-06-10",
          merchant: "OpenAI",
        }),
      ]),
      { baseCurrency: "BDT", today },
    );
    const printed = buildSubscriptionSuggestion(
      {
        ...extraction([]).subscription,
        isSubscription: true,
        provider: "ChatGPT",
        plan: "Plus",
        billingCycle: "monthly",
        renewalDate: "10/10/2026",
        autoRenew: "yes",
        renewalAmount: 20,
        renewalCurrency: "$",
        confidence: 0.9,
      },
      candidates,
      { text: "", today },
    );
    expect(printed).toMatchObject({
      provider: "ChatGPT",
      planName: "Plus",
      nextRenewalDate: "2026-10-10",
      renewalDateEstimated: false,
      autoRenew: true,
      renewalAmount: 2_000,
      currency: "USD",
      source: "ai",
    });

    const estimated = buildSubscriptionSuggestion(
      {
        ...extraction([]).subscription,
        isSubscription: true,
        provider: "ChatGPT",
        billingCycle: "monthly",
      },
      candidates,
      { text: "", today },
    );
    // Purchased 10 June, monthly: the next renewal after today, marked as an estimate.
    expect(estimated).toMatchObject({
      purchaseDate: "2026-06-10",
      nextRenewalDate: "2026-10-10",
      renewalDateEstimated: true,
      autoRenew: null,
    });
  });
});

describe("account inference", () => {
  const account = (id: string, kind: string, provider: string | null, name: string, mask: string | null = null) =>
    ({ id, kind, provider, name, mask }) as unknown as Parameters<typeof accountsForMethod>[0][number];
  const accounts = [
    account("a1", "mobile_wallet", "bkash", "bKash personal"),
    account("a2", "card", null, "City Visa", "4821"),
    account("a3", "card", null, "EBL Master", "1111"),
    account("a4", "cash", null, "Cash"),
  ];

  it("matches a wallet by provider, a card by its last digits, and reports ambiguity", () => {
    expect(accountsForMethod(accounts, "bkash", null)).toMatchObject({
      matches: [{ id: "a1" }],
      exact: true,
    });
    expect(accountsForMethod(accounts, "card", "4821")).toMatchObject({
      matches: [{ id: "a2" }],
      exact: true,
    });
    expect(accountsForMethod(accounts, "card", null).matches.map((a) => a.id)).toEqual(["a2", "a3"]);
    expect(accountsForMethod(accounts, "nagad", null).matches).toEqual([]);
    expect(accountsForMethod(accounts, "unknown", null).matches).toEqual([]);
  });

  it("auto-posts only near-certain, unambiguous drafts", () => {
    const draft = {
      missing: [],
      duplicates: [],
      requireReview: false,
      suggestedWorkspace: null,
      input: { type: "expense" },
      confidence: {
        overall: 0.96,
        fields: {
          amount: 0.97,
          currency: 0.97,
          date: 0.96,
          type: 0.96,
          account: 0.95,
        },
      },
    } as unknown as ResolvedDraft;
    expect(DraftBuilder.autoPostable(draft)).toBe(true);
    expect(
      DraftBuilder.autoPostable({
        ...draft,
        confidence: {
          ...draft.confidence,
          fields: { ...draft.confidence.fields, date: 0.9 },
        },
      }),
    ).toBe(false);
    expect(DraftBuilder.autoPostable({ ...draft, missing: ["account"] })).toBe(false);
    expect(DraftBuilder.autoPostable({ ...draft, requireReview: true })).toBe(false);
  });
});
