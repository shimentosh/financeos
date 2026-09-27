import { normalizeDigits } from "./money.ts";

const NOISE_WORDS = new Set([
  "ltd",
  "limited",
  "inc",
  "llc",
  "pvt",
  "plc",
  "co",
  "corp",
  "company",
  "bd",
  "the",
  "www",
  "com",
  "payment",
  "purchase",
  "pos",
  "online",
]);

/**
 * The form of a merchant name used for matching: "OPENAI *ChatGPT Subscr",
 * "OpenAI, Inc." and "openai.com" all become "openai ...". Store numbers and
 * card-processor prefixes are dropped.
 */
export function normalizeName(name: string): string {
  return normalizeDigits(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^(sq|tst|pp|paypal|stripe)\s*\*\s*/i, "")
    .replace(/[*#]\s*\d+/g, " ")
    .replace(/\.(com|net|org|io|ai|app|co)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word && !NOISE_WORDS.has(word) && !/^\d{3,}$/.test(word))
    .join(" ")
    .trim();
}

/** The first meaningful word: "openai chatgpt subscr" → "openai". */
export function merchantKey(name: string): string {
  const normalized = normalizeName(name);
  return normalized.split(" ")[0] ?? normalized;
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  const compact = text.replace(/\s+/g, " ");
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Dice coefficient over character bigrams of the normalized names, 0–1. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.9;
  // Bank descriptors wrap the brand in extra words: "anthropic claude ai" vs "claude".
  const wordsX = new Set(x.split(" "));
  const wordsY = new Set(y.split(" "));
  const [small, large] = wordsX.size <= wordsY.size ? [wordsX, wordsY] : [wordsY, wordsX];
  if ([...small].every((word) => word.length >= 3 && large.has(word))) return 0.85;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const count of gx.values()) total += count;
  for (const count of gy.values()) total += count;
  for (const [gram, count] of gx) overlap += Math.min(count, gy.get(gram) ?? 0);
  return total ? (2 * overlap) / total : 0;
}

export function titleCase(text: string): string {
  return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
