import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAiCompatibleProvider, readJson } from "../../src/modules/ai/gateway/openai-compatible.provider.js";
import { capabilitiesFor } from "../../src/modules/ai/gateway/presets.js";
import { resolvePrice } from "../../src/modules/ai/gateway/pricing.js";
import { encryptAiKey, RoutingProvider, resolveAiConfig } from "../../src/modules/ai/gateway/router.provider.js";
import { AiProviderError, type ExtractionHints } from "../../src/modules/ai/gateway/types.js";

const hints: ExtractionHints = {
  today: "2026-09-26",
  timezone: "Asia/Dhaka",
  baseCurrency: "BDT",
  workspaceKind: "personal",
  accounts: [{ name: "bKash", kind: "mobile_wallet", provider: "bkash", mask: null, currency: "BDT" }],
  categories: [{ name: "Restaurants", kind: "expense" }],
  projects: [],
};

const extraction = {
  documentType: "note",
  transactions: [
    {
      amount: 250,
      currency: "BDT",
      date: "2026-09-26",
      time: null,
      merchant: "Foodpanda",
      reference: null,
      paymentMethod: "unknown",
      cardLast4: null,
      type: "expense",
      direction: "out",
      description: "Lunch",
      fee: null,
      lineItems: [],
      suggestedCategory: "Restaurants",
      suggestedProject: null,
      suggestedWorkspace: "personal",
      confidence: {
        amount: 0.98,
        currency: 0.95,
        date: 0.9,
        time: 0,
        merchant: 0.95,
        reference: 0,
        type: 0.95,
        paymentMethod: 0.9,
        category: 0.8,
        project: 0,
        workspace: 0.7,
      },
    },
  ],
  subscription: {
    isSubscription: false,
    provider: null,
    plan: null,
    billingCycle: "unknown",
    purchaseDate: null,
    startDate: null,
    renewalDate: null,
    expiryDate: null,
    cancellationDeadline: null,
    autoRenew: "unknown",
    renewalAmount: null,
    renewalCurrency: null,
    transactionIndex: null,
    confidence: 0,
  },
  notes: [],
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A fetch that answers from a script and records every request. */
function scripted(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] as { status?: number; body: unknown };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const reply = (content: string | null, extra: Record<string, unknown> = {}, finish = "stop") => ({
  model: "deepseek-chat",
  choices: [{ finish_reason: finish, message: { content, ...extra } }],
  usage: { prompt_tokens: 1_000, completion_tokens: 200, prompt_cache_hit_tokens: 600 },
});

const deepseek = (fetcher: typeof globalThis.fetch, overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) =>
  new OpenAiCompatibleProvider({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test-1234",
    model: "deepseek-chat",
    capabilities: capabilitiesFor("deepseek", "deepseek-chat"),
    price: resolvePrice("deepseek-chat"),
    maxOutputTokens: 8_192,
    retryBaseMs: 0,
    fetch: fetcher,
    ...overrides,
  });

describe("OpenAI-compatible provider (DeepSeek)", () => {
  it("asks for JSON the way DeepSeek supports and reads a fenced answer", async () => {
    const { fetch, calls } = scripted([{ body: reply(`\`\`\`json\n${JSON.stringify(extraction)}\n\`\`\``) }]);
    const result = await deepseek(fetch).extract({ kind: "text", text: "250 taka lunch Foodpanda bkash", hints, sourceKind: "text" });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.output.transactions[0]?.merchant).toBe("Foodpanda");
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-test-1234");
    expect(call.body).toMatchObject({ model: "deepseek-chat", response_format: { type: "json_object" }, max_tokens: 8_192 });
    expect(JSON.stringify(call.body.messages)).toContain("JSON Schema");
    // 600 of 1,000 prompt tokens were cache hits, billed at the cache rate.
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 0 });
    expect(result.costUsd).toBeCloseTo((400 * 0.28 + 200 * 0.42 + 600 * 0.028) / 1_000_000, 6);
  });

  it("runs DeepSeek V4.1 Flash without thinking, reads images with it, and prices it", async () => {
    const flash = { model: "deepseek-flash", capabilities: capabilitiesFor("deepseek", "deepseek-flash"), price: resolvePrice("deepseek-flash") };
    const { fetch, calls } = scripted([{ body: reply(JSON.stringify(extraction)) }]);
    const result = await deepseek(fetch, flash).extract({ kind: "image", data: Buffer.from("x"), mimeType: "image/png", hints });
    expect(result.status).toBe("ok");
    expect(calls[0]?.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
    expect(result.costUsd).toBeCloseTo((400 * 0.3 + 200 * 1.2 + 600 * 0.006) / 1_000_000, 6);
    // The older model never receives the V4-only field.
    const legacy = scripted([{ body: reply(JSON.stringify(extraction)) }]);
    await deepseek(legacy.fetch).extract({ kind: "text", text: "250 taka lunch", hints, sourceKind: "text" });
    expect(legacy.calls[0]?.body).not.toHaveProperty("thinking");
  });

  it("never sends an image to a model that cannot read one", async () => {
    const { fetch, calls } = scripted([{ body: reply("{}") }]);
    await expect(deepseek(fetch).extract({ kind: "image", data: Buffer.from("x"), mimeType: "image/png", hints })).rejects.toBeInstanceOf(AiProviderError);
    expect(calls).toHaveLength(0);
  });

  it("reports truncation, refusals and unreadable answers instead of guessing", async () => {
    const cut = await deepseek(scripted([{ body: reply("{", {}, "length") }]).fetch).classify({
      items: [],
      categories: [],
      projects: [],
      workspaceKind: "personal",
    });
    expect(cut.status).toBe("max_tokens");
    const refused = await deepseek(scripted([{ body: reply(null, {}, "content_filter") }]).fetch).generate({ system: "s", prompt: "p" });
    expect(refused.status).toBe("refusal");
    const garbage = await deepseek(scripted([{ body: reply("not json at all") }]).fetch).classify({
      items: [],
      categories: [],
      projects: [],
      workspaceKind: "personal",
    });
    expect(garbage.status).toBe("invalid_output");
  });

  it("maps HTTP errors and retries only what is worth retrying", async () => {
    const auth = scripted([{ status: 401, body: { error: { message: "Authentication Fails" } } }]);
    await expect(deepseek(auth.fetch).generate({ system: "s", prompt: "p" })).rejects.toMatchObject({ kind: "auth" });
    expect(auth.calls).toHaveLength(1);

    const busy = scripted([{ status: 429, body: { error: "slow down" } }, { body: reply("Fine.") }]);
    const result = await deepseek(busy.fetch, { maxRetries: 1 }).generate({ system: "s", prompt: "p" });
    expect(result.status === "ok" && result.output.text).toBe("Fine.");
    expect(busy.calls).toHaveLength(2);
  });

  it("runs the tool loop: validated arguments, results sent back by call id, usage summed", async () => {
    const toolCall = { id: "call_1", type: "function", function: { name: "get_spending", arguments: '{"from":"2026-09-01","to":"2026-09-26"}' } };
    const bad = { id: "call_2", type: "function", function: { name: "get_spending", arguments: "{not json" } };
    const { fetch, calls } = scripted([{ body: reply(null, { tool_calls: [toolCall, bad] }, "tool_calls") }, { body: reply("You spent ৳3,000.00.") }]);
    const seen: unknown[] = [];
    const result = await deepseek(fetch).runWithTools({
      system: "Use the tools.",
      messages: [{ role: "user", content: "How much did I spend?" }],
      tools: [
        {
          name: "get_spending",
          description: "Spending for a period",
          inputSchema: z.object({ from: z.string(), to: z.string() }),
          run: async (input) => {
            seen.push(input);
            return { total: "৳3,000.00" };
          },
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toMatchObject({ text: "You spent ৳3,000.00.", iterations: 2, finish: "end_turn" });
    expect(result.output.toolCalls.map((call) => call.ok)).toEqual([true, false]);
    expect(seen).toEqual([{ from: "2026-09-01", to: "2026-09-26" }]);
    const second = calls[1]?.body.messages as Array<Record<string, unknown>>;
    expect(second.at(-3)).toMatchObject({ role: "assistant", tool_calls: [toolCall, bad] });
    expect(second.at(-2)).toMatchObject({ role: "tool", tool_call_id: "call_1", content: '{"total":"৳3,000.00"}' });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_2" });
    expect(result.usage.outputTokens).toBe(400);
  });

  it("uses a strict JSON schema and max_completion_tokens for OpenAI", async () => {
    const { fetch, calls } = scripted([{ body: { ...reply(JSON.stringify({ items: [] })), model: "gpt-5-mini" } }]);
    const openai = new OpenAiCompatibleProvider({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      model: "gpt-5-mini",
      capabilities: capabilitiesFor("openai", "gpt-5-mini"),
      price: resolvePrice("gpt-5-mini"),
      fetch,
    });
    await openai.classify({ items: [], categories: [], projects: [], workspaceKind: "personal" });
    const body = calls[0]?.body as Record<string, unknown> & {
      response_format: { json_schema: { strict: boolean; schema: { required: string[]; properties: object } } };
    };
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toEqual(Object.keys(body.response_format.json_schema.schema.properties));
  });

  it("reads JSON wrapped in prose", () => {
    expect(readJson('Here you go: {"a":1} — done')).toEqual({ a: 1 });
    expect(() => readJson("nothing here")).toThrow();
  });
});

describe("prices and capabilities", () => {
  it("prices listed, prefixed, local, custom and unknown models", () => {
    expect(resolvePrice("deepseek-chat")).toMatchObject({ input: 0.28, source: "list" });
    expect(resolvePrice("deepseek/deepseek-chat")).toMatchObject({ input: 0.28, source: "list" });
    expect(resolvePrice("llama3.2", { local: true })).toMatchObject({ input: 0, output: 0, source: "free" });
    expect(resolvePrice("deepseek-chat", { override: { input: 0.5, output: 1 } })).toMatchObject({ input: 0.5, source: "custom" });
    expect(resolvePrice("brand-new-model")).toMatchObject({ input: 10, output: 50, source: "unknown" });
  });

  it("knows what models can do, and lets an admin say otherwise", () => {
    expect(capabilitiesFor("deepseek", "deepseek-chat")).toMatchObject({ vision: false, tools: true, structured: "json_object" });
    expect(capabilitiesFor("deepseek", "deepseek-reasoner").tools).toBe(false);
    expect(capabilitiesFor("openai", "gpt-5-mini")).toMatchObject({ vision: true, pdf: true, structured: "json_schema" });
    expect(capabilitiesFor("openrouter", "google/gemini-2.5-flash").vision).toBe(true);
    expect(capabilitiesFor("custom", "my-model", { vision: true, structured: "prompt" })).toMatchObject({ vision: true, structured: "prompt" });
  });
});

describe("routing", () => {
  const config = (vision: boolean) =>
    resolveAiConfig({
      config: {
        primary: { provider: "deepseek", model: "deepseek-chat", apiKeyEncrypted: encryptAiKey("sk-deepseek", "primary") },
        vision: vision ? { provider: "gemini", model: "gemini-2.5-flash", apiKeyEncrypted: encryptAiKey("gm-key", "vision") } : null,
      },
      updatedAt: new Date(),
      updatedBy: null,
    });

  it("sends screenshots to the image model and everything else to DeepSeek", async () => {
    const { fetch, calls } = scripted([{ body: reply(JSON.stringify(extraction)) }]);
    const router = new RoutingProvider({ fetch });
    router.apply(await config(true));
    expect(router).toMatchObject({ name: "deepseek", model: "deepseek-chat", available: true });
    await router.extract({ kind: "image", data: Buffer.from("png"), mimeType: "image/png", hints });
    await router.extract({ kind: "text", text: "250 tk lunch", hints });
    expect(calls.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
    ]);
    expect(calls[0]?.headers.authorization).toBe("Bearer gm-key");
  });

  it("explains, without calling anyone, when no model can read an image", async () => {
    const { fetch, calls } = scripted([{ body: reply("{}") }]);
    const router = new RoutingProvider({ fetch });
    router.apply(await config(false));
    await expect(router.extract({ kind: "image", data: Buffer.from("png"), mimeType: "image/png", hints })).rejects.toThrow(/can't read images/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to be configured without a key", async () => {
    const resolved = await resolveAiConfig({ config: { primary: { provider: "mistral", model: "mistral-small-latest" } }, updatedAt: null, updatedBy: null });
    expect(resolved.primary).toBeNull();
    expect(resolved.reason).toMatch(/No API key for Mistral/);
  });
});
