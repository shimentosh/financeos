import { addMonths, endOfMonth, startOfMonth, today } from "@financeos/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { categories, copilotMessages } from "../../src/db/schema/index.js";
import { CopilotService } from "../../src/modules/copilot/copilot.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { ProjectsService } from "../../src/modules/ledger/catalog.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider, ok } from "../fixtures/ai/fake-provider.js";
import { createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let copilot: CopilotService;
let transactions: TransactionsService;
let accounts: AccountsService;
let user: TestUser;
let bank: string;
let bkash: string;
let groceries: string;
const day = today("Asia/Dhaka");
const thisMonth = startOfMonth(day);
const lastMonth = addMonths(thisMonth, -1);

beforeAll(async () => {
  app = await aiApp(provider);
  copilot = app.service(CopilotService);
  transactions = app.service(TransactionsService);
  accounts = app.service(AccountsService);
});
afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  provider.reset();
  provider.available = false;
  user = await createUser("Copilot User");
  const opening = addMonths(thisMonth, -3);
  bank = (await accounts.create(user.personal, { name: "BRAC Bank", kind: "bank", currency: "BDT", openingBalance: 5_000_000, openingDate: opening })).id;
  bkash = (
    await accounts.create(user.personal, { name: "bKash", kind: "mobile_wallet", provider: "bkash", currency: "BDT", openingBalance: 0, openingDate: opening })
  ).id;
  const cats = await db.select().from(categories).where(eq(categories.workspaceId, user.personal.workspaceId));
  groceries = cats.find((c) => c.name === "Groceries")?.id as string;
  await transactions.create(user.personal, {
    type: "expense",
    accountId: bank,
    amount: 180_000,
    currency: "BDT",
    date: lastMonth,
    merchant: "Shwapno",
    categoryId: groceries,
  });
  await transactions.create(user.personal, {
    type: "expense",
    accountId: bank,
    amount: 120_000,
    currency: "BDT",
    date: lastMonth,
    merchant: "Chaldal",
    categoryId: groceries,
  });
  await transactions.create(user.personal, { type: "expense", accountId: bank, amount: 45_000, currency: "BDT", date: thisMonth, merchant: "Pathao" });
  // Moving money to bKash is not spending.
  await transactions.create(user.personal, { type: "transfer", accountId: bank, toAccountId: bkash, amount: 1_250_000, currency: "BDT", date: thisMonth });
});

describe("copilot without AI", () => {
  it("answers a category question from the ledger with links to the records", async () => {
    const result = await copilot.ask(user.personal, { message: "How much did I spend on groceries last month?" });
    expect(result.answer.content).toContain("৳3,000.00");
    expect(result.answer.content).toContain("Groceries");
    expect(result.answer.data).toMatchObject({ mode: "deterministic", intent: "spending", fallbackReason: "not_configured" });
    expect(result.answer.data.facts?.[0]?.href).toContain(`categoryId=${groceries}`);
    expect(result.answer.data.facts?.[0]?.href).toContain(`from=${lastMonth}`);
    expect(result.thread.title).toBe("How much did I spend on groceries last month?");
    const stored = await db.select().from(copilotMessages).where(eq(copilotMessages.threadId, result.thread.id));
    expect(stored.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
  });

  it("never counts transfers as spending", async () => {
    const result = await copilot.ask(user.personal, { message: "How much did I spend this month?" });
    expect(result.answer.content).toContain("৳450.00");
    expect(result.answer.content).not.toContain("12,500");
  });

  it("answers in Bangla and finds the named wallet", async () => {
    const result = await copilot.ask(user.personal, { message: "আমার বিকাশে কত টাকা আছে?" });
    expect(result.answer.content).toBe("bKash-এ এখন ৳12,500.00 আছে।");
    expect(result.answer.data.sources?.[0]?.href).toBe(`/accounts/${bkash}`);
  });

  it("explains what it can do when the question is not about the records", async () => {
    const result = await copilot.ask(user.personal, { message: "Tell me a joke" });
    expect(result.answer.data.intent).toBe("unknown");
    expect(result.answer.data.followUps?.length).toBeGreaterThan(0);
  });

  it("says which projects earn and which lose money", async () => {
    const projects = app.service(ProjectsService);
    const clip = await projects.create(user.business, { name: "ClipMesh", code: "CLIP" });
    const team = await projects.create(user.business, { name: "TeamOS", code: "TOS" });
    const dbbl = (
      await accounts.create(user.business, { name: "DBBL", kind: "bank", currency: "BDT", openingBalance: 1_000_000, openingDate: addMonths(thisMonth, -3) })
    ).id;
    await transactions.create(user.business, { type: "income", accountId: dbbl, amount: 500_000, currency: "BDT", date: thisMonth, projectId: team.id });
    await transactions.create(user.business, { type: "expense", accountId: dbbl, amount: 200_000, currency: "BDT", date: thisMonth, projectId: clip.id });
    const result = await copilot.ask(user.business, { message: "Which projects are profitable?" });
    expect(result.answer.content).toMatch(/TeamOS \(৳5,000\.00\) is profitable/);
    expect(result.answer.content).toMatch(/ClipMesh \(-৳2,000\.00\) is running at a loss/);
    expect(result.answer.data.sources?.map((s) => s.href)).toContain(`/business/projects/${team.id}`);
  });

  it("keeps each person's conversations to themselves", async () => {
    const mine = await copilot.ask(user.personal, { message: "What's my net worth?" });
    const stranger = await createUser("Stranger");
    await expect(copilot.thread(stranger.personal, mine.thread.id)).rejects.toThrow(/not found/i);
    await expect(copilot.ask(stranger.personal, { threadId: mine.thread.id, message: "and now?" })).rejects.toThrow(/not found/i);
    // Another workspace of the same person is a different scope too.
    await expect(copilot.thread(user.business, mine.thread.id)).rejects.toThrow(/not found/i);
    expect((await copilot.threads(user.personal)).items).toHaveLength(1);
  });
});

describe("copilot with AI", () => {
  it("lets the model query through the tools and shows the tools' figures beside its answer", async () => {
    provider.available = true;
    provider.onTools = async (input) => {
      const tool = input.tools.find((t) => t.name === "get_spending");
      if (!tool) throw new Error("get_spending missing");
      const args = { from: lastMonth, to: endOfMonth(lastMonth), category: "Groceries" };
      const output = await tool.run(tool.inputSchema.parse(args));
      expect(JSON.stringify(output)).toContain("৳3,000.00");
      return ok({
        text: "You spent ৳3,000.00 on groceries last month.",
        toolCalls: [{ name: tool.name, input: args, ok: true, output: JSON.stringify(output) }],
        iterations: 2,
        finish: "end_turn",
      });
    };
    const first = await copilot.ask(user.personal, { message: "How much did I spend on groceries last month?" });
    expect(first.answer.content).toBe("You spent ৳3,000.00 on groceries last month.");
    expect(first.answer.data).toMatchObject({ mode: "ai", toolCalls: [{ name: "get_spending", ok: true }] });
    expect(first.answer.data.facts?.[0]).toMatchObject({ value: "৳3,000.00" });
    expect(first.answer.data.sources?.[0]?.href).toContain(`categoryId=${groceries}`);

    // The system prompt forbids invented numbers; the tools are read-only and scoped.
    const call = provider.calls.find((c) => c.method === "runWithTools")?.input as { system: string; tools: Array<{ name: string }> };
    expect(call.system).toMatch(/Never invent/);
    expect(call.tools.map((t) => t.name)).not.toContain("get_projects");

    provider.onTools = () => ok({ text: "Compared with that, this month is lower.", toolCalls: [], iterations: 1, finish: "end_turn" });
    await copilot.ask(user.personal, { threadId: first.thread.id, message: "And this month?" });
    const second = provider.calls.filter((c) => c.method === "runWithTools")[1]?.input as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("falls back to the built-in answer when the model declines", async () => {
    provider.available = true;
    provider.onTools = () => ({
      status: "refusal",
      usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "claude-opus-5",
      costUsd: 0.0001,
      message: "declined",
      category: null,
    });
    const result = await copilot.ask(user.personal, { message: "How much did I spend this month?" });
    expect(result.answer.data).toMatchObject({ mode: "deterministic", fallbackReason: "refusal" });
    expect(result.answer.content).toContain("৳450.00");
  });

  it("offers project tools only in business workspaces", async () => {
    provider.available = true;
    await copilot.ask(user.business, { message: "Which projects are profitable?" });
    const call = provider.calls.find((c) => c.method === "runWithTools")?.input as { tools: Array<{ name: string }> };
    expect(call.tools.map((t) => t.name)).toContain("get_projects");
  });
});
