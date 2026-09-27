import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { addUsage, costUsd } from "./pricing.js";
import {
  buildClassifyContext,
  buildExtractionContext,
  CLASSIFY_SYSTEM_PROMPT,
  type ClassificationOutput,
  classificationOutput,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionOutput,
  extractionOutput,
  strictJsonSchema,
} from "./schemas.js";
import {
  type AiProvider,
  AiProviderError,
  type ClassifyInput,
  type ExtractInput,
  type GenerateInput,
  type ProviderResult,
  type TokenUsage,
  type ToolCallRecord,
  type ToolRunInput,
  type ToolRunOutput,
  ZERO_USAGE,
} from "./types.js";

// The one place that knows about Anthropic. Everything else talks to the
// provider-neutral AiProvider interface.

/** Server-side refusal fallbacks: a declined request is retried on the model Anthropic recommends for that category. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Non-streaming requests: room for adaptive thinking plus the answer, within SDK HTTP timeouts. */
const MAX_TOKENS = 16_000;
const MAX_TOOL_ITERATIONS = 12;
const MAX_TOOL_RESULT_CHARS = 50_000;

const EXTRACTION_FORMAT = {
  type: "json_schema" as const,
  schema: strictJsonSchema(extractionOutput),
};
const CLASSIFICATION_FORMAT = {
  type: "json_schema" as const,
  schema: strictJsonSchema(classificationOutput),
};

type RequestParams = Omit<MessageCreateParamsNonStreaming, "model" | "betas" | "fallbacks">;

export type AnthropicProviderOptions = {
  apiKey?: string;
  model: string;
  /** A proxy or gateway in front of Anthropic's API. */
  baseUrl?: string;
  /** Injected in tests; built from the API key otherwise. */
  client?: Anthropic;
  timeoutMs?: number;
  maxRetries?: number;
};

function toUsage(usage: BetaMessage["usage"]): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Cost of a response. With a fallback (or compaction) the usage carries one
 * entry per sampling iteration, each billed at its own model's price;
 * otherwise the top-level totals are billed at the serving model's price.
 */
export function messageCost(message: BetaMessage): number {
  const iterations = message.usage.iterations ?? [];
  if (!iterations.length) return costUsd(message.model, toUsage(message.usage));
  let total = 0;
  for (const iteration of iterations) {
    const model = "model" in iteration && typeof iteration.model === "string" ? iteration.model : message.model;
    total += costUsd(model, {
      inputTokens: iteration.input_tokens ?? 0,
      outputTokens: iteration.output_tokens ?? 0,
      cacheReadTokens: iteration.cache_read_input_tokens ?? 0,
      cacheWriteTokens: iteration.cache_creation_input_tokens ?? 0,
    });
  }
  return Math.round(total * 1_000_000) / 1_000_000;
}

function textOf(message: BetaMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
}

/** Maps the SDK's typed errors (most specific first) to provider-neutral ones. */
export function mapAnthropicError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RateLimitError) return new AiProviderError("rate_limited", "The AI provider is rate limiting requests", { status: 429, cause: error });
  if (error instanceof APIConnectionTimeoutError) return new AiProviderError("timeout", "The AI provider did not answer in time", { cause: error });
  if (error instanceof APIConnectionError) return new AiProviderError("connection", "Could not reach the AI provider", { cause: error });
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new AiProviderError("auth", "The AI provider rejected the API key", {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError || error instanceof NotFoundError) {
    return new AiProviderError("bad_request", `The AI provider rejected the request: ${message}`, { status: error.status, cause: error });
  }
  if (error instanceof InternalServerError) {
    const overloaded = error.status === 529;
    return new AiProviderError(overloaded ? "overloaded" : "server", overloaded ? "The AI provider is overloaded" : "The AI provider failed", {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    return new AiProviderError(error.status && error.status >= 500 ? "server" : "unknown", message, { status: error.status ?? null, cause: error });
  }
  return new AiProviderError("unknown", message, { cause: error });
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly available = true;
  readonly unavailableReason = null;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    // Timeouts and retries (429, 5xx, connection errors) are the SDK's own.
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        timeout: options.timeoutMs ?? 60_000,
        maxRetries: options.maxRetries ?? 2,
      });
  }

  private async send(params: RequestParams): Promise<BetaMessage> {
    try {
      return await this.client.beta.messages.create({
        ...params,
        model: this.model,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      });
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  /**
   * The stop reason decides whether the content can be read at all: a refusal
   * or a truncated answer is reported as such, never parsed.
   */
  private settle<T>(message: BetaMessage, read: (text: string) => T | null): ProviderResult<T> {
    const usage = toUsage(message.usage);
    const cost = messageCost(message);
    const base = { usage, model: message.model, costUsd: cost };
    if (message.stop_reason === "refusal") {
      return {
        ...base,
        status: "refusal",
        category: message.stop_details?.category ?? null,
        message: message.stop_details?.explanation ?? "The model declined to process this request",
      };
    }
    if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
      return {
        ...base,
        status: "max_tokens",
        message: "The model's answer was cut off before it finished",
      };
    }
    const output = read(textOf(message));
    if (output === null)
      return {
        ...base,
        status: "invalid_output",
        message: "The model's answer did not match the expected format",
      };
    return { ...base, status: "ok", output };
  }

  private static parseJson<S extends z.ZodType>(schema: S, text: string): z.output<S> | null {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async extract(input: ExtractInput): Promise<ProviderResult<ExtractionOutput>> {
    const content: BetaContentBlockParam[] = [];
    // Documents and images go before the text that refers to them.
    if (input.kind === "pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: input.data.toString("base64"),
        },
      });
    } else if (input.kind === "image") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: input.mimeType,
          data: input.data.toString("base64"),
        },
      });
    }
    content.push({ type: "text", text: buildExtractionContext(input) });

    const message = await this.send({
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: EXTRACTION_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content }],
      output_config: { effort: "low", format: EXTRACTION_FORMAT },
    });
    return this.settle(message, (text) => AnthropicProvider.parseJson(extractionOutput, text));
  }

  async classify(input: ClassifyInput): Promise<ProviderResult<ClassificationOutput>> {
    const message = await this.send({
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: CLASSIFY_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildClassifyContext(input) }],
      output_config: { effort: "low", format: CLASSIFICATION_FORMAT },
    });
    return this.settle(message, (text) => AnthropicProvider.parseJson(classificationOutput, text));
  }

  async generate(input: GenerateInput): Promise<ProviderResult<{ text: string }>> {
    const message = await this.send({
      max_tokens: input.maxTokens ?? MAX_TOKENS,
      system: [
        {
          type: "text",
          text: input.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: input.prompt }],
      output_config: { effort: input.effort ?? "medium" },
    });
    return this.settle(message, (text) => (text.trim() ? { text: text.trim() } : null));
  }

  /**
   * A manual tool loop: the model asks for tools, each input is validated
   * with the tool's Zod schema before it runs, every result (or error) goes
   * back in one message, and the loop stops at `maxIterations`.
   */
  async runWithTools(input: ToolRunInput): Promise<ProviderResult<ToolRunOutput>> {
    const maxIterations = Math.min(Math.max(1, input.maxIterations ?? 6), MAX_TOOL_ITERATIONS);
    const tools: BetaTool[] = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: strictJsonSchema(tool.inputSchema) as BetaTool.InputSchema,
      strict: true,
    }));
    const messages: BetaMessageParam[] = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const toolCalls: ToolCallRecord[] = [];
    let usage: TokenUsage = ZERO_USAGE;
    let cost = 0;
    let model = this.model;
    let lastText = "";

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const message = await this.send({
        max_tokens: input.maxTokens ?? MAX_TOKENS,
        system: [
          {
            type: "text",
            text: input.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
        tools,
        output_config: { effort: input.effort ?? "medium" },
      });
      usage = addUsage(usage, toUsage(message.usage));
      cost += messageCost(message);
      model = message.model;
      const totals = {
        usage,
        model,
        costUsd: Math.round(cost * 1_000_000) / 1_000_000,
      };

      if (message.stop_reason === "refusal") {
        return {
          ...totals,
          status: "refusal",
          category: message.stop_details?.category ?? null,
          message: message.stop_details?.explanation ?? "The model declined to continue",
        };
      }
      // A tool input cut off at max_tokens can parse as a valid partial object: never run it.
      if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
        return {
          ...totals,
          status: "max_tokens",
          message: "The model's answer was cut off before it finished",
        };
      }
      lastText = textOf(message) || lastText;
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const uses = message.content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
      if (message.stop_reason !== "tool_use" || !uses.length) {
        return {
          ...totals,
          status: "ok",
          output: {
            text: lastText.trim(),
            toolCalls,
            iterations: iteration,
            finish: "end_turn",
          },
        };
      }

      messages.push({ role: "assistant", content: message.content });
      // Calls run in parallel; their records keep the order the model asked in.
      const records: ToolCallRecord[] = [];
      const results: BetaToolResultBlockParam[] = await Promise.all(
        uses.map(async (use, index): Promise<BetaToolResultBlockParam> => {
          const tool = input.tools.find((candidate) => candidate.name === use.name);
          const fail = (text: string) => {
            records[index] = {
              name: use.name,
              input: use.input,
              ok: false,
              output: text,
            };
            return {
              type: "tool_result" as const,
              tool_use_id: use.id,
              is_error: true,
              content: text,
            };
          };
          if (!tool) return fail(`Unknown tool ${use.name}`);
          const parsed = tool.inputSchema.safeParse(use.input);
          if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
          try {
            const result = await tool.run(parsed.data);
            const text = (typeof result === "string" ? result : JSON.stringify(result)).slice(0, MAX_TOOL_RESULT_CHARS);
            records[index] = {
              name: use.name,
              input: parsed.data,
              ok: true,
              output: text,
            };
            return { type: "tool_result", tool_use_id: use.id, content: text };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        }),
      );
      toolCalls.push(...records);
      // Every result in one user message, so parallel tool use keeps working.
      messages.push({ role: "user", content: results });
    }

    return {
      usage,
      model,
      costUsd: Math.round(cost * 1_000_000) / 1_000_000,
      status: "ok",
      output: {
        text: lastText.trim(),
        toolCalls,
        iterations: maxIterations,
        finish: "max_iterations",
      },
    };
  }
}
