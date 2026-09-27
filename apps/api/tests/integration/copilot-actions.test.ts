import { today } from "@expensewise/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceContext } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { categories, files, transactionAttachments, transactions as transactionsTable } from "../../src/db/schema/index.js";
import type { ToolRunInput } from "../../src/modules/ai/gateway/types.js";
import { AgentMemoryService } from "../../src/modules/copilot/agent-memory.service.js";
import { CopilotService } from "../../src/modules/copilot/copilot.service.js";
import { McpService } from "../../src/modules/copilot/mcp.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { StorageService } from "../../src/modules/storage/storage.service.js";
import { StorageAdminService } from "../../src/modules/storage/storage-admin.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider, ok } from "../fixtures/ai/fake-provider.js";
import { asSystem, createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let copilot: CopilotService;
let transactions: TransactionsService;
let accounts: AccountsService;
let memory: AgentMemoryService;
let mcp: McpService;
let storage: StorageService;
let user: TestUser;
let bkash: string;
const day = today("Asia/Dhaka");

/** A scripted model turn: calls the named tools in order and answers with `text`. */
function script(calls: Array<[string, Record<string, unknown>]>, text = "Prepared. Confirm below.") {
  return async (input: ToolRunInput) => {
    const toolCalls = [];
    for (const [name, args] of calls) {
      const tool = input.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} is not offered`);
      try {
        const output = await tool.run(tool.inputSchema.parse(args));
        toolCalls.push({ name, input: args, ok: true, output: JSON.stringify(output) });
      } catch (error) {
        toolCalls.push({ name, input: args, ok: false, output: (error as Error).message });
      }
    }
    return ok({ text, toolCalls, iterations: calls.length + 1, finish: "end_turn" as const });
  };
}

const countTransactions = async (ctx: WorkspaceContext) =>
  (await db.select().from(transactionsTable).where(eq(transactionsTable.workspaceId, ctx.workspaceId))).length;

beforeAll(async () => {
  app = await aiApp(provider);
  copilot = app.service(CopilotService);
  transactions = app.service(TransactionsService);
  accounts = app.service(AccountsService);
  memory = app.service(AgentMemoryService);
  mcp = app.service(McpService);
  storage = app.service(StorageService);
});
afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  provider.reset();
  provider.available = true;
  user = await createUser("Agent User");
  bkash = (
    await accounts.create(user.personal, {
      name: "bKash",
      kind: "mobile_wallet",
      provider: "bkash",
      currency: "BDT",
      openingBalance: 500_000,
      openingDate: day,
    })
  ).id;
});

describe("copilot suggestions", () => {
  it("prepares changes without writing, then applies them in order when confirmed", async () => {
    provider.onTools = script([
      ["create_category", { name: "Office Rent", kind: "expense" }],
      ["record_transaction", { type: "expense", amount: 15000, account: "bKash", merchant: "Landlord", category: "Office Rent" }],
    ]);
    const before = await countTransactions(user.personal);
    const asked = await copilot.ask(user.personal, { message: "office rent 15000 bkash e dilam, notun category banao" });
    const actions = asked.answer.data.actions ?? [];
    expect(actions.map((a) => [a.kind, a.status])).toEqual([
      ["create_category", "proposed"],
      ["record_transaction", "proposed"],
    ]);
    // The transaction uses the category that doesn't exist yet.
    expect(actions[1]?.dependsOn).toEqual([actions[0]?.id]);
    expect(actions[1]?.summary).toContain("৳15,000.00");
    // Nothing written yet.
    expect(await countTransactions(user.personal)).toBe(before);
    const rent = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, user.personal.workspaceId), eq(categories.name, "Office Rent")));
    expect(rent).toHaveLength(0);

    // Confirming only the transaction brings its category along.
    const outcome = await copilot.applyActions(user.personal, asked.answer.id, { actionIds: [actions[1]?.id as string] });
    expect(outcome.actions.map((a) => [a.kind, a.status])).toEqual([
      ["create_category", "applied"],
      ["record_transaction", "applied"],
    ]);
    const [created] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, user.personal.workspaceId), eq(categories.name, "Office Rent")));
    const saved = await transactions.get(user.personal, outcome.actions[1]?.result?.id as string);
    expect(saved).toMatchObject({ amount: 1_500_000, currency: "BDT", accountId: bkash, categoryId: created?.id, status: "posted", source: "text" });
    expect(outcome.actions[1]?.result?.href).toContain(saved.id);

    // A second confirm changes nothing.
    await expect(copilot.applyActions(user.personal, asked.answer.id, { actionIds: [actions[1]?.id as string] })).rejects.toThrow(/already/);
    expect(await countTransactions(user.personal)).toBe(before + 1);
  });

  it("confirms with a plain “yes” and discards with “no”", async () => {
    provider.onTools = script([["record_transaction", { type: "expense", amount: 250, account: "bkash", merchant: "Foodpanda" }]]);
    const first = await copilot.ask(user.personal, { message: "lunch 250 foodpanda bkash" });
    const before = await countTransactions(user.personal);
    const yes = await copilot.ask(user.personal, { threadId: first.thread.id, message: "haan save koro" });
    expect(yes.answer.content).toMatch(/Saved/);
    expect(yes.updated?.[0]?.data.actions?.[0]?.status).toBe("applied");
    expect(yes.answer.data.sources?.[0]?.href).toContain("/transactions?ids=");
    expect(await countTransactions(user.personal)).toBe(before + 1);

    provider.onTools = script([["record_transaction", { type: "expense", amount: 90, account: "bKash", merchant: "Tea stall" }]]);
    await copilot.ask(user.personal, { threadId: first.thread.id, message: "cha 90" });
    const no = await copilot.ask(user.personal, { threadId: first.thread.id, message: "না" });
    expect(no.updated?.[0]?.data.actions?.[0]?.status).toBe("discarded");
    expect(await countTransactions(user.personal)).toBe(before + 1);
  });

  it("tells the model which accounts exist when the name doesn't match", async () => {
    provider.onTools = script([["record_transaction", { type: "expense", amount: 100, account: "Nagad" }]], "Which account?");
    const result = await copilot.ask(user.personal, { message: "100 taka nagad" });
    const call = provider.calls.find((c) => c.method === "runWithTools")?.input as ToolRunInput;
    expect(call.system).toMatch(/Nothing is saved until they confirm/);
    expect(result.answer.data.actions ?? []).toHaveLength(0);
    expect(result.answer.data.toolCalls?.[0]).toMatchObject({ name: "record_transaction", ok: false });
  });

  it("keeps viewers read-only", async () => {
    const viewer: WorkspaceContext = { ...user.personal, role: "viewer" };
    provider.onTools = script([]);
    const asked = await copilot.ask(viewer, { message: "add 500 lunch" });
    const call = provider.calls.find((c) => c.method === "runWithTools")?.input as ToolRunInput;
    const names = call.tools.map((t) => t.name);
    expect(names).toContain("get_setup");
    expect(names).not.toContain("record_transaction");
    expect(names).not.toContain("remember");
    await expect(copilot.applyActions(viewer, asked.answer.id, {})).rejects.toThrow(/Viewers/);
  });

  it("remembers what the user asks it to, and shows it to the model next time", async () => {
    provider.onTools = script([["remember", { text: "Salary arrives in BRAC Bank on the 5th" }]], "Noted.");
    const result = await copilot.ask(user.personal, { message: "remember my salary comes to BRAC on the 5th" });
    expect(result.answer.data.remembered?.[0]?.text).toBe("Salary arrives in BRAC Bank on the 5th");
    expect((await memory.list(user.personal)).map((m) => m.text)).toEqual(["Salary arrives in BRAC Bank on the 5th"]);

    provider.onTools = script([], "OK");
    await copilot.ask(user.personal, { message: "when is my salary?" });
    const second = provider.calls.filter((c) => c.method === "runWithTools")[1]?.input as ToolRunInput;
    expect(second.system).toContain("Salary arrives in BRAC Bank on the 5th");
    // Memory is per workspace.
    expect(await memory.list(user.business)).toEqual([]);
  });
});

describe("copilot suggestions without AI", () => {
  beforeEach(() => {
    provider.available = false;
  });

  it("turns a typed entry into a suggestion with the built-in parser", async () => {
    const result = await copilot.ask(user.personal, { message: "lunch 250 bkash" });
    const [action] = result.answer.data.actions ?? [];
    expect(action).toMatchObject({ kind: "record_transaction", status: "proposed" });
    expect(action?.payload).toMatchObject({ amount: 25_000, accountId: bkash, type: "expense" });
    const outcome = await copilot.applyActions(user.personal, result.answer.id, {});
    expect(outcome.actions[0]?.status).toBe("applied");
  });

  it("saves “remember …” notes", async () => {
    const result = await copilot.ask(user.personal, { message: "remember that Shwapno is groceries" });
    expect(result.answer.content).toMatch(/Noted/);
    expect((await memory.list(user.personal))[0]?.text).toBe("Shwapno is groceries");
  });

  it("still answers questions that mention amounts", async () => {
    const result = await copilot.ask(user.personal, { message: "How much did I spend this month?" });
    expect(result.answer.data.actions ?? []).toHaveLength(0);
    expect(result.answer.data.intent).toBe("spending");
  });
});

describe("MCP", () => {
  const rpc = (method: string, params: Record<string, unknown> = {}, id: number | undefined = 1) => ({ jsonrpc: "2.0", id, method, params });

  it("lists read tools for read keys and write tools for write keys", async () => {
    const ctx = asSystem(user.personal, "api");
    const init = await mcp.handle(
      ctx,
      false,
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
    );
    expect(init).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "expense-wise" } } });
    expect(await mcp.handle(ctx, false, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    const read = (await mcp.handle(ctx, false, rpc("tools/list"))) as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } };
    const readNames = read.result.tools.map((t) => t.name);
    expect(readNames).toContain("get_spending");
    expect(readNames).not.toContain("record_transaction");
    expect(read.result.tools.every((t) => t.inputSchema.type === "object")).toBe(true);

    const refused = await mcp.handle(ctx, false, rpc("tools/call", { name: "record_transaction", arguments: {} }));
    expect(refused).toMatchObject({ error: { code: -32602, message: expect.stringMatching(/write scope/) } });

    const write = (await mcp.handle(ctx, true, rpc("tools/list"))) as { result: { tools: Array<{ name: string }> } };
    expect(write.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["record_transaction", "create_category", "remember"]));
  });

  it("applies writes directly for write keys, through the ledger", async () => {
    const ctx = asSystem(user.personal, "api");
    const before = await countTransactions(user.personal);
    const result = (await mcp.handle(
      ctx,
      true,
      rpc("tools/call", { name: "record_transaction", arguments: { type: "expense", amount: 1200, account: "bKash", merchant: "Chaldal" } }),
    )) as { result: { isError: boolean; structuredContent: { id: string } } };
    expect(result.result.isError).toBe(false);
    const saved = await transactions.get(user.personal, result.result.structuredContent.id);
    expect(saved).toMatchObject({ amount: 120_000, source: "api", merchant: "Chaldal" });
    expect(await countTransactions(user.personal)).toBe(before + 1);

    const bad = (await mcp.handle(
      ctx,
      true,
      rpc("tools/call", { name: "record_transaction", arguments: { type: "expense", amount: 5, account: "Nope" } }),
    )) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]?.text).toMatch(/No account called "Nope"/);
    expect(await mcp.handle(ctx, true, rpc("unknown/method"))).toMatchObject({ error: { code: -32601 } });
  });
});

describe("files and storage", () => {
  const upload = (ctx: WorkspaceContext, name: string, content: string) =>
    storage.save(ctx, { buffer: Buffer.from(`%PDF-1.4 ${content}`), filename: name, contentType: "application/pdf" }, "receipt");

  it("records where each file is stored and keeps the list's paperclip in step", async () => {
    const first = await upload(user.personal, "invoice-1.pdf", "one");
    const second = await upload(user.personal, "invoice-2.pdf", "two");
    expect(first.storageBackend).toBe("local");
    expect((await storage.read(user.personal, first.id)).body.toString()).toContain("one");

    const { transaction } = await transactions.create(user.personal, {
      type: "expense",
      accountId: bkash,
      amount: 10_000,
      currency: "BDT",
      date: day,
      attachmentFileIds: [first.id],
    });
    expect(transaction.attachmentFileId).toBe(first.id);
    const swapped = await transactions.update(user.personal, transaction.id, { attachmentFileIds: [second.id] });
    expect(swapped.attachmentFileId).toBe(second.id);
    const links = await db.select().from(transactionAttachments).where(eq(transactionAttachments.transactionId, transaction.id));
    expect(links.map((l) => l.fileId)).toEqual([second.id]);
    const cleared = await transactions.update(user.personal, transaction.id, { attachmentFileIds: [] });
    expect(cleared.attachmentFileId).toBeNull();
    // Another workspace can't attach this workspace's file.
    await expect(
      transactions.create(user.business, {
        type: "expense",
        accountId: null,
        amount: 100,
        currency: "BDT",
        date: day,
        status: "draft",
        attachmentFileIds: [first.id],
      }),
    ).rejects.toThrow();
  });

  it("refuses to save a bucket that fails the connection test, and reports files by location", async () => {
    const admin = app.service(StorageAdminService);
    await upload(user.personal, "a.pdf", "a");
    await expect(
      admin.update(
        {
          provider: "s3",
          endpoint: "http://127.0.0.1:9",
          region: "us-east-1",
          bucket: "expensewise-test",
          accessKeyId: "AKIATESTTESTTEST",
          secretAccessKey: "secretsecretsecret",
        },
        user.userId,
      ),
    ).rejects.toMatchObject({ code: "storage_test_failed" });
    const view = await admin.view();
    expect(view.source).toBe("env");
    expect(view.active.backend).toBe("local");
    expect(view.files.find((f) => f.backend === "local")?.count).toBe(1);
    expect(view.elsewhere).toBe(0);
    const rows = await db.select().from(files).where(eq(files.workspaceId, user.personal.workspaceId));
    expect(rows.every((row) => row.storageBackend === "local")).toBe(true);
  });
});
