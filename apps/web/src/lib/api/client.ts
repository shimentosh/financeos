"use client";

import { ApiError, type ApiErrorBody, buildQuery, type Query } from "./shared";
import { PLAN_LIMIT_EVENT, type PlanLimitDetails, type PlanLimitEventDetail } from "./types/billing";

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
};

/**
 * Browser-side calls to the same-origin /api proxy, for interactive pieces
 * (uploads, live search, polling). Most reads happen in Server Components.
 */
export async function clientApi<T>(path: string, options: Options = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch(`/api${path}${buildQuery(options.query)}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body !== undefined && !isForm ? { "content-type": "application/json" } : undefined,
    body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
    signal: options.signal,
  });
  if (response.status === 401) {
    window.location.href = `/sign-in?expired=1&next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, null);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    // Over the plan's limit: the app shell offers the plans (see PlanLimitDialog).
    if (response.status === 402 && body?.error === "plan_limit") {
      const detail: PlanLimitEventDetail = { message: body.message, details: (body.issues ?? null) as unknown as PlanLimitDetails | null };
      window.dispatchEvent(new CustomEvent(PLAN_LIMIT_EVENT, { detail }));
    }
    throw new ApiError(response.status, body);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}
