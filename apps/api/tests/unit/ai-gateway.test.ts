import { describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { AiGateway } from "../../src/modules/ai/gateway/ai.gateway.js";
import { NoopProvider } from "../../src/modules/ai/gateway/noop.provider.js";
import { costUsd, DEFAULT_PRICE, priceFor } from "../../src/modules/ai/gateway/pricing.js";
import { AiProviderError } from "../../src/modules/ai/gateway/types.js";
import { numbersIn, onlyKnownNumbers } from "../../src/modules/ai/narrative.js";
import type { AiRateLimiter, AiUsageEntry, AiUsageService } from "../../src/modules/ai/usage.service.js";
import { FakeProvider, ok } from "../fixtures/ai/fake-provider.js";

const ctx = {
  workspaceId: "0192f5a0-0000-7000-8000-000000000001",
  userId: "user_1",
  timezone: "Asia/Dhaka",
  settings: { aiEnabled: true, aiMonthlyBudgetUsd: 5 },
} as Pick<WorkspaceContext, "workspaceId" | "userId" | "timezone" | "settings">;

/** A usage service without a database: records in memory, reports a fixed spend. */
function fakeUsage(spent = 0) {
  const recorded: AiUsageEntry[] = [];
  const service = {
    recorded,
    record: async (entry: AiUsageEntry) => {
      recorded.push(entry);
      return `usage_${recorded.length}`;
    },
    spentThisMonth: async () => spent,
    budgetFor: (c: Pick<WorkspaceContext, "settings">) => {
      const limit = c.settings.aiMonthlyBudgetUsd ?? 25;
      return {
        limitUsd: limit > 0 ? limit : null,
        source: "workspace" as const,
      };
    },
  };
  return service;
}

const allow = (answer = true) => ({ allow: async () => answer }) as unknown as AiRateLimiter;

function gateway(provider: FakeProvider | NoopProvider, spent = 0, limiter = allow()) {
  const usage = fakeUsage(spent);
  return {
    gateway: new AiGateway(provider, usage as unknown as AiUsageService, limiter),
    usage,
  };
}

describe("pricing", () => {
  it("prices input, output and cache tokens per model", () => {
    expect(
      costUsd("claude-opus-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(5);
    expect(
      costUsd("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(25);
    expect(
      costUsd("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(0.5 + 6.25);
    expect(
      costUsd("claude-opus-5", {
        inputTokens: 1_234,
        outputTokens: 567,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0.020345);
  });

  it("prices an unknown model at the most expensive tier so budgets are never under-counted", () => {
    expect(priceFor("some-future-model")).toEqual(DEFAULT_PRICE);
    expect(priceFor(null)).toEqual(DEFAULT_PRICE);
  });
});

describe("gateway", () => {
  it("calls the provider and records the call with tokens, cost and latency", async () => {
    const provider = new FakeProvider();
    provider.onGenerate = () => ok({ text: "Done." });
    const { gateway: g, usage } = gateway(provider);
    const result = await g.generate(ctx, {
      system: "s",
      prompt: "p",
      feature: "report.narrative",
    });
    expect(result).toMatchObject({
      ok: true,
      output: { text: "Done." },
      provider: "anthropic",
      model: "claude-opus-5",
      usageId: "usage_1",
    });
    expect(usage.recorded[0]).toMatchObject({
      feature: "report.narrative",
      status: "ok",
      provider: "anthropic",
      model: "claude-opus-5",
      workspaceId: ctx.workspaceId,
      userId: "user_1",
    });
    expect(usage.recorded[0]?.costUsd).toBeGreaterThan(0);
    expect(usage.recorded[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back once the monthly budget is spent, without calling the provider", async () => {
    const provider = new FakeProvider();
    const { gateway: g, usage } = gateway(provider, 5.01);
    const result = await g.extractTransactions(ctx, {
      kind: "text",
      text: "x",
      hints: {} as never,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "budget",
      message: "This month's AI budget is used up",
      retryable: false,
    });
    expect(provider.calls).toHaveLength(0);
    expect(usage.recorded[0]).toMatchObject({ status: "budget", costUsd: 0 });
  });

  it("treats a budget of 0 as unlimited", async () => {
    const provider = new FakeProvider();
    const { gateway: g } = gateway(provider, 1_000);
    const result = await g.generate({ ...ctx, settings: { aiMonthlyBudgetUsd: 0 } }, { system: "s", prompt: "p" });
    expect(result.ok).toBe(true);
  });

  it("respects the workspace switch", async () => {
    const provider = new FakeProvider();
    const { gateway: g, usage } = gateway(provider);
    const result = await g.classify({ ...ctx, settings: { aiEnabled: false } }, { items: [], categories: [], projects: [], workspaceKind: "personal" });
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
    expect(usage.recorded[0]).toMatchObject({
      status: "disabled",
      error: "disabled",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rate-limits people, not background jobs", async () => {
    const provider = new FakeProvider();
    const { gateway: g, usage } = gateway(provider, 0, allow(false));
    expect(await g.generate(ctx, { system: "s", prompt: "p" })).toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryable: true,
    });
    expect(usage.recorded[0]).toMatchObject({
      status: "error",
      error: "rate_limited",
    });
    expect(await g.generate({ ...ctx, userId: null }, { system: "s", prompt: "p" })).toMatchObject({ ok: true });
  });

  it("turns provider errors, refusals and truncation into reasons and records each", async () => {
    const provider = new FakeProvider();
    const { gateway: g, usage } = gateway(provider);
    provider.onGenerate = () => {
      throw new AiProviderError("timeout", "The AI provider did not answer in time");
    };
    expect(await g.generate(ctx, { system: "s", prompt: "p" })).toMatchObject({
      ok: false,
      reason: "error",
      retryable: true,
    });
    provider.onGenerate = () => ({
      status: "refusal",
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: "claude-opus-5",
      costUsd: 0.00005,
      message: "No",
      category: "cyber",
    });
    expect(await g.generate(ctx, { system: "s", prompt: "p" })).toMatchObject({
      ok: false,
      reason: "refusal",
      costUsd: 0.00005,
    });
    provider.onGenerate = () => ({
      status: "max_tokens",
      usage: {
        inputTokens: 10,
        outputTokens: 99,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: "claude-opus-5",
      costUsd: 0.001,
      message: "cut off",
    });
    expect(await g.generate(ctx, { system: "s", prompt: "p" })).toMatchObject({
      ok: false,
      reason: "max_tokens",
    });
    expect(usage.recorded.map((entry) => entry.status)).toEqual(["error", "refusal", "error"]);
    expect(usage.recorded[1]?.error).toContain("refusal (cyber)");
  });
});

describe("no-op provider", () => {
  it("reports every capability unavailable and never fabricates an extraction", async () => {
    const provider = new NoopProvider("No ANTHROPIC_API_KEY is configured on this server");
    expect(provider).toMatchObject({
      available: false,
      name: "none",
      model: null,
    });
    const manual = await provider.extract();
    expect(manual.status).toBe("ok");
    if (manual.status === "ok") {
      expect(manual.output.transactions).toEqual([]);
      expect(manual.output.subscription.isSubscription).toBe(false);
      expect(manual.output.notes[0]).toMatch(/Enter the details by hand/);
    }
    const { gateway: g, usage } = gateway(provider);
    expect(g.configured).toBe(false);
    const result = await g.extractTransactions(ctx, {
      kind: "text",
      text: "x",
      hints: {} as never,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "not_configured",
      message: "No ANTHROPIC_API_KEY is configured on this server",
      provider: "none",
    });
    expect(usage.recorded[0]).toMatchObject({
      status: "disabled",
      provider: "none",
      model: "none",
    });
    const status = await g.status(ctx);
    expect(status).toMatchObject({
      configured: false,
      available: false,
      reason: "not_configured",
      features: { extraction: false, textParser: true },
    });
  });
});

describe("narrative guard", () => {
  it("accepts only numbers that appear in the facts", () => {
    const facts = ["Income: ৳1,20,000.00, up 12.5% on the previous period.", "Spending: ৳45,300.50.", "Period: 2026-08-01 to 2026-08-31."];
    expect(numbersIn("৳1,20,000.00 and 12.50%")).toEqual(["120000", "12.5"]);
    expect(onlyKnownNumbers("Income reached ৳1,20,000.00 (up 12.5%) while spending was ৳45,300.50 in the period to 2026-08-31.", facts)).toBe(true);
    expect(onlyKnownNumbers("You saved ৳74,699.50.", facts)).toBe(false);
  });
});
