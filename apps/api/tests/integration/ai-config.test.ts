import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { platformSettings } from "../../src/db/schema/index.js";
import { AiConfigService } from "../../src/modules/ai/ai-config.service.js";
import { AiGateway } from "../../src/modules/ai/gateway/ai.gateway.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let config: AiConfigService;
let gateway: AiGateway;
let admin: TestUser;

beforeAll(async () => {
  config = await service(AiConfigService);
  gateway = await service(AiGateway);
});
afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  admin = await createUser("Platform Admin");
});

const deepseek = { provider: "deepseek" as const, model: "deepseek-chat" };

describe("Admin → AI provider", () => {
  it("saves DeepSeek with an encrypted key, shows only its last characters, and switches the gateway", async () => {
    const view = await config.update({ primary: { ...deepseek, apiKey: "sk-deepseek-secret-9f3a" } }, admin.userId);
    expect(view).toMatchObject({ source: "admin", available: true, updatedBy: "Platform Admin" });
    expect(view.primary).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: { set: true, masked: "••••9f3a", source: "admin" },
      capabilities: { vision: false, tools: true, structured: "json_object" },
      prices: { input: 0.28, source: "list" },
    });
    expect(JSON.stringify(view)).not.toContain("sk-deepseek-secret");
    const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, "ai"));
    expect(JSON.stringify(row?.value)).not.toContain("sk-deepseek-secret");

    const status = await gateway.status(admin.personal);
    expect(status).toMatchObject({ configured: true, provider: "deepseek", model: "deepseek-chat" });
  });

  it("keeps a saved key when the form leaves it blank, and drops it when the provider changes", async () => {
    await config.update({ primary: { ...deepseek, apiKey: "sk-first-1111" } }, admin.userId);
    const kept = await config.update({ primary: { ...deepseek, model: "deepseek-reasoner" } }, admin.userId);
    expect(kept.primary).toMatchObject({ model: "deepseek-reasoner", apiKey: { masked: "••••1111" }, capabilities: { tools: false } });

    // An OpenAI key must be entered for OpenAI; the DeepSeek one is not reused.
    await expect(config.update({ primary: { provider: "mistral", model: "mistral-small-latest" } }, admin.userId)).rejects.toThrow(/No API key for Mistral/);
    // Nothing was saved by the failed attempt.
    expect((await config.view()).primary?.model).toBe("deepseek-reasoner");
  });

  it("pairs DeepSeek with an image model and can go back to the server's .env", async () => {
    const view = await config.update(
      {
        primary: { ...deepseek, apiKey: "sk-ds-2222", prices: { input: 0.3, output: 0.5 } },
        vision: { provider: "gemini", model: "gemini-2.5-flash", apiKey: "gm-3333" },
      },
      admin.userId,
    );
    expect(view.primary?.prices).toMatchObject({ input: 0.3, output: 0.5, source: "custom" });
    expect(view.vision).toMatchObject({ provider: "gemini", capabilities: { vision: true }, apiKey: { masked: "••••3333" } });

    const reset = await config.reset(admin.userId);
    expect(reset.source).not.toBe("admin");
    expect(await db.select().from(platformSettings)).toHaveLength(0);
  });

  it("tests a draft against the provider before anything is saved", async () => {
    const answers = (body: { tools?: unknown; messages: Array<{ role: string }>; response_format?: unknown }) => {
      if (body.tools && !body.messages.some((m) => m.role === "tool")) {
        return {
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "magic_number", arguments: "{}" } }] },
            },
          ],
        };
      }
      if (body.response_format) {
        return {
          choices: [
            { finish_reason: "stop", message: { content: JSON.stringify({ documentType: "note", transactions: [], subscription: SUBSCRIPTION, notes: [] }) } },
          ],
        };
      }
      return { choices: [{ finish_reason: "stop", message: { content: "The connection works." } }] };
    };
    const fetch = (async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(answers(JSON.parse(String(init?.body)))))) as unknown as typeof globalThis.fetch;
    const result = await config.test({ draft: { primary: { ...deepseek, apiKey: "sk-test-4444" } } }, { fetch });
    expect(result).toMatchObject({ ok: true, provider: "DeepSeek", model: "deepseek-chat" });
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["text", true],
      ["json", true],
      ["tools", true],
    ]);
    expect(await db.select().from(platformSettings)).toHaveLength(0);
  });
});

const SUBSCRIPTION = {
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
};
