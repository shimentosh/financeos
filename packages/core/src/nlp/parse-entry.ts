import type { Direction, TransactionType, WorkspaceKind } from "../constants.ts";
import { addDays, type Day, parseDay } from "../dates.ts";
import { currencyDecimals, normalizeDigits, roundHalfAwayFromZero } from "../money.ts";
import { normalizeName } from "../text.ts";

export type ParsedEntry = {
  type: TransactionType;
  direction: Direction;
  amount: number | null;
  currency: string;
  date: Day;
  merchant: string | null;
  description: string;
  /** The category *name* hint; resolved to an id by the caller. */
  categoryHint: string | null;
  accountHint: string | null;
  projectHint: string | null;
  workspaceHint: WorkspaceKind | null;
  /** A wallet/bank transaction id found in the text (bKash TrxID, "Ref: ..."). */
  reference: string | null;
  /**
   * Where the date came from: a relative word ("yesterday"), an explicit date,
   * or nothing at all (`default`: today is assumed and must be confirmed).
   */
  dateSource: "relative" | "explicit" | "default";
  confidence: {
    amount: number;
    type: number;
    date: number;
    category: number;
  };
  /** What still has to be asked, in order of importance. */
  missing: Array<"amount" | "category" | "account">;
};

// Multipliers in English, Banglish and Bangla.
const MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(k|thousand|hajar|hazar|হাজার)$/i, 1_000],
  [/^(lakh|lac|lakhs|lacs|লাখ|লক্ষ)$/i, 100_000],
  [/^(crore|cr|কোটি)$/i, 10_000_000],
  [/^(m|million|mn)$/i, 1_000_000],
];

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/(৳|tk\.?|taka|টাকা|টাকার|bdt)/i, "BDT"],
  [/(\$|usd|dollar|ডলার)/i, "USD"],
  [/(€|eur|euro)/i, "EUR"],
  [/(£|gbp|pound)/i, "GBP"],
  [/(₹|inr|rupee|রুপি)/i, "INR"],
];

// English keywords need word boundaries ("pay" must not match "Payoneer");
// Bangla ones cannot use \b, which is ASCII-only in JavaScript.
const INCOME_WORDS =
  /\b(salary|payment received|received|got paid|earned|income|revenue|invoice paid|client paid|refund received)\b|বেতন|পেলাম|পেয়েছি|আয়|পাইলাম|ইনকাম|জমা হলো/i;
const EXPENSE_WORDS = /\b(bought|buy|paid|pay|spent|spend|purchased?|bill|expense)\b|কিনলাম|কিনেছি|দিলাম|দিয়েছি|খরচ|বিল|ভাড়া দিলাম|পরিশোধ/i;
const TRANSFER_WORDS = /(transfer|transferred|moved|sent to my|cash out|cashout|ট্রান্সফার|পাঠালাম নিজের|ক্যাশ আউট)/i;
const LOAN_GIVEN = /(lent|loan to|ধার দিলাম|ধার দিয়েছি)/i;
const LOAN_TAKEN = /(borrowed|loan from|ধার নিলাম|ধার নিয়েছি)/i;
const INVEST_WORDS = /(invested|investment|sanchayapatra|savings certificate|fdr|dps|shares?|stock|সঞ্চয়পত্র|বিনিয়োগ|ইনভেস্ট)/i;
const BUSINESS_WORDS = /(business|company|office|client|project|অফিস|ব্যবসা|কোম্পানি|বিজনেস)/i;
const PERSONAL_WORDS = /(personal|family|home|house|বাসা|বাড়ি|পরিবার|নিজের)/i;

/** Keywords that point at a category name, most specific first. */
export const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/(openai|chatgpt|claude|anthropic|gemini|midjourney|perplexity|cursor|copilot|ai api|api credit)/i, "AI & APIs"],
  [/(aws|amazon web services|gcp|google cloud|azure|vercel|netlify|digitalocean|hetzner|cloudflare|hosting|server|vps|domain)/i, "Hosting"],
  [/(figma|notion|slack|github|jira|linear|adobe|canva|zoom|google workspace|microsoft 365|software|saas|license)/i, "Software"],
  [/(facebook ads?|meta ads?|google ads?|boosting|boost|advertis|বিজ্ঞাপন)/i, "Advertising"],
  [/(monitor|laptop|macbook|keyboard|mouse|computer|pc|headphone|ipad|equipment|chair|desk)/i, "Equipment"],
  [/(contractor|freelancer|fiverr|upwork)/i, "Contractors"],
  [/(netflix|spotify|youtube premium|hoichoi|chorki|toffee|prime video|disney|subscription)/i, "Subscriptions"],
  [/(bazar|bajar|বাজার|grocery|groceries|shwapno|স্বপ্ন|meena bazar|agora|chaldal|unimart|vegetable|সবজি|মাছ|মাংস)/i, "Groceries"],
  [/(restaurant|lunch|dinner|breakfast|food|foodpanda|pathao food|coffee|cafe|pizza|burger|biryani|খাবার|খেলাম|রেস্টুরেন্ট|নাস্তা)/i, "Restaurants"],
  [/(uber|pathao|obhai|rickshaw|রিকশা|cng|সিএনজি|bus|বাস|taxi|ride|fuel|petrol|octane|diesel|তেল|ভাড়া গাড়ি|metro|মেট্রো|parking)/i, "Transport"],
  [/(electricity|desco|dpdc|palli bidyut|বিদ্যুৎ|কারেন্ট বিল)/i, "Electricity"],
  [/(gas bill|titas|গ্যাস)/i, "Gas"],
  [/(water bill|wasa|পানির বিল)/i, "Water"],
  [/(internet|wifi|broadband|link3|carnival|amber it|ইন্টারনেট)/i, "Internet"],
  [/(recharge|mobile bill|grameenphone|robi|banglalink|teletalk|airtel|রিচার্জ|মোবাইল বিল)/i, "Mobile"],
  [/(rent|house rent|বাসা ভাড়া|ভাড়া)/i, "Rent"],
  [/(doctor|hospital|medicine|pharmacy|clinic|ঔষধ|ওষুধ|ডাক্তার|হাসপাতাল)/i, "Health"],
  [/(school|tuition|coaching|course|university|college|books?|স্কুল|টিউশন|কোর্স|বই)/i, "Education"],
  [/(clothes|shirt|shoes|dress|aarong|daraz|shopping|জামা|কাপড়|জুতা|শপিং)/i, "Shopping"],
  [/(movie|cinema|concert|game|entertainment|সিনেমা)/i, "Entertainment"],
  [/(flight|hotel|trip|travel|tour|cox'?s bazar|ভ্রমণ|ট্যুর|হোটেল)/i, "Travel"],
  [/(parents|mother|father|ammu|abbu|আম্মু|আব্বু|মা কে|বাবা কে|family support|বাড়িতে পাঠালাম)/i, "Family support"],
  [/(zakat|charity|donation|sadaqah|যাকাত|দান|সদকা)/i, "Charity"],
  [/(salary|বেতন)/i, "Salary"],
  [/(freelanc|upwork payout|fiverr payout)/i, "Freelance"],
  [/(interest|profit|dividend|মুনাফা|সুদ)/i, "Investment income"],
];

const ACCOUNT_KEYWORDS: Array<[RegExp, string]> = [
  [/(bkash|bKash|বিকাশ)/i, "bkash"],
  [/(nagad|নগদ)/i, "nagad"],
  [/(rocket|রকেট)/i, "rocket"],
  [/(upay)/i, "upay"],
  [/(cash|নগদ টাকা|হাতে)/i, "cash"],
  [/(card|visa|mastercard|amex|কার্ড)/i, "card"],
  [/(bank|ব্যাংক)/i, "bank"],
  [/(paypal)/i, "paypal"],
  [/(payoneer)/i, "payoneer"],
  [/(wise)/i, "wise"],
];

// A currency word right before or after a number marks it as money:
// "Tk 1,250.00", "1200 tk", "৫০০ টাকা".
const CURRENCY_BEFORE = /(?:tk\.?|taka|bdt|usd|us\$|inr|rs\.?|eur|gbp)\s*:?\s*$/i;
const CURRENCY_AFTER = /^\s*(?:tk\b|tk\.|taka|টাকা|bdt\b|usd\b|dollars?\b|ডলার|inr\b|rupees?\b|eur\b|euros?\b|gbp\b)/iu;
// Figures that are not the amount paid: a wallet SMS lists the balance and
// the fee next to the payment ("Fee Tk 0.00. Balance Tk 3,750.00").
const NOT_THE_AMOUNT =
  /(?:balance|bal\.?|fee|charges?|vat|available|avail\.?|limit|ব্যালেন্স|ব্যালান্স|চার্জ|ফি)\s*[:-]?\s*(?:is\s*)?(?:tk\.?|taka|bdt|৳|\$|usd)?\s*[:-]?\s*$/iu;

/**
 * Finds the amount: "15 হাজার", "১৫,০০০", "15k", "1.5 lakh", "৳500", "$20",
 * "Tk 1,250.00". Balances and fees quoted next to it are skipped.
 * Returns major units.
 */
export function extractAmount(text: string): { value: number; raw: string } | null {
  const normalized = normalizeDigits(text);
  // A lookahead instead of \b after the unit: \b does not see Bangla letters.
  const pattern =
    /(?:[৳$€£₹]\s*)?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|thousand|hajar|hazar|হাজার|lakh|lac|lakhs|lacs|লাখ|লক্ষ|crore|cr|কোটি|million|mn|m)(?![\p{L}\p{M}\p{N}]))?/giu;
  let best: { value: number; raw: string } | null = null;
  for (const match of normalized.matchAll(pattern)) {
    const digits = (match[1] ?? "").replace(/,/g, "");
    let value = Number(digits);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = match[2];
    if (unit) {
      const multiplier = MULTIPLIERS.find(([re]) => re.test(unit))?.[1];
      if (multiplier) value *= multiplier;
    }
    const raw = match[0];
    const start = match.index ?? 0;
    const before = normalized.slice(Math.max(0, start - 28), start);
    const after = normalized.slice(start + raw.length, start + raw.length + 12);
    if (NOT_THE_AMOUNT.test(before)) continue;
    // Skip what are clearly dates or years ("2026", "26/09") unless marked as money.
    const marked = /[৳$€£₹]/.test(raw) || Boolean(unit) || CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after);
    if (!marked && /^(19|20)\d{2}$/.test(digits)) continue;
    // Part of a date or a time ("26/09/2026", "13:45") is not an amount.
    if (!marked && (/[/:.-]$/.test(before) || /^[/:-]\d/.test(after))) continue;
    if (!best || marked || value > best.value) {
      best = { value, raw };
      if (marked) break;
    }
  }
  return best;
}

function detectCurrency(text: string, fallback: string): string {
  for (const [pattern, code] of CURRENCY_WORDS) if (pattern.test(text)) return code;
  return fallback;
}

function detectDate(text: string, today: Day): { date: Day; confidence: number; source: ParsedEntry["dateSource"] } {
  const lower = text.toLowerCase();
  if (/(পরশু|day before yesterday)/i.test(lower)) return { date: addDays(today, -2), confidence: 0.95, source: "relative" };
  if (/(গতকাল|yesterday|kal raat|গত রাতে)/i.test(lower)) return { date: addDays(today, -1), confidence: 0.95, source: "relative" };
  const explicit = normalizeDigits(text).match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/);
  if (explicit?.[1]) {
    const parsed = parseDay(explicit[1]);
    if (parsed) return { date: parsed, confidence: 0.9, source: "explicit" };
  }
  // "aj" only as a word: "Raj " must not read as "today".
  if (/(আজ|আজকে|\btoday\b|\bajke\b|(?:^|\s)aj\s)/i.test(lower)) return { date: today, confidence: 0.98, source: "relative" };
  return { date: today, confidence: 0.6, source: "default" };
}

// "TrxID BGH7K2L9QX", "Txn ID: 8A1B2C3D", "Ref no. 123456789".
const REFERENCE_PATTERN =
  /\b(?:trx\s*id|trxid|txn\s*id|txnid|transaction\s*id|trans(?:action)?\s*ref(?:erence)?|ref(?:erence)?(?:\s*(?:no\.?|number|#))?)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{5,24})\b/gi;

/** The wallet or bank's own id for the transaction, when the text quotes one. */
export function extractReference(text: string): string | null {
  for (const match of normalizeDigits(text).matchAll(REFERENCE_PATTERN)) {
    const value = match[1] ?? "";
    if (/\d/.test(value)) return value;
  }
  return null;
}

function detectType(text: string): { type: TransactionType; direction: Direction; confidence: number } {
  if (LOAN_GIVEN.test(text)) return { type: "loan", direction: "out", confidence: 0.85 };
  if (LOAN_TAKEN.test(text)) return { type: "loan", direction: "in", confidence: 0.85 };
  if (TRANSFER_WORDS.test(text)) return { type: "transfer", direction: "out", confidence: 0.75 };
  if (INVEST_WORDS.test(text) && !/(interest|profit|dividend|মুনাফা)/i.test(text)) {
    return { type: "investment", direction: "out", confidence: 0.7 };
  }
  if (/refund|রিফান্ড/i.test(text)) return { type: "refund", direction: "in", confidence: 0.8 };
  const income = INCOME_WORDS.test(text);
  const expense = EXPENSE_WORDS.test(text);
  if (income && !expense) return { type: "income", direction: "in", confidence: 0.85 };
  if (expense && !income) return { type: "expense", direction: "out", confidence: 0.9 };
  if (income && expense) return { type: "expense", direction: "out", confidence: 0.5 };
  return { type: "expense", direction: "out", confidence: 0.55 };
}

function detectCategory(text: string, type: TransactionType): { name: string | null; confidence: number } {
  for (const [pattern, name] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) {
      const incomeCategory = ["Salary", "Freelance", "Investment income"].includes(name);
      if (type === "income" && !incomeCategory) continue;
      if (type === "expense" && incomeCategory) continue;
      return { name, confidence: 0.8 };
    }
  }
  return { name: null, confidence: 0 };
}

/**
 * A merchant or subject: a capitalised word, or text after "at/from/to" or
 * Bangla postpositions. Kept short; the caller treats it as a hint.
 */
const NAME_STOP_WORDS =
  /^(I|Today|Yesterday|Paid|Bought|Got|Received|You|Your|Fee|Balance|Tk|TK|BDT|TrxID|TxnID|Ref|Reference|On|At|For|Via|By|With|The|A|An)$/;

function detectMerchant(text: string): string | null {
  // A dot belongs to a name only inside it ("Claude.ai"), not at a sentence end.
  const english = text.match(/\b(?:at|from|to|on)\s+([A-Z][\w&'-]*(?:\.[A-Za-z0-9]+)*(?:\s+[A-Z][\w&'-]*(?:\.[A-Za-z0-9]+)*){0,3})/);
  const words = english?.[1]?.trim().split(/\s+/) ?? [];
  // "to Star Kabab Today", "to Rahim TrxID ...": trailing words that are not part of the name go.
  while (words.length > 1 && NAME_STOP_WORDS.test(words[words.length - 1] ?? "")) words.pop();
  if (words.length && !NAME_STOP_WORDS.test(words[0] ?? "")) return words.join(" ");
  const brand = text.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\b/);
  if (brand?.[1] && !NAME_STOP_WORDS.test(brand[1].split(" ")[0] ?? "")) return brand[1];
  return null;
}

export function parseEntry(
  text: string,
  options: {
    today: Day;
    defaultCurrency?: string;
    /** Names of projects in the business workspace, for "for ClipMesh". */
    projects?: string[];
  },
): ParsedEntry {
  const input = text.trim();
  const amountMatch = extractAmount(input);
  const currency = detectCurrency(input, options.defaultCurrency ?? "BDT");
  const { date, confidence: dateConfidence, source: dateSource } = detectDate(input, options.today);
  const { type, direction, confidence: typeConfidence } = detectType(input);
  const category = detectCategory(input, type);
  const account = ACCOUNT_KEYWORDS.find(([pattern]) => pattern.test(input))?.[1] ?? null;
  const project = options.projects?.find((name) => normalizeName(input).includes(normalizeName(name))) ?? null;
  const workspaceHint: WorkspaceKind | null = project || BUSINESS_WORDS.test(input) ? "business" : PERSONAL_WORDS.test(input) ? "personal" : null;

  const amount = amountMatch ? roundHalfAwayFromZero(amountMatch.value * 10 ** currencyDecimals(currency)) : null;
  const missing: ParsedEntry["missing"] = [];
  if (amount === null) missing.push("amount");
  if (!category.name && (type === "expense" || type === "income")) missing.push("category");
  if (!account) missing.push("account");

  return {
    type,
    direction,
    amount,
    currency,
    date,
    merchant: detectMerchant(input),
    description: input,
    categoryHint: category.name,
    accountHint: account,
    projectHint: project,
    workspaceHint,
    reference: extractReference(input),
    dateSource,
    confidence: {
      amount: amount === null ? 0 : amountMatch && /[৳$€£₹]|টাকা|taka|tk/i.test(input) ? 0.97 : 0.85,
      type: typeConfidence,
      date: dateConfidence,
      category: category.confidence,
    },
    missing,
  };
}
