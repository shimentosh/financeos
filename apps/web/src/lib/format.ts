import { formatDay, formatMoney, type MoneyFormatOptions, relativeDays } from "@expensewise/core";

export { formatDay, relativeDays };

/** Signed display for a transaction row: money in green with +, out plain. */
export function signedAmount(amount: number, currency: string, direction: "in" | "out", locale?: string) {
  return formatMoney(direction === "in" ? amount : -amount, currency, { locale, signed: direction === "in" });
}

export function money(minor: number | null | undefined, currency: string, options: MoneyFormatOptions = {}) {
  if (minor === null || minor === undefined) return "—";
  return formatMoney(minor, currency, options);
}

export function percentText(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function titleFromKind(kind: string) {
  return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** File sizes: 812 B, 48 KB, 3.4 MB. */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}
