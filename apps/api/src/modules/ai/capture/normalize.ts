import {
  addMonths,
  addYears,
  type Day,
  diffDays,
  isDay,
  isDirectionAllowed,
  type ParsedEntry,
  parseDay,
  type TransactionType,
  TYPE_RULES,
  toMinor,
} from "@expensewise/core";
import type { BillingCycle, SubscriptionSuggestion } from "@expensewise/core/contracts/ai-extra";
import type { ExtractionOutput, PaymentMethod } from "../gateway/schemas.js";

// Pure mapping from what a model or the parser read to values the ledger can
// hold: ISO currency, YYYY-MM-DD, minor units, a transaction type. Every
// function keeps uncertainty visible (a lower confidence, a note) instead of
// hiding it.

export type CandidateField =
  | "amount"
  | "currency"
  | "date"
  | "time"
  | "merchant"
  | "reference"
  | "type"
  | "paymentMethod"
  | "category"
  | "project"
  | "workspace";

export type CandidateType = Exclude<TransactionType, "adjustment" | "asset_purchase" | "equity">;

/** One transaction as read from a capture, normalised but not yet matched to the workspace. */
export type Candidate = {
  index: number;
  amount: number | null;
  currency: string;
  date: Day | null;
  time: string | null;
  merchant: string | null;
  reference: string | null;
  paymentMethod: PaymentMethod | null;
  cardLast4: string | null;
  type: CandidateType | null;
  direction: "in" | "out" | null;
  description: string | null;
  fee: number | null;
  lineItems: Array<{
    description: string;
    amount: number | null;
    quantity: number | null;
  }>;
  categoryName: string | null;
  projectName: string | null;
  workspaceHint: "personal" | "business" | null;
  confidence: Record<CandidateField, number>;
  sources: Partial<Record<CandidateField, "ai" | "parser">>;
  notes: string[];
};

export const clamp01 = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 : 0;

const WALLETS = new Set<PaymentMethod>(["bkash", "nagad", "rocket", "upay"]);

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/^(৳|tk\.?|taka|টাকা|bdt)$/i, "BDT"],
  [/^(\$|us\$|usd|us ?dollars?|dollars?)$/i, "USD"],
  [/^(€|eur|euros?)$/i, "EUR"],
  [/^(£|gbp|pounds?)$/i, "GBP"],
  [/^(₹|inr|rs\.?|rupees?)$/i, "INR"],
  [/^(ca\$|c\$|cad)$/i, "CAD"],
  [/^(a\$|au\$|aud)$/i, "AUD"],
  [/^(s\$|sgd)$/i, "SGD"],
  [/^(aed|dhs?|dirhams?)$/i, "AED"],
  [/^(sar|riyals?)$/i, "SAR"],
  [/^(rm|myr|ringgit)$/i, "MYR"],
  [/^(¥|jpy|yen)$/i, "JPY"],
];

/** "৳", "Tk", "taka" → BDT; "$" → USD; any 3-letter code upper-cased. Null when unrecognisable. */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  for (const [pattern, code] of CURRENCY_WORDS) if (pattern.test(text)) return code;
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase();
  return null;
}

/** A positive amount in major units to minor units of `currency`; null for anything unusable. */
export function amountToMinor(amount: number | null | undefined, currency: string): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount === 0) return null;
  const minor = toMinor(Math.abs(amount), currency);
  return minor > 0 && minor <= Number.MAX_SAFE_INTEGER ? minor : null;
}

/** A date as the model wrote it to a day; day-first when ambiguous. */
export function normalizeDate(raw: string | null | undefined): Day | null {
  if (!raw) return null;
  const text = raw.trim();
  if (isDay(text)) return text;
  return parseDay(text);
}

/** "1:45 pm" / "13:45:10" → "13:45". */
export function normalizeTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The UTC offset of a timezone at a moment, as "+06:00". */
function offsetFor(date: Day, time: string, timeZone: string): string {
  try {
    const probe = new Date(`${date}T${time}:00Z`);
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(probe)
      .find((part) => part.type === "timeZoneName")?.value;
    const match = name?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!match) return "+00:00";
    return `${match[1]}${String(match[2]).padStart(2, "0")}:${match[3] ?? "00"}`;
  } catch {
    return "+00:00";
  }
}

/** A local date and time in the workspace's timezone as an ISO instant. */
export function occurredAtFor(date: Day | null, time: string | null, timeZone: string): string | null {
  if (!date || !time) return null;
  const instant = new Date(`${date}T${time}:00${offsetFor(date, time, timeZone)}`);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/** A type and a direction the ledger accepts; the direction follows the type when they disagree. */
export function mapType(type: string | null | undefined, direction: string | null | undefined): { type: CandidateType | null; direction: "in" | "out" | null } {
  const known: CandidateType[] = ["expense", "income", "transfer", "refund", "investment", "debt_payment", "loan"];
  const mapped = known.includes(type as CandidateType) ? (type as CandidateType) : null;
  let dir: "in" | "out" | null = direction === "in" || direction === "out" ? direction : null;
  if (mapped && (!dir || !isDirectionAllowed(mapped, dir))) dir = TYPE_RULES[mapped].defaultDirection;
  return { type: mapped, direction: dir };
}

const ACCOUNT_HINTS: Record<string, PaymentMethod> = {
  bkash: "bkash",
  nagad: "nagad",
  rocket: "rocket",
  upay: "upay",
  cash: "cash",
  card: "card",
  bank: "bank",
  paypal: "paypal",
  payoneer: "payoneer",
  wise: "wise",
};

function trimTo(text: string | null | undefined, length: number): string | null {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) return null;
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

/**
 * Currency with its confidence. Mobile wallets in Bangladesh only move taka;
 * a missing currency falls back to the base currency at low confidence, so
 * it is always shown for confirmation.
 */
function resolveCurrency(raw: string | null, rawConfidence: number, method: PaymentMethod | null, baseCurrency: string, notes: string[]) {
  const code = normalizeCurrency(raw);
  if (method && WALLETS.has(method)) {
    if (code && code !== "BDT") notes.push(`${method} payments are in BDT; the ${code} reading was ignored.`);
    return {
      currency: "BDT",
      confidence: Math.max(clamp01(rawConfidence), 0.95),
    };
  }
  if (code) return { currency: code, confidence: clamp01(rawConfidence) || 0.5 };
  notes.push(`Currency not shown; assumed ${baseCurrency}.`);
  return { currency: baseCurrency, confidence: 0.4 };
}

/** Lowers date confidence when the reading is implausible for a receipt. */
function dateConfidence(date: Day | null, confidence: number, today: Day, notes: string[]): number {
  if (!date) return 0;
  if (diffDays(today, date) > 1) {
    notes.push(`The date read (${date}) is in the future; check it.`);
    return Math.min(confidence, 0.4);
  }
  if (diffDays(date, today) > 3 * 365) {
    notes.push(`The date read (${date}) is more than three years ago; check it.`);
    return Math.min(confidence, 0.5);
  }
  return confidence;
}

/** The transactions a model returned, normalised. */
export function candidatesFromExtraction(output: ExtractionOutput, options: { baseCurrency: string; today: Day }): Candidate[] {
  return output.transactions.map((tx, index) => {
    const notes: string[] = [];
    const paymentMethod = tx.paymentMethod === "unknown" ? null : tx.paymentMethod;
    const { currency, confidence: currencyConfidence } = resolveCurrency(tx.currency, tx.confidence.currency, paymentMethod, options.baseCurrency, notes);
    const amount = amountToMinor(tx.amount, currency);
    const date = normalizeDate(tx.date);
    if (tx.date && !date) notes.push(`Could not read the date "${tx.date}".`);
    const time = normalizeTime(tx.time);
    const { type, direction } = mapType(tx.type, tx.direction);
    const fee = tx.fee !== null ? amountToMinor(tx.fee, currency) : null;
    return {
      index,
      amount,
      currency,
      date,
      time,
      merchant: trimTo(tx.merchant, 200),
      reference: trimTo(tx.reference?.replace(/\s+/g, ""), 200),
      paymentMethod,
      cardLast4: tx.cardLast4?.replace(/\D/g, "").slice(-4) || null,
      type,
      direction,
      description: trimTo(tx.description, 200),
      fee,
      lineItems: tx.lineItems.slice(0, 50).map((line) => ({
        description: trimTo(line.description, 200) ?? "",
        amount: line.amount === null ? null : amountToMinor(line.amount, currency),
        quantity: line.quantity,
      })),
      categoryName: trimTo(tx.suggestedCategory, 120),
      projectName: trimTo(tx.suggestedProject, 120),
      workspaceHint: tx.suggestedWorkspace === "unknown" ? null : tx.suggestedWorkspace,
      confidence: {
        amount: amount === null ? 0 : clamp01(tx.confidence.amount),
        currency: currencyConfidence,
        date: dateConfidence(date, date ? clamp01(tx.confidence.date) : 0, options.today, notes),
        time: time ? clamp01(tx.confidence.time) : 0,
        merchant: tx.merchant ? clamp01(tx.confidence.merchant) : 0,
        reference: tx.reference ? clamp01(tx.confidence.reference) : 0,
        type: type ? clamp01(tx.confidence.type) : 0,
        paymentMethod: paymentMethod ? clamp01(tx.confidence.paymentMethod) : 0,
        category: tx.suggestedCategory ? clamp01(tx.confidence.category) : 0,
        project: tx.suggestedProject ? clamp01(tx.confidence.project) : 0,
        workspace: tx.suggestedWorkspace === "unknown" ? 0 : clamp01(tx.confidence.workspace),
      },
      sources: {},
      notes,
    };
  });
}

const CURRENCY_MARK = /[৳$€£₹]|\b(tk|taka|bdt|usd|dollars?|eur|gbp|inr|rs)\b|টাকা|ডলার/i;

/** The deterministic parser's reading of a note, in the same shape. */
export function candidateFromParsed(parsed: ParsedEntry, text: string): Candidate {
  const notes: string[] = [];
  if (parsed.dateSource === "default") notes.push("The note has no date; today was assumed.");
  const paymentMethod = parsed.accountHint ? (ACCOUNT_HINTS[parsed.accountHint] ?? null) : null;
  const marked = CURRENCY_MARK.test(text);
  const walletBdt = paymentMethod !== null && WALLETS.has(paymentMethod);
  return {
    index: 0,
    amount: parsed.amount,
    currency: walletBdt ? "BDT" : parsed.currency,
    date: parsed.date,
    time: null,
    merchant: trimTo(parsed.merchant, 200),
    reference: parsed.reference,
    paymentMethod,
    cardLast4: null,
    type: parsed.type === "adjustment" || parsed.type === "asset_purchase" || parsed.type === "equity" ? "expense" : parsed.type,
    direction: parsed.direction,
    description: trimTo(parsed.description, 200),
    fee: null,
    lineItems: [],
    categoryName: parsed.categoryHint,
    projectName: parsed.projectHint,
    workspaceHint: parsed.workspaceHint,
    confidence: {
      amount: parsed.amount === null ? 0 : parsed.confidence.amount,
      currency: marked || walletBdt ? 0.95 : 0.6,
      date: parsed.confidence.date,
      time: 0,
      merchant: parsed.merchant ? 0.6 : 0,
      reference: parsed.reference ? 0.9 : 0,
      type: parsed.confidence.type,
      paymentMethod: paymentMethod ? 0.85 : 0,
      category: parsed.confidence.category,
      project: parsed.projectHint ? 0.85 : 0,
      workspace: parsed.workspaceHint ? 0.6 : 0,
    },
    sources: {},
    notes,
  };
}

/** The parser's confident readings fill what the model left empty in a note. */
export function mergeParserIntoAi(ai: Candidate, parser: Candidate): Candidate {
  const merged: Candidate = {
    ...ai,
    confidence: { ...ai.confidence },
    sources: { ...ai.sources },
    notes: [...ai.notes],
  };
  const take = <K extends keyof Candidate & CandidateField>(field: K) => {
    const aiMissing = merged[field] === null || merged.confidence[field] === 0;
    if (aiMissing && parser[field] !== null && parser.confidence[field] >= 0.8) {
      (merged as Record<string, unknown>)[field] = parser[field];
      merged.confidence[field] = parser.confidence[field];
      merged.sources[field] = "parser";
    }
  };
  take("amount");
  take("date");
  take("reference");
  take("paymentMethod");
  take("type");
  if (merged.sources.amount === "parser" && merged.currency !== parser.currency && ai.confidence.currency < 0.8) {
    merged.currency = parser.currency;
    merged.confidence.currency = parser.confidence.currency;
    merged.sources.currency = "parser";
  }
  if (merged.sources.type === "parser") merged.direction = parser.direction;
  return merged;
}

// ------------------------------------------------------------ subscriptions

export const KNOWN_SUBSCRIPTION_PROVIDERS: Array<[RegExp, string]> = [
  [/netflix/i, "Netflix"],
  [/spotify/i, "Spotify"],
  [/youtube\s*(premium|music)/i, "YouTube Premium"],
  [/chatgpt|openai/i, "OpenAI"],
  [/\bclaude\b|anthropic/i, "Anthropic"],
  [/github/i, "GitHub"],
  [/figma/i, "Figma"],
  [/notion/i, "Notion"],
  [/adobe/i, "Adobe"],
  [/canva/i, "Canva"],
  [/google\s*(one|workspace|storage)|g\s*suite/i, "Google"],
  [/microsoft\s*365|office\s*365/i, "Microsoft 365"],
  [/icloud|apple\s*(one|music|tv)/i, "Apple"],
  [/amazon\s*prime|prime\s*video/i, "Amazon Prime"],
  [/disney/i, "Disney+"],
  [/hoichoi/i, "Hoichoi"],
  [/chorki/i, "Chorki"],
  [/toffee/i, "Toffee"],
  [/bongo/i, "Bongo"],
  [/\bzoom\b/i, "Zoom"],
  [/slack/i, "Slack"],
  [/dropbox/i, "Dropbox"],
  [/vercel/i, "Vercel"],
  [/digitalocean/i, "DigitalOcean"],
  [/namecheap/i, "Namecheap"],
  [/godaddy/i, "GoDaddy"],
  [/cloudflare/i, "Cloudflare"],
  [/hetzner/i, "Hetzner"],
  [/\bcursor\b/i, "Cursor"],
  [/midjourney/i, "Midjourney"],
  [/perplexity/i, "Perplexity"],
  [/linkedin\s*premium/i, "LinkedIn Premium"],
];

const CADENCE_WORDS: Array<[RegExp, BillingCycle]> = [
  [/\b(half[- ]?yearly|semi[- ]?annual(ly)?|every 6 months|6[- ]month)/i, "half_yearly"],
  [/\b(quarterly|every 3 months|per quarter|3[- ]month)/i, "quarterly"],
  [/\b(yearly|annual(ly)?|per year|a year|every year|\/\s*y(ea)?r\b|12[- ]month)|বার্ষিক|প্রতি বছর/i, "yearly"],
  [/\b(monthly|per month|a month|every month|\/\s*mo(nth)?\b)|মাসিক|প্রতি মাসে/i, "monthly"],
];
const SUBSCRIPTION_WORDS =
  /\b(subscription|subscribed|renews?|renewal|renewed|auto[- ]?renew|billing period|next billing|membership|premium plan|pro plan)\b|সাবস্ক্রিপশন/i;

/**
 * A subscription the model did not flag, from a known provider plus billing
 * language ("Netflix ... monthly"). Returns nothing without both signals.
 */
export function detectSubscriptionHint(merchant: string | null, text: string): { provider: string; billingCycle: BillingCycle | null } | null {
  const haystack = `${merchant ?? ""} ${text}`;
  const provider = KNOWN_SUBSCRIPTION_PROVIDERS.find(([pattern]) => pattern.test(haystack));
  if (!provider) return null;
  const cycle = CADENCE_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  if (!cycle && !SUBSCRIPTION_WORDS.test(text)) return null;
  return { provider: provider[1], billingCycle: cycle };
}

export function addCycle(day: Day, cycle: BillingCycle): Day | null {
  switch (cycle) {
    case "monthly":
      return addMonths(day, 1);
    case "quarterly":
      return addMonths(day, 3);
    case "half_yearly":
      return addMonths(day, 6);
    case "yearly":
      return addYears(day, 1);
    default:
      return null;
  }
}

/** The next renewal after `today`, computed from a start date and a cycle (an estimate, flagged as one). */
export function nextRenewalFrom(start: Day, cycle: BillingCycle, today: Day): Day | null {
  let next = addCycle(start, cycle);
  for (let guard = 0; next && next < today && guard < 240; guard++) next = addCycle(next, cycle);
  return next;
}

/** The subscription facts for a capture: from the model's block, or the provider/cadence heuristic. */
export function buildSubscriptionSuggestion(
  block: ExtractionOutput["subscription"] | null,
  candidates: Candidate[],
  context: { text: string; today: Day },
): SubscriptionSuggestion | null {
  const firstExpense = candidates.findIndex((c) => c.type === "expense" || c.type === null);
  if (block?.isSubscription) {
    const index =
      block.transactionIndex !== null && Number.isInteger(block.transactionIndex) && candidates[block.transactionIndex]
        ? block.transactionIndex
        : Math.max(0, firstExpense);
    const purchase = candidates[index] ?? null;
    const provider = block.provider?.trim() || purchase?.merchant;
    if (!provider) return null;
    const cycle = block.billingCycle === "unknown" ? null : block.billingCycle;
    const purchaseDate = normalizeDate(block.purchaseDate) ?? purchase?.date ?? null;
    const startDate = normalizeDate(block.startDate) ?? purchaseDate;
    let nextRenewalDate = normalizeDate(block.renewalDate);
    let renewalDateEstimated = false;
    if (!nextRenewalDate && cycle && startDate) {
      nextRenewalDate = nextRenewalFrom(startDate, cycle, context.today);
      renewalDateEstimated = nextRenewalDate !== null;
    }
    const currency = normalizeCurrency(block.renewalCurrency) ?? purchase?.currency ?? null;
    return {
      provider: provider.slice(0, 120),
      planName: block.plan?.trim().slice(0, 200) || null,
      billingCycle: cycle,
      purchaseDate,
      startDate,
      nextRenewalDate,
      renewalDateEstimated,
      expiryDate: normalizeDate(block.expiryDate),
      cancellationDeadline: normalizeDate(block.cancellationDeadline),
      autoRenew: block.autoRenew === "yes" ? true : block.autoRenew === "no" ? false : null,
      renewalAmount: currency && block.renewalAmount !== null ? amountToMinor(block.renewalAmount, currency) : null,
      currency,
      confidence: clamp01(block.confidence),
      source: "ai",
      transactionIndex: index,
    };
  }
  for (const candidate of candidates) {
    if (candidate.type !== "expense" && candidate.type !== null) continue;
    const text = [candidate.description, ...candidate.notes, context.text].filter(Boolean).join(" ");
    const hint = detectSubscriptionHint(candidate.merchant, text);
    if (!hint) continue;
    const start = candidate.date;
    const next = start && hint.billingCycle ? nextRenewalFrom(start, hint.billingCycle, context.today) : null;
    return {
      provider: hint.provider,
      planName: null,
      billingCycle: hint.billingCycle,
      purchaseDate: start,
      startDate: start,
      nextRenewalDate: next,
      renewalDateEstimated: next !== null,
      expiryDate: null,
      cancellationDeadline: null,
      autoRenew: null,
      renewalAmount: null,
      currency: candidate.currency,
      confidence: 0.6,
      source: "heuristic",
      transactionIndex: candidate.index,
    };
  }
  return null;
}
