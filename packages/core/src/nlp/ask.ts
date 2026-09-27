import { addDays, addMonths, type Day, endOfMonth, minDay, type Range, startOfMonth, startOfWeek, startOfYear } from "../dates.ts";
import { CATEGORY_KEYWORDS } from "./parse-entry.ts";

/**
 * What a finance question is about, read without a model. The copilot uses
 * this when AI is unavailable (and to suggest a period when it is): every
 * intent maps to one read-only query, so the answer is exact, never invented.
 */
export type AskIntent =
  | "spending"
  | "income"
  | "top_categories"
  | "top_merchants"
  | "compare"
  | "balance"
  | "net_worth"
  | "upcoming"
  | "subscriptions"
  | "budgets"
  | "forecast"
  | "receivables"
  | "liabilities"
  | "goals"
  | "projects"
  | "transactions"
  | "unknown";

export type ParsedQuestion = {
  intent: AskIntent;
  range: Range;
  /** A short phrase for the answer, in the question's language: "this month", "গত মাসে". */
  rangeLabel: string;
  /** False when no period was named and the intent's default was used. */
  rangeExplicit: boolean;
  /** A category named by keyword ("groceries", "বাজার"), as its default category name. */
  categoryHint: string | null;
  /** Forecast horizon in days, when asked ("next 60 days"). */
  horizonDays: number | null;
  language: "bn" | "en";
};

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";
const toLatinDigits = (text: string) => text.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));

// English words need word boundaries; Bangla ones cannot use \b (ASCII-only).
const INTENTS: Array<[AskIntent, RegExp]> = [
  ["net_worth", /\bnet ?worth\b|\bworth\b|নেট ওয়ার্থ|মোট সম্পদ|সম্পদ কত/i],
  ["forecast", /\b(forecast|projection|run out|enough (money|cash)|next (\d+ )?(days?|weeks?|months?)|end of (the )?month)\b|পূর্বাভাস|চলবে|টাকা থাকবে|শেষ হয়ে যাবে/i],
  ["receivables", /\b(owes? me|owed to me|receivables?|lent|collect|unpaid invoices?|outstanding invoices?)\b|পাওনা|পাবো|পাব|ধার দিয়েছি|ধার দিলাম|কে টাকা দেবে/i],
  ["liabilities", /\b(i owe|do i owe|debts?|loans?|liabilit(y|ies)|payables?|emi)\b|দেনা|ঋণ|লোন|ধার নিয়েছি|কিস্তি/i],
  ["subscriptions", /\bsubscriptions?\b|সাবস্ক্রিপশন/i],
  ["upcoming", /\b(upcoming|due|bills?|renew(al|als|s)?|next payments?|coming up|pay next)\b|সামনে|বকেয়া|বিল|রিনিউ|কবে দিতে হবে/i],
  ["budgets", /\b(budgets?|over ?spend(ing)?|overspent|limit)\b|বাজেট/i],
  ["goals", /\b(goals?|saving for|dream|target)\b|লক্ষ্য|স্বপ্ন|টার্গেট/i],
  [
    "balance",
    /\b(balances?|how much (money |cash )?(do )?i have|cash (on hand|left)|in (my )?accounts?|left in)\b|ব্যালেন্স|ব্যালান্স|কত টাকা আছে|হাতে কত|অ্যাকাউন্টে কত|টাকা আছে/i,
  ],
  ["compare", /\b(compare|compared|vs\.?|versus|than last|more than|less than|difference)\b|তুলনা|চেয়ে বেশি|চেয়ে কম/i],
  ["top_merchants", /\b(merchants?|vendors?|who (did )?i pay|paid the most|payees?|shops?)\b|কাকে সবচেয়ে বেশি|কোন দোকান/i],
  [
    "top_categories",
    /\b(where (does|did|is) (my )?money go|categor(y|ies)|biggest (expenses?|spend(ing)?)|breakdown|most on)\b|কোথায় খরচ|কোথায় যাচ্ছে|কোন খাতে|সবচেয়ে বেশি খরচ/i,
  ],
  ["projects", /\b(projects?|burn|runway|profit(able)?|margin)\b|প্রজেক্ট|প্রকল্প|লাভ|মুনাফা/i],
  ["income", /\b(income|earn(ed|ings)?|revenue|made|salary|sales)\b|আয়|আয়|ইনকাম|আয় করেছি|বেতন|বিক্রি/i],
  ["spending", /\b(spen[dt]|spending|expenses?|costs?|paid|pay for|kharach|khoroch)\b|খরচ|ব্যয়|ব্যয়|কত দিলাম/i],
  ["transactions", /\b(transactions?|show( me)?|list|recent|latest|last \d+ (payments|transactions))\b|লেনদেন|দেখাও/i],
];

const MONTH_NAMES: Array<[RegExp, number]> = [
  [/\bjan(uary)?\b|জানুয়ারি|জানুয়ারি/i, 1],
  [/\bfeb(ruary)?\b|ফেব্রুয়ারি|ফেব্রুয়ারি/i, 2],
  [/\bmar(ch)?\b|মার্চ/i, 3],
  [/\bapr(il)?\b|এপ্রিল/i, 4],
  [/\bmay\b|মে মাস/i, 5],
  [/\bjune?\b|জুন/i, 6],
  [/\bjuly?\b|জুলাই/i, 7],
  [/\baug(ust)?\b|আগস্ট|আগষ্ট/i, 8],
  [/\bsep(t|tember)?\b|সেপ্টেম্বর/i, 9],
  [/\boct(ober)?\b|অক্টোবর/i, 10],
  [/\bnov(ember)?\b|নভেম্বর/i, 11],
  [/\bdec(ember)?\b|ডিসেম্বর/i, 12],
];

type Period = { range: Range; en: string; bn: string };

function period(text: string, today: Day): Period | null {
  const t = toLatinDigits(text);
  const lastN = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(days?|weeks?|months?)\b|(?:গত|শেষ)\s*(\d{1,3})\s*(দিন|সপ্তাহ|মাস)/i);
  if (lastN) {
    const count = Math.max(1, Number(lastN[1] ?? lastN[3]));
    const unit = (lastN[2] ?? lastN[4] ?? "").toLowerCase();
    if (unit.startsWith("day") || unit === "দিন") {
      return { range: { from: addDays(today, -(count - 1)), to: today }, en: `the last ${count} days`, bn: `গত ${count} দিনে` };
    }
    if (unit.startsWith("week") || unit === "সপ্তাহ") {
      return { range: { from: addDays(today, -(count * 7 - 1)), to: today }, en: `the last ${count} weeks`, bn: `গত ${count} সপ্তাহে` };
    }
    return { range: { from: startOfMonth(addMonths(today, -(count - 1))), to: today }, en: `the last ${count} months`, bn: `গত ${count} মাসে` };
  }
  if (/\btoday\b|আজ|\baj(ke)?\b/i.test(t)) return { range: { from: today, to: today }, en: "today", bn: "আজ" };
  if (/\byesterday\b|গতকাল|\bgotokal\b/i.test(t)) {
    const y = addDays(today, -1);
    return { range: { from: y, to: y }, en: "yesterday", bn: "গতকাল" };
  }
  if (/\blast week\b|গত সপ্তাহ|\bgoto shoptah/i.test(t)) {
    const start = addDays(startOfWeek(today, 6), -7);
    return { range: { from: start, to: addDays(start, 6) }, en: "last week", bn: "গত সপ্তাহে" };
  }
  if (/\bthis week\b|এই সপ্তাহ|\bei shoptah/i.test(t)) {
    return { range: { from: startOfWeek(today, 6), to: today }, en: "this week", bn: "এই সপ্তাহে" };
  }
  if (/\blast month\b|\bprevious month\b|গত মাস|\bgoto ?mash?e?\b/i.test(t)) {
    const start = addMonths(startOfMonth(today), -1);
    return { range: { from: start, to: endOfMonth(start) }, en: "last month", bn: "গত মাসে" };
  }
  if (/\bthis month\b|এই মাস|\bei ?mash?e?\b/i.test(t)) {
    return { range: { from: startOfMonth(today), to: today }, en: "this month", bn: "এই মাসে" };
  }
  if (/\blast year\b|গত বছর|\bgoto bochor/i.test(t)) {
    const start = addMonths(startOfYear(today), -12);
    return { range: { from: start, to: addDays(startOfYear(today), -1) }, en: "last year", bn: "গত বছর" };
  }
  if (/\bthis year\b|\byear to date\b|\bytd\b|এই বছর|\bei bochor/i.test(t)) {
    return { range: { from: startOfYear(today), to: today }, en: "this year", bn: "এই বছর" };
  }
  for (const [pattern, month] of MONTH_NAMES) {
    if (!pattern.test(t)) continue;
    const year = t.match(/\b(20\d{2})\b/)?.[1];
    const currentYear = Number(today.slice(0, 4));
    // Without a year, the most recent such month that has started.
    let y = year ? Number(year) : currentYear;
    if (!year && month > Number(today.slice(5, 7))) y -= 1;
    const from = `${y}-${String(month).padStart(2, "0")}-01`;
    const name = new Date(`${from}T00:00:00Z`).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
    return { range: { from, to: minDay(endOfMonth(from), today) }, en: `${name} ${y}`, bn: `${name} ${y}` };
  }
  return null;
}

function horizon(text: string): number | null {
  const t = toLatinDigits(text);
  const match = t.match(/\bnext\s+(\d{1,3})\s+(days?|weeks?|months?)\b|(?:আগামী|সামনের)\s*(\d{1,3})\s*(দিন|সপ্তাহ|মাস)/i);
  if (match) {
    const count = Number(match[1] ?? match[3]);
    const unit = (match[2] ?? match[4] ?? "").toLowerCase();
    const days = unit.startsWith("day") || unit === "দিন" ? count : unit.startsWith("week") || unit === "সপ্তাহ" ? count * 7 : count * 30;
    return Math.min(365, Math.max(1, days));
  }
  if (/\bnext month\b|আগামী মাস|সামনের মাস/i.test(t)) return 30;
  if (/\bend of (the )?month\b|মাস শেষে|মাসের শেষ/i.test(t)) return null;
  return null;
}

export function parseQuestion(text: string, today: Day): ParsedQuestion {
  const language = /[ঀ-৿]/.test(text) ? "bn" : "en";
  const intent = INTENTS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
  const named = period(text, today);
  const fallback: Period = { range: { from: startOfMonth(today), to: today }, en: "this month", bn: "এই মাসে" };
  const chosen = named ?? fallback;
  const categoryHint = CATEGORY_KEYWORDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  let horizonDays = horizon(text);
  if (intent === "forecast" && horizonDays === null && /\bend of (the )?month\b|মাস শেষে|মাসের শেষ/i.test(text)) {
    horizonDays = Math.max(1, Number(endOfMonth(today).slice(8)) - Number(today.slice(8)));
  }
  return {
    // "How much on groceries?" names a category without a verb: that is spending.
    intent: intent === "unknown" && categoryHint ? "spending" : intent,
    range: chosen.range,
    rangeLabel: language === "bn" ? chosen.bn : chosen.en,
    rangeExplicit: named !== null,
    categoryHint,
    horizonDays,
    language,
  };
}
