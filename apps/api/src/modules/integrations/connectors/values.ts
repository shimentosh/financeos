import { type Day, isDay, parseDay, parseMoneyInput, today, toMinor } from "@expensewise/core";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DEPTH = 20;

/**
 * Reads `data.items.0.id` from parsed JSON. Only own properties are followed
 * (never the prototype chain), array segments must be indices, and
 * `__proto__`/`constructor`/`prototype` are refused. An empty path returns the
 * value itself.
 */
export function getPath(value: unknown, path: string | null | undefined): unknown {
  if (!path) return value;
  const segments = path.split(".").map((segment) => segment.trim());
  if (segments.length > MAX_DEPTH) return undefined;
  let current: unknown = value;
  for (const segment of segments) {
    if (!segment || FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** A path value as trimmed text, or null when absent/empty/not scalar. */
export function textAt(value: unknown, path: string | null | undefined, max = 200): string | null {
  if (!path) return null;
  const found = getPath(value, path);
  if (found === null || found === undefined) return null;
  if (typeof found === "string") return found.trim().slice(0, max) || null;
  if (typeof found === "number" || typeof found === "boolean") return String(found);
  return null;
}

/**
 * A signed amount from a number or text ("1,234.50", "-99", "(45.00)",
 * "৳ 1,500", "1.234,56"), in minor units. `unit` says whether the source
 * reports major units (12.50) or minor units already (1250).
 */
export function parseSignedAmount(input: unknown, currency: string, unit: "major" | "minor" = "major"): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    if (unit === "minor") return Number.isInteger(input) ? input : Math.round(input);
    return toMinor(input, currency);
  }
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/(dr|debit)\.?\s*$/i.test(text)) negative = true;
  text = text.replace(/(dr|cr|debit|credit)\.?\s*$/i, "");
  if (/^[^\d]*-/.test(text) || /-\s*$/.test(text)) negative = true;
  text = text.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)));
  // Drop currency words and symbols, keep digits and separators.
  text = text.replace(/[^\d.,]/g, "");
  if (!text || !/\d/.test(text)) return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  // "1.234,56" / "12,5": a comma as the decimal separator.
  if (lastComma > lastDot && /,\d{1,2}$/.test(text) && (lastDot >= 0 || !/^\d{1,3}(,\d{3})+$/.test(text))) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(/,/g, "");
  }
  if ((text.match(/\./g) ?? []).length > 1) return null;
  let minor: number | null;
  if (unit === "minor") {
    minor = /^\d+$/.test(text) ? Number(text) : null;
  } else {
    minor = parseMoneyInput(text, currency);
    if (minor === null && /^\d+(\.\d+)?$/.test(text)) minor = toMinor(Number(text), currency);
  }
  if (minor === null || !Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/** Excel serial day numbers (1900 system), as found in exported spreadsheets. */
export function excelSerialToDay(serial: number): Day | null {
  if (!Number.isFinite(serial) || serial < 20_000 || serial > 80_000) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * A day from what APIs and files send: "2026-09-12", ISO timestamps, epoch
 * seconds or milliseconds, "12/09/2026", "12 Sep 2026". Instants become the
 * day in `timeZone`.
 */
export function parseDateValue(
  input: unknown,
  timeZone: string,
  format: Parameters<typeof parseDay>[1] = "auto",
): { day: Day; occurredAt: string | null } | null {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return { day: today(timeZone, input), occurredAt: input.toISOString() };
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    const ms = input > 100_000_000_000 ? input : input * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : { day: today(timeZone, date), occurredAt: date.toISOString() };
  }
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;
  if (/^\d{10}(\d{3})?$/.test(text)) return parseDateValue(Number(text), timeZone);
  if (isDay(text)) return { day: text, occurredAt: null };
  // A full timestamp with a zone: the instant is known.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return { day: today(timeZone, date), occurredAt: date.toISOString() };
  }
  const day = parseDay(text, format);
  return day ? { day, occurredAt: null } : null;
}
