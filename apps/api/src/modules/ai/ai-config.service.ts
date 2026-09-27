import {
  type AiConfigInput,
  type AiConfigTestInput,
  type AiConfigTestResult,
  type AiConfigView,
  type AiModelConfigView,
  aiConfigInput,
  aiConfigTestInput,
  today,
} from "@expensewise/core";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { unprocessable } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { platformSettings, users } from "../../db/schema/index.js";
import { PROVIDER_PRESETS } from "./gateway/presets.js";
import {
  AI_SETTING_KEY,
  buildProvider,
  encryptAiKey,
  loadStoredAiConfig,
  type ResolvedConfig,
  type ResolvedModel,
  RoutingProvider,
  resolveAiConfig,
  type StoredAiConfig,
  type StoredModel,
} from "./gateway/router.provider.js";
import { AI_PROVIDER, type AiProvider, AiProviderError, type ExtractionHints } from "./gateway/types.js";

const mask = (key: string | null) => (key ? `••••${key.slice(-4)}` : null);

function modelView(model: ResolvedModel | null): AiModelConfigView | null {
  if (!model) return null;
  return {
    provider: model.provider,
    providerName: model.providerName,
    model: model.model,
    baseUrl: model.baseUrl,
    apiKey: { set: Boolean(model.apiKey), masked: mask(model.apiKey), source: model.apiKeySource },
    capabilities: model.capabilities,
    prices: { input: model.price.input, output: model.price.output, cacheRead: model.price.cacheRead, source: model.price.source },
    overrides: model.overrides,
  };
}

const TEST_HINTS: ExtractionHints = {
  today: today("Asia/Dhaka"),
  timezone: "Asia/Dhaka",
  baseCurrency: "BDT",
  workspaceKind: "personal",
  accounts: [{ name: "bKash", kind: "mobile_wallet", provider: "bkash", mask: null, currency: "BDT" }],
  categories: [{ name: "Restaurants", kind: "expense" }],
  projects: [],
};

/**
 * Admin → AI: which provider and model the whole installation uses. Keys are
 * encrypted at rest and never returned — only the last four characters.
 */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger("AiConfig");

  constructor(@Inject(AI_PROVIDER) private readonly provider: AiProvider) {}

  private async current(): Promise<ResolvedConfig> {
    return this.provider instanceof RoutingProvider ? this.provider.resolved : resolveAiConfig();
  }

  async view(): Promise<AiConfigView> {
    const config = await this.current();
    let updatedBy: string | null = null;
    if (config.updatedBy) {
      const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, config.updatedBy));
      updatedBy = user ? user.name || user.email : null;
    }
    return {
      source: config.source,
      available: config.primary !== null,
      unavailableReason: config.reason,
      primary: modelView(config.primary),
      vision: modelView(config.vision),
      updatedAt: config.updatedAt?.toISOString() ?? null,
      updatedBy,
      presets: PROVIDER_PRESETS,
    };
  }

  /**
   * The stored form of an input: a new key is encrypted; an omitted key keeps
   * the saved one only while the provider stays the same (a DeepSeek key is no
   * use to OpenAI); `null` clears it so the server's .env key is used.
   */
  private async toStored(input: z.output<typeof aiConfigInput>): Promise<StoredAiConfig> {
    const existing = (await loadStoredAiConfig())?.config;
    const one = (
      value: NonNullable<z.output<typeof aiConfigInput>["vision"]>,
      slot: "primary" | "vision",
      before: StoredModel | null | undefined,
    ): StoredModel => ({
      provider: value.provider,
      model: value.model,
      baseUrl: value.baseUrl ?? null,
      apiKeyEncrypted:
        value.apiKey === null
          ? null
          : value.apiKey
            ? encryptAiKey(value.apiKey, slot)
            : before?.provider === value.provider
              ? (before.apiKeyEncrypted ?? null)
              : null,
      vision: value.vision ?? null,
      tools: value.tools ?? null,
      structured: value.structured ?? null,
      prices: value.prices ? { input: value.prices.input, output: value.prices.output, cacheRead: value.prices.cacheRead ?? null } : null,
    });
    return { primary: one(input.primary, "primary", existing?.primary), vision: input.vision ? one(input.vision, "vision", existing?.vision) : null };
  }

  async update(raw: AiConfigInput, userId: string): Promise<AiConfigView> {
    const stored = await this.toStored(aiConfigInput.parse(raw));
    // Never save something that cannot work: the same checks the router applies.
    const resolved = await resolveAiConfig({ config: stored, updatedAt: new Date(), updatedBy: userId });
    if (!resolved.primary) throw unprocessable(resolved.reason ?? "This AI configuration can't be used", "ai_config_invalid");
    if (stored.vision && !resolved.vision) throw unprocessable("The image model is missing its key or endpoint", "ai_config_invalid");

    await db
      .insert(platformSettings)
      .values({ key: AI_SETTING_KEY, value: stored as unknown as Record<string, unknown>, updatedBy: userId })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: stored as unknown as Record<string, unknown>, updatedBy: userId, updatedAt: new Date() },
      });
    this.logger.log(`AI configuration changed by ${userId}: ${stored.primary.provider} · ${stored.primary.model}`);
    if (this.provider instanceof RoutingProvider) await this.provider.refresh();
    return this.view();
  }

  /** Back to the server's .env settings. */
  async reset(userId: string): Promise<AiConfigView> {
    await db.delete(platformSettings).where(eq(platformSettings.key, AI_SETTING_KEY));
    this.logger.log(`AI configuration reset to the server's .env by ${userId}`);
    if (this.provider instanceof RoutingProvider) await this.provider.refresh();
    return this.view();
  }

  /**
   * Makes a few small real calls (a few hundred tokens): plain text, the JSON
   * the capture pipeline needs, a tool call, and an image when the model reads them.
   */
  async test(raw: AiConfigTestInput, deps: { fetch?: typeof fetch } = {}): Promise<AiConfigTestResult> {
    const input = aiConfigTestInput.parse(raw);
    const config = input.draft ? await resolveAiConfig({ config: await this.toStored(input.draft), updatedAt: null, updatedBy: null }) : await this.current();
    const model = input.target === "vision" ? config.vision : config.primary;
    if (!model) {
      return { ok: false, provider: "none", model: "", latencyMs: 0, message: config.reason ?? "Nothing to test: no model is set up", checks: [] };
    }
    const client = buildProvider(model, deps);
    const started = Date.now();
    const checks: AiConfigTestResult["checks"] = [];
    const run = async (name: AiConfigTestResult["checks"][number]["name"], call: () => Promise<string>) => {
      try {
        checks.push({ name, ok: true, message: await call() });
      } catch (error) {
        checks.push({ name, ok: false, message: error instanceof AiProviderError || error instanceof Error ? error.message : String(error) });
      }
    };
    const expectOk = <T>(result: { status: string; message?: string; output?: T }) => {
      if (result.status !== "ok") throw new Error(result.message ?? result.status);
      return result.output as T;
    };

    await run("text", async () => {
      const output = expectOk(
        await client.generate({ system: "You are a connection test. Reply with one short sentence.", prompt: "Say that the connection works." }),
      );
      return `Answered: “${output.text.slice(0, 80)}”`;
    });
    // Nothing further is worth trying when the first call cannot even connect.
    if (checks[0]?.ok) {
      await run("json", async () => {
        const output = expectOk(
          await client.extract({ kind: "text", text: "Paid 250 taka for lunch at Foodpanda today with bKash", hints: TEST_HINTS, sourceKind: "text" }),
        );
        const first = output.transactions[0];
        return first ? `Read ${first.amount ?? "?"} ${first.currency ?? ""} at ${first.merchant ?? "?"}` : "Valid JSON, no transaction found";
      });
      if (model.capabilities.tools) {
        await run("tools", async () => {
          const output = expectOk(
            await client.runWithTools({
              system: "You are a connection test. Call the tool once, then reply with one word.",
              messages: [{ role: "user", content: "What is the magic number? Use the tool." }],
              tools: [{ name: "magic_number", description: "Returns the magic number.", inputSchema: z.object({}), run: async () => ({ number: 42 }) }],
              maxIterations: 3,
            }),
          );
          if (!output.toolCalls.some((call) => call.ok)) throw new Error("The model answered without calling the tool");
          return "Called the tool and answered";
        });
      }
      if (model.capabilities.vision) {
        await run("vision", async () => {
          const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } } })
            .png()
            .toBuffer();
          expectOk(await client.extract({ kind: "image", data: png, mimeType: "image/png", hints: TEST_HINTS }));
          return "Accepted an image";
        });
      }
    }
    const ok = checks.length > 0 && checks.every((check) => check.ok);
    const failed = checks.find((check) => !check.ok);
    return {
      ok,
      provider: model.providerName,
      model: model.model,
      latencyMs: Date.now() - started,
      message: ok ? `${model.providerName} · ${model.model} works` : (failed?.message ?? "The test failed"),
      checks,
    };
  }
}
