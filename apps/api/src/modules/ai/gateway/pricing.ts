import type { TokenUsage } from "./types.js";

/**
 * USD per million tokens. Cache writes cost 1.25x input and cache reads 0.1x
 * input unless a model lists its own rate. Update this table when prices
 * change; an unknown model is priced at the most expensive tier so budgets
 * are never under-counted.
 */
export type ModelPrice = {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  // OpenAI-compatible providers (list prices; override them in Admin → AI when they change).
  // DeepSeek bills less off-peak; the peak rate keeps budgets from under-counting.
  "deepseek-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044 },
  "deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028 },
  "deepseek-reasoner": { input: 0.28, output: 0.42, cacheRead: 0.028 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "grok-4": { input: 3, output: 15, cacheRead: 0.75 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "mistral-large-latest": { input: 2, output: 6 },
  "mistral-small-latest": { input: 0.1, output: 0.3 },
  "pixtral-large-latest": { input: 2, output: 6 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "qwen-plus": { input: 0.4, output: 1.2 },
  "qwen-max": { input: 1.6, output: 6.4 },
};

/** Where a price came from, for the admin screen. */
export type PriceSource = "custom" | "list" | "free" | "unknown";

/**
 * The price for a model: an admin's override, the list above (OpenRouter-style
 * "vendor/model" ids match on the model part), free for local models, and the
 * most expensive tier when nothing is known.
 */
export function resolvePrice(
  model: string,
  options: { override?: { input: number; output: number; cacheRead?: number | null } | null; local?: boolean } = {},
): ModelPrice & { source: PriceSource } {
  if (options.override) {
    const { input, output, cacheRead } = options.override;
    return { input, output, ...(cacheRead === null || cacheRead === undefined ? {} : { cacheRead }), source: "custom" };
  }
  const listed = MODEL_PRICES[model] ?? MODEL_PRICES[model.split("/").at(-1) ?? ""];
  if (listed) return { ...listed, source: "list" };
  if (options.local) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "free" };
  return { ...DEFAULT_PRICE, source: "unknown" };
}

export const DEFAULT_PRICE: ModelPrice = { input: 10, output: 50 };

export function priceFor(model: string | null | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

/** Cost of one call in USD, rounded to the storage precision (6 decimals). */
export function costUsd(model: string | null | undefined, usage: TokenUsage): number {
  return costFor(priceFor(model), usage);
}

export function costFor(price: ModelPrice, usage: TokenUsage): number {
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const dollars =
    (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheWriteTokens * cacheWrite + usage.cacheReadTokens * cacheRead) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
