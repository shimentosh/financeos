import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { aiUsage, creditTransactions, workspaceMembers } from "../../src/db/schema/index.js";
import { AiGateway } from "../../src/modules/ai/gateway/ai.gateway.js";
import { AiUsageService } from "../../src/modules/ai/usage.service.js";
import { forgetBillingConfig } from "../../src/modules/billing/billing-config.js";
import { CreditsService, creditsFor } from "../../src/modules/billing/credits.service.js";
import { CopilotService } from "../../src/modules/copilot/copilot.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider, ok } from "../fixtures/ai/fake-provider.js";
import { enableBilling } from "../fixtures/billing.js";
import { createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let gateway: AiGateway;
let usage: AiUsageService;
let credits: CreditsService;
let copilot: CopilotService;
let user: TestUser;

beforeAll(async () => {
  app = await aiApp(provider);
  gateway = app.service(AiGateway);
  usage = app.service(AiUsageService);
  credits = app.service(CreditsService);
  copilot = app.service(CopilotService);
});

afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  forgetBillingConfig();
  provider.reset();
  provider.onGenerate = () => ok({ text: "A summary." });
  user = await createUser("Rafiq Hasan");
});

const generate = () => gateway.generate(user.business, { system: "s", prompt: "p", feature: "report.narrative" });

describe("credits per call", () => {
  it("rounds the model cost up to whole credits, at least one", () => {
    expect(creditsFor(0, 100)).toBe(1);
    expect(creditsFor(0.0001, 100)).toBe(1);
    expect(creditsFor(0.07, 100)).toBe(7);
    expect(creditsFor(0.0196, 100)).toBe(2);
    expect(creditsFor(1.234, 100)).toBe(124);
  });
});

describe("AI credits with billing on", () => {
  it("takes each call from the allowance first, then the balance, and refuses with 'credits' when both are empty", async () => {
    await enableBilling({ trial: { enabled: false }, limits: { free: { aiCreditsPerMonth: 3 } } });
    await credits.grant({ userId: user.userId, credits: 5, kind: "grant", note: "Welcome" });

    // FakeProvider's call costs US$0.0196: 2 credits at 100 per dollar.
    const first = await generate();
    expect(first.ok).toBe(true);
    expect(await credits.summary(user.userId)).toMatchObject({ allowance: 3, usedThisPeriod: 2, remainingAllowance: 1, balance: 5 });

    const second = await generate();
    const split = await db
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, user.userId), eq(creditTransactions.aiUsageId, second.usageId as string)))
      .orderBy(asc(creditTransactions.source));
    expect(split.map((row) => [row.source, row.credits, row.workspaceId])).toEqual([
      ["allowance", -1, user.business.workspaceId],
      ["balance", -1, user.business.workspaceId],
    ]);
    expect(await credits.summary(user.userId)).toMatchObject({ usedThisPeriod: 3, remainingAllowance: 0, balance: 4 });

    expect((await generate()).ok).toBe(true);
    expect((await generate()).ok).toBe(true);
    expect((await credits.summary(user.userId)).balance).toBe(0);
    expect(provider.count("generate")).toBe(4);

    const refused = await generate();
    expect(refused).toMatchObject({ ok: false, reason: "credits" });
    expect(provider.count("generate")).toBe(4);
    const [blocked] = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.id, refused.usageId as string));
    expect(blocked).toMatchObject({ status: "credits", error: "credits" });

    expect(await gateway.availability(user.business)).toMatchObject({ available: false, reason: "credits" });
    const status = await gateway.status(user.business);
    expect(status).toMatchObject({ available: false, reason: "credits", credits: { allowance: 3, remainingAllowance: 0, balance: 0, remaining: 0 } });

    // The copilot answers from its built-in readings and says why.
    const answer = await copilot.answer(user.business, "How much did I spend this month?");
    expect(answer.data).toMatchObject({ mode: "deterministic", fallbackReason: "credits" });

    // The usage report counts refusals as blocked.
    const report = await usage.report(user.business);
    expect(report.totals).toMatchObject({ calls: 5, providerCalls: 4, blocked: 1 });
    expect(report.budget.limitUsd).toBeNull();

    // Buying credits brings AI back.
    await credits.grant({ userId: user.userId, credits: 10, kind: "purchase" });
    expect((await generate()).ok).toBe(true);
  });

  it("charges the workspace owner for a member's AI use", async () => {
    await enableBilling({ trial: { enabled: false }, limits: { free: { aiCreditsPerMonth: 10 } } });
    const member = await createUser("Accountant");
    await db.insert(workspaceMembers).values({ workspaceId: user.business.workspaceId, userId: member.userId, role: "member" });
    await gateway.generate({ ...user.business, userId: member.userId }, { system: "s", prompt: "p" });
    expect((await credits.summary(user.userId)).usedThisPeriod).toBe(2);
    expect((await credits.summary(member.userId)).usedThisPeriod).toBe(0);
  });

  it("the workspace budget becomes an optional extra cap: unset = none, 0 = AI off", async () => {
    await enableBilling({ trial: { enabled: false } });
    // No budget: the server default (AI_MONTHLY_BUDGET_USD) no longer applies; credits do.
    expect(usage.budgetFor(user.business, true)).toEqual({ limitUsd: null, source: "default" });
    expect((await generate()).ok).toBe(true);

    const off = { ...user.business, settings: { ...user.business.settings, aiMonthlyBudgetUsd: 0 } };
    expect(usage.budgetFor(off, true)).toEqual({ limitUsd: 0, source: "workspace" });
    expect(await gateway.generate(off, { system: "s", prompt: "p" })).toMatchObject({ ok: false, reason: "budget" });
    expect(await gateway.availability(off)).toMatchObject({ available: false, reason: "budget" });

    const capped = { ...user.business, settings: { ...user.business.settings, aiMonthlyBudgetUsd: 0.02 } };
    expect((await gateway.generate(capped, { system: "s", prompt: "p" })).ok).toBe(true);
    // 2 × US$0.0196 spent this month ≥ US$0.02.
    expect(await gateway.generate(capped, { system: "s", prompt: "p" })).toMatchObject({ ok: false, reason: "budget" });
  });
});

describe("AI with billing off", () => {
  it("charges no credits and keeps today's budget rules (0 = unlimited)", async () => {
    expect((await generate()).ok).toBe(true);
    expect(await db.$count(creditTransactions)).toBe(0);
    const status = await gateway.status(user.business);
    expect(status.credits).toBeNull();
    expect(status.budget.source).toBe("default");
    const unlimited = { ...user.business, settings: { ...user.business.settings, aiMonthlyBudgetUsd: 0 } };
    expect(usage.budgetFor(unlimited)).toEqual({ limitUsd: null, source: "workspace" });
    expect((await gateway.generate(unlimited, { system: "s", prompt: "p" })).ok).toBe(true);
  });
});
