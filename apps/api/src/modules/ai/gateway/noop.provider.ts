import { type ClassificationOutput, type ExtractionOutput, emptyExtraction } from "./schemas.js";
import type { AiProvider, ProviderResult, ToolRunOutput } from "./types.js";

/**
 * The provider when no AI is configured (AI_PROVIDER=none, or no API key).
 * Every capability reports unavailable; the gateway never calls it for real
 * work, and if it is called it returns empty results, never invented values.
 */
export class NoopProvider implements AiProvider {
  readonly name = "none";
  readonly model = null;
  readonly available = false;

  constructor(readonly unavailableReason: string = "AI is not configured") {}

  private empty<T>(output: T): ProviderResult<T> {
    return {
      status: "ok",
      output,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: "none",
      costUsd: 0,
    };
  }

  /** A structured "manual" result: nothing was read, so nothing is suggested. */
  async extract(): Promise<ProviderResult<ExtractionOutput>> {
    return this.empty(emptyExtraction(`${this.unavailableReason}. Enter the details by hand.`));
  }

  async classify(): Promise<ProviderResult<ClassificationOutput>> {
    return this.empty({ items: [] });
  }

  async generate(): Promise<ProviderResult<{ text: string }>> {
    return this.empty({ text: "" });
  }

  async runWithTools(): Promise<ProviderResult<ToolRunOutput>> {
    return this.empty({
      text: "",
      toolCalls: [],
      iterations: 0,
      finish: "end_turn",
    });
  }
}
