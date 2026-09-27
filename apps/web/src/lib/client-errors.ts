"use client";

const reported = new Set<string>();

/**
 * Sends an error an error boundary caught to the API (POST
 * /api/system/client-errors), which logs it and forwards it to error
 * reporting. Best effort: never throws, sends each error once per page load,
 * and never includes the query string (tokens travel there).
 */
export function reportClientError(error: (Error & { digest?: string }) | undefined, source: "boundary" | "global") {
  try {
    const message = (error?.message || "Unknown error").slice(0, 1000);
    const key = `${source}:${error?.digest ?? ""}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    const body = JSON.stringify({
      message,
      name: error?.name?.slice(0, 120),
      stack: error?.stack?.slice(0, 8000),
      digest: error?.digest?.slice(0, 200),
      url: `${window.location.origin}${window.location.pathname}`,
      source,
    });
    void fetch("/api/system/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // Reporting must never make an error page worse.
  }
}
