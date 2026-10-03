// Money is integer minor units everywhere: poisha for BDT, cents for USD.
// Floats appear only at the edges (display), never in arithmetic.

import { CRYPTO_CURRENCIES, isCryptoCurrency } from "./constants.ts";

const decimalsCache = new Map<string, number>();

/** Minor-unit digits for a currency: BDT 2, USD 2, JPY 0, KWD 3. */
export function currencyDecimals(currency: string): number {
  const code = currency.toUpperCase();
  const cached = decimalsCache.get(code);
  if (cached !== undefined) return cached;
  if (isCryptoCurrency(code)) return CRYPTO_CURRENCIES[code].decimals;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  decimalsCache.set(code, digits);
  return digits;
}

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";

/** Bangla digits (১৫,০০০) to ASCII (15,000). */
export function normalizeDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/**
 * Parses a user-typed major amount ("40,000.50", "৪০০০০", "1,00,000") into
 * minor units. Returns null for anything that is not a plain positive amount.
 */
export function parseMoneyInput(input: string, currency = "BDT"): number | null {
  const text = normalizeDigits(input)
    .trim()
    .replace(/[,\s_]/g, "");
  const digits = currencyDecimals(currency);
  const pattern = digits > 0 ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/;
  if (!pattern.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

/** Major units (a number from an API or a model) to minor units, rounded. */
export function toMinor(major: number | string, currency: string): number {
  const digits = currencyDecimals(currency);
  if (typeof major === "string") {
    const parsed = parseMoneyInput(major.replace(/^-/, ""), currency);
    if (parsed === null) throw new Error(`Invalid amount: ${major}`);
    return major.trim().startsWith("-") ? -parsed : parsed;
  }
  if (!Number.isFinite(major)) throw new Error(`Invalid amount: ${major}`);
  return roundHalfAwayFromZero(major * 10 ** digits);
}

export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyDecimals(currency);
}

/** "40000.5" for an input field, without grouping or symbol. */
export function minorToInput(minor: number, currency: string): string {
  const digits = currencyDecimals(currency);
  const negative = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const base = 10n ** BigInt(digits);
  const whole = abs / base;
  const fraction = abs % base;
  const text = digits === 0 || fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(digits, "0").replace(/0+$/, "")}`;
  return negative ? `-${text}` : text;
}

export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Splits a decimal rate string into an integer and its power-of-ten scale. */
function rateToFraction(rate: string | number): { numerator: bigint; scale: bigint } {
  const text = typeof rate === "number" ? rate.toFixed(10) : rate.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid exchange rate: ${rate}`);
  const [whole = "0", fraction = ""] = text.split(".");
  return {
    numerator: BigInt(whole + fraction),
    scale: 10n ** BigInt(fraction.length),
  };
}

/**
 * Converts minor units between currencies with a decimal rate
 * (1 `from` = `rate` `to`). Exact integer arithmetic, rounded half away from
 * zero once, at the end.
 */
export function convertMinor(minor: number, from: string, to: string, rate: string | number): number {
  if (from.toUpperCase() === to.toUpperCase()) return minor;
  const { numerator, scale } = rateToFraction(rate);
  const shift = currencyDecimals(to) - currencyDecimals(from);
  let top = BigInt(minor) * numerator;
  let bottom = scale;
  if (shift > 0) top *= 10n ** BigInt(shift);
  if (shift < 0) bottom *= 10n ** BigInt(-shift);
  const negative = top < 0n;
  const absTop = negative ? -top : top;
  const quotient = absTop / bottom;
  const remainder = absTop % bottom;
  const rounded = remainder * 2n >= bottom ? quotient + 1n : quotient;
  return Number(negative ? -rounded : rounded);
}

/** The inverse of a rate, to 10 decimal places. */
export function invertRate(rate: string | number): string {
  const value = typeof rate === "number" ? rate : Number(rate);
  if (!(value > 0)) throw new Error(`Invalid exchange rate: ${rate}`);
  return (1 / value).toFixed(10);
}

export type MoneyFormatOptions = {
  locale?: string;
  /** 1.2L / 3.4Cr in en-IN, 1.2M in en-US. */
  compact?: boolean;
  /** Always show + or − (for changes). */
  signed?: boolean;
  /** Drop the fraction when it is zero: ৳5,000 rather than ৳5,000.00. */
  trimZeroFraction?: boolean;
};

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(key: string, locale: string, options: Intl.NumberFormatOptions) {
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat(locale, options);
    formatterCache.set(key, cached);
  }
  return cached;
}

export function formatMoney(minor: number, currency: string, options: MoneyFormatOptions = {}): string {
  const code = currency.toUpperCase();
  const locale = options.locale ?? "en-IN";
  const digits = currencyDecimals(code);
  const major = minor / 10 ** digits;
  const fractionDigits = options.compact || (options.trimZeroFraction && Number.isInteger(major)) ? 0 : digits;
  const key = `${locale}|${code}|${options.compact ? "c" : "s"}|${fractionDigits}|${options.signed ? "+" : ""}`;
  // Digital currencies are not ISO codes, so Intl cannot format them as currency.
  if (isCryptoCurrency(code)) {
    const number = formatter(`${key}|n`, locale, {
      notation: options.compact ? "compact" : "standard",
      minimumFractionDigits: options.compact ? 0 : fractionDigits,
      maximumFractionDigits: options.compact ? 1 : fractionDigits,
    }).format(Math.abs(major));
    const sign = major < 0 ? "-" : options.signed && major > 0 ? "+" : "";
    const symbol = CRYPTO_CURRENCIES[code].symbol;
    return `${sign}${symbol}${symbol.length > 1 ? " " : ""}${number}`;
  }
  const format = formatter(key, locale, {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
    notation: options.compact ? "compact" : "standard",
    minimumFractionDigits: options.compact ? 0 : fractionDigits,
    maximumFractionDigits: options.compact ? 1 : fractionDigits,
    signDisplay: options.signed ? "exceptZero" : "auto",
  });
  return format.format(major);
}

/** Share of `part` in `whole` as a percentage, one decimal. */
export function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Percentage change from `previous` to `current`; null when undefined. */
export function percentChange(previous: number, current: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
