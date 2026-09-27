import type { z } from "zod";
import type { ClassificationOutput, ExtractionOutput } from "./schemas.js";

// The provider-neutral surface of the AI gateway. Everything outside
// anthropic.provider.ts talks to these types, never to a vendor SDK.

export type AiFeature = "capture.extract" | "classify" | "generate" | "copilot" | (string & {});

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Everything a provider needs to read one capture. */
export type ExtractionHints = {
  today: string;
  timezone: string;
  baseCurrency: string;
  workspaceKind: "personal" | "business";
  accounts: Array<{
    name: string;
    kind: string;
    provider: string | null;
    mask: string | null;
    currency: string;
  }>;
  categories: Array<{ name: string; kind: "expense" | "income" }>;
  projects: string[];
};

export type ExtractInput =
  | {
      kind: "image";
      data: Buffer;
      mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      hints: ExtractionHints;
      sourceKind?: string;
    }
  | {
      kind: "pdf";
      data: Buffer;
      mimeType: "application/pdf";
      hints: ExtractionHints;
      pageCount?: number | null;
    }
  | {
      kind: "text";
      text: string;
      hints: ExtractionHints;
      sourceKind?: "text" | "voice";
    };

export type ClassifyItem = {
  id: string;
  merchant: string | null;
  description: string | null;
  type: "expense" | "income";
  amount: number;
  currency: string;
};

export type ClassifyInput = {
  items: ClassifyItem[];
  categories: Array<{ name: string; kind: "expense" | "income" }>;
  projects: string[];
  workspaceKind: "personal" | "business";
};

export type GenerateInput = {
  system: string;
  prompt: string;
  /** Hard cap on the response, thinking included. */
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  feature?: AiFeature;
};

/** A tool the model may call during `runWithTools`. Inputs are validated with Zod before `run`. */
export type ToolDefinition<Schema extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  inputSchema: Schema;
  run: (input: z.output<Schema>) => Promise<unknown>;
};

export type ToolMessage = { role: "user" | "assistant"; content: string };

export type ToolRunInput = {
  system: string;
  /** Earlier turns (text only), oldest first; the last one should be the user's question. */
  messages: ToolMessage[];
  tools: ToolDefinition[];
  /** Model round trips before giving up (default 6, at most 12). */
  maxIterations?: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  feature?: AiFeature;
};

export type ToolCallRecord = {
  name: string;
  input: unknown;
  ok: boolean;
  /** The tool's result as sent to the model, or the validation/runtime error. */
  output: string;
};

export type ToolRunOutput = {
  text: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  /** end_turn, or max_iterations when the loop cap was hit before an answer. */
  finish: "end_turn" | "max_iterations";
};

/** What a provider returns: the parsed output, or why there is none. Never throws for model-level outcomes. */
export type ProviderResult<T> =
  | {
      status: "ok";
      output: T;
      usage: TokenUsage;
      model: string;
      costUsd: number;
    }
  | {
      status: "refusal";
      usage: TokenUsage;
      model: string;
      costUsd: number;
      message: string;
      category: string | null;
    }
  | {
      status: "max_tokens" | "invalid_output";
      usage: TokenUsage;
      model: string;
      costUsd: number;
      message: string;
    };

export type ProviderErrorKind = "rate_limited" | "overloaded" | "timeout" | "connection" | "auth" | "bad_request" | "server" | "unknown";

/** Transport and API failures, mapped from the vendor SDK's typed errors. */
export class AiProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(kind: ProviderErrorKind, message: string, options: { status?: number | null; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable = kind === "rate_limited" || kind === "overloaded" || kind === "timeout" || kind === "connection" || kind === "server";
  }
}

export interface AiProvider {
  /** "anthropic", "none", ... */
  readonly name: string;
  /** The default model, or null when there is none. */
  readonly model: string | null;
  /** False for the no-op provider: every capability reports unavailable. */
  readonly available: boolean;
  /** Why the provider is unavailable, for status screens. */
  readonly unavailableReason: string | null;

  extract(input: ExtractInput): Promise<ProviderResult<ExtractionOutput>>;
  classify(input: ClassifyInput): Promise<ProviderResult<ClassificationOutput>>;
  generate(input: GenerateInput): Promise<ProviderResult<{ text: string }>>;
  runWithTools(input: ToolRunInput): Promise<ProviderResult<ToolRunOutput>>;
}

export const AI_PROVIDER = Symbol("AI_PROVIDER");

export type GatewayFailureReason =
  | "not_configured"
  | "disabled"
  | "budget"
  | "credits"
  | "rate_limited"
  | "refusal"
  | "max_tokens"
  | "invalid_output"
  | "error";

export type GatewayMeta = {
  provider: string;
  model: string | null;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  /** The ai_usage row written for this call. */
  usageId: string | null;
};

export type GatewayResult<T> =
  | ({ ok: true; output: T } & GatewayMeta)
  | ({
      ok: false;
      reason: GatewayFailureReason;
      message: string;
      retryable: boolean;
    } & GatewayMeta);
