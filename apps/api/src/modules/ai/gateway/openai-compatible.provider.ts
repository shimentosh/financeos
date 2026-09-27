import type { AiCapabilities } from "@expensewise/core";
import type { z } from "zod";
import { addUsage, costFor, type ModelPrice } from "./pricing.js";
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

// DeepSeek, OpenAI, Gemini, OpenRouter, Groq, Mistral, xAI, Qwen, Kimi, Together,
// Ollama, LM Studio and any other service that speaks the OpenAI chat-completions API.

const MAX_TOOL_ITERATIONS = 12;
const MAX_TOOL_RESULT_CHARS = 50_000;

export type OpenAiCompatibleOptions = {
  /** Provider id for usage records ("deepseek", "openai", …). */
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  capabilities: AiCapabilities;
  price: ModelPrice;
  /** Most chat APIs cap the answer (DeepSeek at 8K tokens); requests never ask for more. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** First retry delay; doubles each time (tests use 0). */
  retryBaseMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

type ChatContent = string | Array<Record<string, unknown>>;
type ChatMessage =
  | { role: "system" | "user"; content: ChatContent }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatResponse = {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null; tool_calls?: ToolCall[] | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    /** DeepSeek's own cache accounting. */
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string } | string;
};

function toUsage(usage: ChatResponse["usage"]): TokenUsage {
  if (!usage) return ZERO_USAGE;
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  return { inputTokens: Math.max(0, prompt - cached), outputTokens: usage.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/**
 * The strict variant OpenAI-style structured outputs expect: every property
 * listed as required (optional ones already allow null through `anyOf`).
 */
export function allRequired(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(allRequired);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) out[key] = allRequired(value);
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}

/** JSON from a model's text: fenced or bare, with anything around the object ignored. */
export function readJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object");
  return JSON.parse(fenced.slice(start, end + 1));
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly available = true;
  readonly unavailableReason = null;
  readonly name: string;
  readonly model: string;
  readonly capabilities: AiCapabilities;
  private readonly options: OpenAiCompatibleOptions;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.name = options.provider;
    this.model = options.model;
    this.capabilities = options.capabilities;
    this.fetcher = options.fetch ?? fetch;
  }

  private get endpoint() {
    return `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private maxTokens(requested?: number) {
    return Math.min(requested ?? 8_192, this.options.maxOutputTokens ?? 8_192);
  }

  /**
   * DeepSeek's V4 models think by default, and thinking with tools requires
   * resending the reasoning on every turn, which this loop deliberately drops.
   * Extraction, classification and the copilot run fine without it.
   */
  private providerFields(): Record<string, unknown> {
    return this.name === "deepseek" && /^deepseek-(flash|v4)/.test(this.model) ? { thinking: { type: "disabled" } } : {};
  }

  /** One request, with retries on rate limits, overload and dropped connections. */
  private async send(body: Record<string, unknown>): Promise<ChatResponse> {
    const retries = this.options.maxRetries ?? 2;
    let lastError: AiProviderError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, (this.options.retryBaseMs ?? 500) * 2 ** attempt)));
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
            ...this.options.headers,
          },
          body: JSON.stringify({ model: this.model, ...this.providerFields(), ...body }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
        });
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        lastError = timeout
          ? new AiProviderError("timeout", "The AI provider did not answer in time", { cause: error })
          : new AiProviderError("connection", `Could not reach the AI provider at ${this.options.baseUrl}`, { cause: error });
        continue;
      }
      const text = await response.text();
      let parsed: ChatResponse | null = null;
      try {
        parsed = text ? (JSON.parse(text) as ChatResponse) : null;
      } catch {
        parsed = null;
      }
      if (response.ok && parsed) return parsed;
      const detail =
        (typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message) ?? (text.slice(0, 300) || response.statusText || `HTTP ${response.status}`);
      lastError = OpenAiCompatibleProvider.mapStatus(response.status, detail);
      if (!lastError.retryable) throw lastError;
    }
    throw lastError ?? new AiProviderError("unknown", "The AI provider failed");
  }

  static mapStatus(status: number, detail: string): AiProviderError {
    if (status === 401 || status === 403) return new AiProviderError("auth", `The AI provider rejected the API key (${detail})`, { status });
    if (status === 402) return new AiProviderError("auth", `The AI provider account has no credit left (${detail})`, { status });
    if (status === 429) return new AiProviderError("rate_limited", "The AI provider is rate limiting requests", { status });
    if (status === 503 || status === 529) return new AiProviderError("overloaded", "The AI provider is overloaded", { status });
    if (status >= 500) return new AiProviderError("server", `The AI provider failed (${detail})`, { status });
    if (status === 404) return new AiProviderError("bad_request", `The AI provider doesn't know this model or endpoint (${detail})`, { status });
    return new AiProviderError("bad_request", `The AI provider rejected the request: ${detail}`, { status });
  }

  /** Reads one answer the way every capability does: refusals and truncation first, then the content. */
  private settle<T>(response: ChatResponse, read: (text: string) => T | null): ProviderResult<T> {
    const usage = toUsage(response.usage);
    const base = { usage, model: response.model ?? this.model, costUsd: costFor(this.options.price, usage) };
    const choice = response.choices?.[0];
    const message = choice?.message;
    if (message?.refusal || choice?.finish_reason === "content_filter") {
      return { ...base, status: "refusal", category: null, message: message?.refusal ?? "The model declined to process this request" };
    }
    if (choice?.finish_reason === "length") {
      return { ...base, status: "max_tokens", message: "The model's answer was cut off before it finished" };
    }
    const output = read(message?.content ?? "");
    if (output === null) return { ...base, status: "invalid_output", message: "The model's answer did not match the expected format" };
    return { ...base, status: "ok", output };
  }

  /** The request fields that ask for JSON matching `schema`, in whatever way this provider supports. */
  private jsonRequest(name: string, schema: z.ZodType, system: string) {
    const json = strictJsonSchema(schema);
    const mode = this.capabilities.structured;
    if (mode === "json_schema") {
      return { system, response_format: { type: "json_schema", json_schema: { name, schema: allRequired(json), strict: true } } };
    }
    const instructions = `${system}\n\nReply with a single JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(json)}`;
    return { system: instructions, response_format: mode === "json_object" ? { type: "json_object" } : undefined };
  }

  private static parse<S extends z.ZodType>(schema: S, text: string): z.output<S> | null {
    try {
      const parsed = schema.safeParse(readJson(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async extract(input: ExtractInput): Promise<ProviderResult<ExtractionOutput>> {
    if (input.kind === "image" && !this.capabilities.vision) throw new AiProviderError("bad_request", `${this.model} can't read images`);
    if (input.kind === "pdf" && !this.capabilities.pdf) throw new AiProviderError("bad_request", `${this.model} can't read PDFs`);
    const { system, response_format } = this.jsonRequest("extraction", extractionOutput, EXTRACTION_SYSTEM_PROMPT);
    const text = buildExtractionContext(input);
    let content: ChatContent = text;
    if (input.kind === "image") {
      content = [
        { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${input.data.toString("base64")}` } },
        { type: "text", text },
      ];
    } else if (input.kind === "pdf") {
      content = [
        { type: "file", file: { filename: "statement.pdf", file_data: `data:application/pdf;base64,${input.data.toString("base64")}` } },
        { type: "text", text },
      ];
    }
    const response = await this.send({
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      ...(response_format ? { response_format } : {}),
      [this.name === "openai" ? "max_completion_tokens" : "max_tokens"]: this.maxTokens(),
    });
    return this.settle(response, (answer) => OpenAiCompatibleProvider.parse(extractionOutput, answer));
  }

  async classify(input: ClassifyInput): Promise<ProviderResult<ClassificationOutput>> {
    const { system, response_format } = this.jsonRequest("classification", classificationOutput, CLASSIFY_SYSTEM_PROMPT);
    const response = await this.send({
      messages: [
        { role: "system", content: system },
        { role: "user", content: buildClassifyContext(input) },
      ],
      ...(response_format ? { response_format } : {}),
      [this.name === "openai" ? "max_completion_tokens" : "max_tokens"]: this.maxTokens(),
    });
    return this.settle(response, (answer) => OpenAiCompatibleProvider.parse(classificationOutput, answer));
  }

  async generate(input: GenerateInput): Promise<ProviderResult<{ text: string }>> {
    const response = await this.send({
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      [this.name === "openai" ? "max_completion_tokens" : "max_tokens"]: this.maxTokens(input.maxTokens),
    });
    return this.settle(response, (text) => (text.trim() ? { text: text.trim() } : null));
  }

  /** The same loop as the Anthropic provider: validated inputs, results back in order, a hard iteration cap. */
  async runWithTools(input: ToolRunInput): Promise<ProviderResult<ToolRunOutput>> {
    if (!this.capabilities.tools) throw new AiProviderError("bad_request", `${this.model} can't use tools`);
    const maxIterations = Math.min(Math.max(1, input.maxIterations ?? 6), MAX_TOOL_ITERATIONS);
    const strict = this.name === "openai";
    const tools = input.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: strict ? allRequired(strictJsonSchema(tool.inputSchema)) : strictJsonSchema(tool.inputSchema),
        ...(strict ? { strict: true } : {}),
      },
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: input.system },
      ...input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ];
    const toolCalls: ToolCallRecord[] = [];
    let usage: TokenUsage = ZERO_USAGE;
    let cost = 0;
    let model = this.model;
    let lastText = "";

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const response = await this.send({
        messages,
        tools,
        [this.name === "openai" ? "max_completion_tokens" : "max_tokens"]: this.maxTokens(input.maxTokens),
      });
      const stepUsage = toUsage(response.usage);
      usage = addUsage(usage, stepUsage);
      cost += costFor(this.options.price, stepUsage);
      model = response.model ?? model;
      const totals = { usage, model, costUsd: Math.round(cost * 1_000_000) / 1_000_000 };
      const choice = response.choices?.[0];
      const message = choice?.message;
      if (message?.refusal || choice?.finish_reason === "content_filter") {
        return { ...totals, status: "refusal", category: null, message: message?.refusal ?? "The model declined to continue" };
      }
      // A tool call cut off mid-arguments can still look valid: never run it.
      if (choice?.finish_reason === "length") return { ...totals, status: "max_tokens", message: "The model's answer was cut off before it finished" };
      lastText = message?.content?.trim() || lastText;
      const calls = message?.tool_calls ?? [];
      if (!calls.length) {
        return { ...totals, status: "ok", output: { text: lastText, toolCalls, iterations: iteration, finish: "end_turn" } };
      }

      // Only content and tool calls go back; reasoning text (DeepSeek R1) must not be resent.
      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
      const records: ToolCallRecord[] = [];
      const results = await Promise.all(
        calls.map(async (call, index): Promise<ChatMessage> => {
          const tool = input.tools.find((candidate) => candidate.name === call.function.name);
          const fail = (text: string, raw: unknown): ChatMessage => {
            records[index] = { name: call.function.name, input: raw, ok: false, output: text };
            return { role: "tool", tool_call_id: call.id, content: `Error: ${text}` };
          };
          let raw: unknown;
          try {
            raw = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            return fail("The arguments were not valid JSON", call.function.arguments);
          }
          if (!tool) return fail(`Unknown tool ${call.function.name}`, raw);
          const parsed = tool.inputSchema.safeParse(raw);
          if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, raw);
          try {
            const result = await tool.run(parsed.data);
            const text = (typeof result === "string" ? result : JSON.stringify(result)).slice(0, MAX_TOOL_RESULT_CHARS);
            records[index] = { name: call.function.name, input: parsed.data, ok: true, output: text };
            return { role: "tool", tool_call_id: call.id, content: text };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error), parsed.data);
          }
        }),
      );
      toolCalls.push(...records);
      messages.push(...results);
    }

    return {
      usage,
      model,
      costUsd: Math.round(cost * 1_000_000) / 1_000_000,
      status: "ok",
      output: { text: lastText, toolCalls, iterations: maxIterations, finish: "max_iterations" },
    };
  }
}
