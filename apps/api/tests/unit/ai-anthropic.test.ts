import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, mapAnthropicError, messageCost } from "../../src/modules/ai/gateway/anthropic.provider.js";
import { AiProviderError, type ExtractionHints } from "../../src/modules/ai/gateway/types.js";
import { extracted, extraction } from "../fixtures/ai/fake-provider.js";

const hints: ExtractionHints = {
  today: "2026-09-26",
  timezone: "Asia/Dhaka",
  baseCurrency: "BDT",
  workspaceKind: "personal",
  accounts: [],
  categories: [],
  projects: [],
};

type Params = Record<string, unknown> & {
  messages: Array<{ role: string; content: unknown }>;
};

function message(overrides: Partial<BetaMessage> & { text?: string } = {}): BetaMessage {
  const { text, ...rest } = overrides;
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: text === undefined ? [] : [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 2_000,
      output_tokens: 500,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...rest,
  } as unknown as BetaMessage;
}

/** A client whose beta.messages.create answers from a queue and records every request. */
function fakeClient(responses: Array<BetaMessage | Error>) {
  const requests: Params[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("No response queued");
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const good = JSON.stringify(
  extraction([
    extracted({
      amount: 1250,
      currency: "BDT",
      date: "2026-09-25",
      merchant: "Star Kabab",
      paymentMethod: "bkash",
    }),
  ]),
);

describe("Anthropic provider", () => {
  it("sends images before the text, opts into server-side fallbacks and asks for low-effort structured output", async () => {
    const { client, requests } = fakeClient([message({ text: good })]);
    const provider = new AnthropicProvider({ model: "claude-opus-5", client });
    const result = await provider.extract({
      kind: "image",
      data: Buffer.from("jpegbytes"),
      mimeType: "image/jpeg",
      hints,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok")
      expect(result.output.transactions[0]).toMatchObject({
        amount: 1250,
        merchant: "Star Kabab",
      });
    const request = requests[0] as Params;
    expect(request).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(request).not.toHaveProperty("thinking");
    expect(request.output_config).toMatchObject({
      effort: "low",
      format: { type: "json_schema" },
    });
    expect((request.system as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    const content = request.messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: Buffer.from("jpegbytes").toString("base64"),
      },
    });
    expect(content[1]).toMatchObject({ type: "text" });
    // No assistant prefill: the last message is the user's.
    expect(request.messages.at(-1)?.role).toBe("user");
    // 2,000 in × $5 + 500 out × $25 + 1,000 cached × $0.50, per million.
    expect(result.costUsd).toBeCloseTo(0.023, 6);
    expect(result.usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
    });
  });

  it("puts a PDF document block first", async () => {
    const { client, requests } = fakeClient([message({ text: good })]);
    await new AnthropicProvider({ model: "claude-opus-5", client }).extract({
      kind: "pdf",
      data: Buffer.from("%PDF-1.7"),
      mimeType: "application/pdf",
      hints,
    });
    const content = requests[0]?.messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf" },
    });
  });

  it("reports a refusal without reading the content", async () => {
    const refusal = message({
      text: "{partial",
      stop_reason: "refusal",
      stop_details: {
        type: "refusal",
        category: "general_harms",
        explanation: "Declined",
      } as BetaMessage["stop_details"],
    });
    const { client } = fakeClient([refusal]);
    const result = await new AnthropicProvider({
      model: "claude-opus-5",
      client,
    }).extract({ kind: "text", text: "x", hints });
    expect(result).toMatchObject({
      status: "refusal",
      category: "general_harms",
      message: "Declined",
    });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("reports a truncated answer instead of parsing it", async () => {
    const { client } = fakeClient([message({ text: good.slice(0, 40), stop_reason: "max_tokens" })]);
    const result = await new AnthropicProvider({
      model: "claude-opus-5",
      client,
    }).extract({ kind: "text", text: "x", hints });
    expect(result.status).toBe("max_tokens");
  });

  it("reports an answer that does not match the schema", async () => {
    const { client } = fakeClient([message({ text: JSON.stringify({ transactions: "nope" }) })]);
    const result = await new AnthropicProvider({
      model: "claude-opus-5",
      client,
    }).extract({ kind: "text", text: "x", hints });
    expect(result.status).toBe("invalid_output");
  });

  it("maps typed SDK errors to provider-neutral ones", async () => {
    const rateLimited = APIError.generate(
      429,
      {
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      },
      "slow down",
      new Headers(),
    );
    const { client } = fakeClient([rateLimited]);
    await expect(
      new AnthropicProvider({ model: "claude-opus-5", client }).extract({
        kind: "text",
        text: "x",
        hints,
      }),
    ).rejects.toMatchObject({ kind: "rate_limited", retryable: true });

    expect(mapAnthropicError(APIError.generate(401, { type: "error", error: { type: "authentication_error" } }, "bad key", new Headers()))).toMatchObject({
      kind: "auth",
      retryable: false,
    });
    expect(mapAnthropicError(APIError.generate(400, { type: "error", error: { type: "invalid_request_error" } }, "bad", new Headers()))).toMatchObject({
      kind: "bad_request",
      retryable: false,
    });
    expect(mapAnthropicError(APIError.generate(529, { type: "error", error: { type: "overloaded_error" } }, "busy", new Headers()))).toMatchObject({
      kind: "overloaded",
      retryable: true,
    });
    expect(mapAnthropicError(new APIConnectionTimeoutError())).toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    expect(mapAnthropicError(new Error("boom"))).toBeInstanceOf(AiProviderError);
  });

  it("prices each iteration at its own model when a fallback served the answer", () => {
    const fallback = message({
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        iterations: [
          {
            type: "message",
            model: "claude-opus-5",
            input_tokens: 1_000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: "fallback_message",
            model: "claude-sonnet-5",
            input_tokens: 1_000,
            output_tokens: 1_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
        ],
      } as unknown as BetaMessage["usage"],
    });
    // 1,000 × $5 + (1,000 × $2 + 1,000 × $10), per million.
    expect(messageCost(fallback)).toBeCloseTo(0.017, 6);
  });
});

describe("tool loop", () => {
  const toolUse = (id: string, name: string, input: unknown): BetaMessage =>
    message({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] as unknown as BetaMessage["content"],
    });

  it("validates tool inputs with Zod, returns every result in one message, and stops at the answer", async () => {
    const { client, requests } = fakeClient([
      message({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "sum_spending",
            input: { category: "Groceries", months: 3 },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "sum_spending",
            input: { category: "Groceries", months: "three" },
          },
        ] as unknown as BetaMessage["content"],
      }),
      message({ text: "You spent ৳12,000 on groceries." }),
    ]);
    const seen: unknown[] = [];
    const result = await new AnthropicProvider({
      model: "claude-opus-5",
      client,
    }).runWithTools({
      system: "You answer questions about the ledger.",
      messages: [{ role: "user", content: "How much on groceries?" }],
      tools: [
        {
          name: "sum_spending",
          description: "Total spending in a category",
          inputSchema: z.object({
            category: z.string(),
            months: z.number().int(),
          }),
          run: async (input) => {
            seen.push(input);
            return { total: 1_200_000 };
          },
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toMatchObject({
      text: "You spent ৳12,000 on groceries.",
      iterations: 2,
      finish: "end_turn",
    });
    expect(seen).toEqual([{ category: "Groceries", months: 3 }]);
    expect(result.output.toolCalls.map((call) => call.ok)).toEqual([true, false]);
    const tools = requests[0]?.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({
      name: "sum_spending",
      strict: true,
      input_schema: { type: "object", additionalProperties: false },
    });
    const results = requests[1]?.messages.at(-1) as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(results.role).toBe("user");
    expect(results.content).toHaveLength(2);
    expect(results.content[1]).toMatchObject({
      tool_use_id: "t2",
      is_error: true,
    });
    expect(result.usage.inputTokens).toBe(4_000);
  });

  it("caps the number of iterations", async () => {
    const { client, requests } = fakeClient([toolUse("a", "noop", {}), toolUse("b", "noop", {}), toolUse("c", "noop", {})]);
    const result = await new AnthropicProvider({
      model: "claude-opus-5",
      client,
    }).runWithTools({
      system: "s",
      messages: [{ role: "user", content: "loop" }],
      tools: [
        {
          name: "noop",
          description: "Does nothing",
          inputSchema: z.object({}),
          run: async () => "ok",
        },
      ],
      maxIterations: 2,
    });
    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({
      status: "ok",
      output: { finish: "max_iterations", iterations: 2 },
    });
  });

  it("never runs a tool from a truncated turn", async () => {
    let ran = false;
    const { client } = fakeClient([{ ...toolUse("a", "noop", {}), stop_reason: "max_tokens" } as BetaMessage]);
    const result = await new AnthropicProvider({
      model: "claude-opus-5",
      client,
    }).runWithTools({
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "noop",
          description: "Does nothing",
          inputSchema: z.object({}),
          run: async () => {
            ran = true;
            return "ok";
          },
        },
      ],
    });
    expect(result.status).toBe("max_tokens");
    expect(ran).toBe(false);
  });
});
