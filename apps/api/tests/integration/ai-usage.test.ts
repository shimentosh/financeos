import { monthKey, today } from "@expensewise/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { aiUsage } from "../../src/db/schema/index.js";
import { AiGateway } from "../../src/modules/ai/gateway/ai.gateway.js";
import { AiUsageService } from "../../src/modules/ai/usage.service.js";
import { ReportsService } from "../../src/modules/analytics/reports.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider, ok } from "../fixtures/ai/fake-provider.js";
import { createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let gateway: AiGateway;
let usage: AiUsageService;
let user: TestUser;

beforeAll(async () => {
  app = await aiApp(provider);
  gateway = app.service(AiGateway);
  usage = app.service(AiUsageService);
});

afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  provider.reset();
  user = await createUser("Mitu Akter");
});

describe("AI usage and status", () => {
  it("reports this month's calls, tokens, cost, budget and a daily series", async () => {
    const ctx = {
      ...user.personal,
      settings: { ...user.personal.settings, aiMonthlyBudgetUsd: 10 },
    };
    provider.onGenerate = () => ok({ text: "A summary." });
    await gateway.generate(ctx, {
      system: "s",
      prompt: "p",
      feature: "report.narrative",
    });
    await gateway.generate(ctx, {
      system: "s",
      prompt: "p",
      feature: "report.narrative",
    });
    provider.onClassify = () => ({
      status: "refusal",
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: "claude-opus-5",
      costUsd: 0.0005,
      message: "No",
      category: "general_harms",
    });
    await gateway.classify(ctx, {
      items: [],
      categories: [],
      projects: [],
      workspaceKind: "personal",
    });
    await gateway.generate({ ...ctx, settings: { ...ctx.settings, aiEnabled: false } }, { system: "s", prompt: "p" });

    const report = await usage.report(ctx);
    expect(report.month).toBe(monthKey(today(ctx.timezone)));
    expect(report.totals).toMatchObject({
      calls: 4,
      providerCalls: 3,
      ok: 2,
      refusals: 1,
      blocked: 1,
      inputTokens: 3_700,
      outputTokens: 800,
      cacheReadTokens: 2_400,
    });
    // 2 × (1,800 in × $5 + 400 out × $25 + 1,200 cached × $0.50) / 1M + $0.0005
    expect(report.totals.costUsd).toBeCloseTo(2 * 0.0196 + 0.0005, 6);
    expect(report.byFeature.find((f) => f.feature === "report.narrative")).toMatchObject({ calls: 2 });
    expect(report.byModel[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(report.byStatus).toMatchObject({ ok: 2, refusal: 1, disabled: 1 });
    expect(report.daily.length).toBeGreaterThanOrEqual(28);
    expect(report.daily.reduce((sum, d) => sum + d.calls, 0)).toBe(4);
    expect(report.budget).toMatchObject({ limitUsd: 10, source: "workspace" });
    expect(report.budget.remainingUsd).toBeCloseTo(10 - report.totals.costUsd, 6);
    expect(report.recent).toHaveLength(4);

    const status = await gateway.status(ctx);
    expect(status).toMatchObject({
      configured: true,
      provider: "anthropic",
      model: "claude-opus-5",
      enabled: true,
      available: true,
      reason: null,
    });
    expect(status.features).toMatchObject({
      extraction: true,
      copilot: true,
      textParser: true,
    });
    expect(status.spentThisMonth).toBeCloseTo(report.totals.costUsd, 6);
  });

  it("reports the budget as the reason once it is spent, and unlimited when the budget is 0", async () => {
    await db.insert(aiUsage).values({
      workspaceId: user.personal.workspaceId,
      feature: "capture.extract",
      provider: "anthropic",
      model: "claude-opus-5",
      costUsd: "30.000000",
      status: "ok",
    });
    const capped = await gateway.status({
      ...user.personal,
      settings: { ...user.personal.settings, aiMonthlyBudgetUsd: 25 },
    });
    expect(capped).toMatchObject({
      available: false,
      reason: "budget",
      budget: { limitUsd: 25, remainingUsd: 0 },
    });
    const unlimited = await gateway.status({
      ...user.personal,
      settings: { ...user.personal.settings, aiMonthlyBudgetUsd: 0 },
    });
    expect(unlimited).toMatchObject({
      available: true,
      budget: { limitUsd: null, remainingUsd: null },
    });
  });
});

describe("report narratives", () => {
  it("uses the model's narrative only when it restates the report's own numbers", async () => {
    const reports = app.service(ReportsService);
    const ctx = user.personal;
    provider.onGenerate = (input) => {
      const firstFact =
        input.prompt
          .split("\n")
          .find((line) => line.startsWith("- Income"))
          ?.slice(2) ?? "";
      return ok({ text: `A quiet month. ${firstFact}` });
    };
    const faithful = await reports.generate(ctx, {
      kind: "monthly",
      withNarrative: true,
    });
    expect(faithful?.narrativeSource).toBe("ai");
    expect(faithful?.narrative).toMatch(/^A quiet month\. Income:/);

    provider.onGenerate = () => ok({ text: "You spent ৳99,999 on coffee." });
    const invented = await reports.generate(ctx, {
      kind: "monthly",
      withNarrative: true,
    });
    expect(invented?.narrativeSource).toBe("template");
  });
});
