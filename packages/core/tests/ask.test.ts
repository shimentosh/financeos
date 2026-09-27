import { describe, expect, it } from "vitest";
import { parseQuestion } from "../src/index.ts";

const today = "2026-09-26";

describe("copilot questions", () => {
  it("reads English spending questions with a period and a category", () => {
    const q = parseQuestion("How much did I spend on groceries last month?", today);
    expect(q).toMatchObject({ intent: "spending", categoryHint: "Groceries", rangeExplicit: true, language: "en", rangeLabel: "last month" });
    expect(q.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("reads Bangla and Bangla digits", () => {
    const q = parseQuestion("এই মাসে খাবারে কত খরচ হলো?", today);
    expect(q).toMatchObject({ intent: "spending", categoryHint: "Restaurants", language: "bn", rangeLabel: "এই মাসে" });
    expect(q.range).toEqual({ from: "2026-09-01", to: today });
    expect(parseQuestion("গত ৭ দিনে কত খরচ করেছি", today).range).toEqual({ from: "2026-09-20", to: today });
  });

  it("recognises the non-spending intents", () => {
    expect(parseQuestion("What's my net worth?", today).intent).toBe("net_worth");
    expect(parseQuestion("আমার বিকাশে কত টাকা আছে?", today).intent).toBe("balance");
    expect(parseQuestion("Which bills are due this week?", today).intent).toBe("upcoming");
    expect(parseQuestion("How much am I paying for subscriptions?", today).intent).toBe("subscriptions");
    expect(parseQuestion("Am I over budget?", today).intent).toBe("budgets");
    expect(parseQuestion("Will I have enough cash for the next 60 days?", today)).toMatchObject({ intent: "forecast", horizonDays: 60 });
    expect(parseQuestion("Who owes me money?", today).intent).toBe("receivables");
    expect(parseQuestion("আমার দেনা কত?", today).intent).toBe("liabilities");
    expect(parseQuestion("How are my goals going?", today).intent).toBe("goals");
    expect(parseQuestion("Where does my money go?", today).intent).toBe("top_categories");
    expect(parseQuestion("Compare this month with last month", today).intent).toBe("compare");
    expect(parseQuestion("What did I earn this year?", today)).toMatchObject({ intent: "income", range: { from: "2026-01-01", to: today } });
    expect(parseQuestion("Is ClipMesh profitable?", today).intent).toBe("projects");
  });

  it("resolves a month name to the latest one that has started", () => {
    expect(parseQuestion("spending in March", today).range).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(parseQuestion("spending in December", today).range).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(parseQuestion("spending in September", today).range).toEqual({ from: "2026-09-01", to: today });
  });

  it("defaults to this month and says so", () => {
    const q = parseQuestion("How much did I spend?", today);
    expect(q).toMatchObject({ rangeExplicit: false, rangeLabel: "this month" });
    expect(parseQuestion("hello there", today).intent).toBe("unknown");
  });
});
