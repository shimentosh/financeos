import sharp from "sharp";
import { costUsd } from "../../../src/modules/ai/gateway/pricing.js";
import { type ClassificationOutput, type ExtractedTransaction, type ExtractionOutput, emptyExtraction } from "../../../src/modules/ai/gateway/schemas.js";
import type {
  AiProvider,
  ClassifyInput,
  ExtractInput,
  GenerateInput,
  ProviderResult,
  TokenUsage,
  ToolRunInput,
  ToolRunOutput,
} from "../../../src/modules/ai/gateway/types.js";

export const FAKE_MODEL = "claude-opus-5";
export const FAKE_USAGE: TokenUsage = {
  inputTokens: 1_800,
  outputTokens: 400,
  cacheReadTokens: 1_200,
  cacheWriteTokens: 0,
};

export function ok<T>(output: T, usage: TokenUsage = FAKE_USAGE): ProviderResult<T> {
  return {
    status: "ok",
    output,
    usage,
    model: FAKE_MODEL,
    costUsd: costUsd(FAKE_MODEL, usage),
  };
}

type Handler<I, O> = (input: I) => ProviderResult<O> | Promise<ProviderResult<O>>;

/**
 * A provider that never touches the network. Each capability answers from a
 * handler the test sets; every call is recorded for assertions.
 */
export class FakeProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model = FAKE_MODEL;
  available = true;
  unavailableReason: string | null = null;
  calls: Array<{
    method: "extract" | "classify" | "generate" | "runWithTools";
    input: unknown;
  }> = [];

  onExtract: Handler<ExtractInput, ExtractionOutput> = () => ok(emptyExtraction("Nothing configured"));
  onClassify: Handler<ClassifyInput, ClassificationOutput> = () => ok({ items: [] });
  onGenerate: Handler<GenerateInput, { text: string }> = () => ok({ text: "" });
  onTools: Handler<ToolRunInput, ToolRunOutput> = () => ok({ text: "", toolCalls: [], iterations: 1, finish: "end_turn" });

  reset() {
    this.calls = [];
    this.available = true;
    this.onExtract = () => ok(emptyExtraction("Nothing configured"));
    this.onClassify = () => ok({ items: [] });
    this.onGenerate = () => ok({ text: "" });
    this.onTools = () => ok({ text: "", toolCalls: [], iterations: 1, finish: "end_turn" });
  }

  count(method: FakeProvider["calls"][number]["method"]) {
    return this.calls.filter((call) => call.method === method).length;
  }

  async extract(input: ExtractInput) {
    this.calls.push({ method: "extract", input });
    return this.onExtract(input);
  }

  async classify(input: ClassifyInput) {
    this.calls.push({ method: "classify", input });
    return this.onClassify(input);
  }

  async generate(input: GenerateInput) {
    this.calls.push({ method: "generate", input });
    return this.onGenerate(input);
  }

  async runWithTools(input: ToolRunInput) {
    this.calls.push({ method: "runWithTools", input });
    return this.onTools(input);
  }
}

const HIGH = {
  amount: 0.97,
  currency: 0.97,
  date: 0.96,
  time: 0.9,
  merchant: 0.95,
  reference: 0.98,
  type: 0.96,
  paymentMethod: 0.97,
  category: 0,
  project: 0,
  workspace: 0,
};

/** One extracted transaction with sensible defaults (nothing guessed: absent fields are null). */
export function extracted(
  overrides: Omit<Partial<ExtractedTransaction>, "confidence"> & {
    confidence?: Partial<ExtractedTransaction["confidence"]>;
  } = {},
): ExtractedTransaction {
  return {
    amount: null,
    currency: null,
    date: null,
    time: null,
    merchant: null,
    reference: null,
    paymentMethod: "unknown",
    cardLast4: null,
    type: "expense",
    direction: "out",
    description: null,
    fee: null,
    lineItems: [],
    suggestedCategory: null,
    suggestedProject: null,
    suggestedWorkspace: "unknown",
    ...overrides,
    confidence: { ...HIGH, ...(overrides.confidence ?? {}) },
  };
}

export function extraction(
  transactions: ExtractedTransaction[],
  subscription: Partial<ExtractionOutput["subscription"]> = {},
  notes: string[] = [],
): ExtractionOutput {
  const base = emptyExtraction("");
  return {
    documentType: "wallet_screenshot",
    transactions,
    subscription: { ...base.subscription, ...subscription },
    notes,
  };
}

/** A tiny generated PNG; a different colour gives different bytes. */
export function png(color: { r: number; g: number; b: number } = { r: 226, g: 19, b: 110 }): Promise<Buffer> {
  return sharp({
    create: { width: 48, height: 32, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}
