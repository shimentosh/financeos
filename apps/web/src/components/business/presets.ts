// Shared by the server pages (to validate `?preset=`) and the range selector,
// so it lives outside any "use client" module.

export const RANGE_PRESETS = [
  { value: "all_time", label: "Lifetime" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_quarter", label: "This quarter" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "last_12_months", label: "Last 12 months" },
] as const;

/** The preset from the URL when it is one we offer, else the page's default. */
export function presetFrom(raw: string | undefined, fallback: string): string {
  return RANGE_PRESETS.some((p) => p.value === raw) ? (raw as string) : fallback;
}
