import { z } from "zod";

/** AI providers the gateway can call. Everything except Anthropic speaks the OpenAI chat-completions API. */
export const AI_PROVIDER_IDS = [
  "anthropic",
  "deepseek",
  "openai",
  "gemini",
  "openrouter",
  "groq",
  "mistral",
  "xai",
  "qwen",
  "moonshot",
  "together",
  "ollama",
  "lmstudio",
  "custom",
] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** How a model is asked for JSON: a schema it must follow, JSON mode, or instructions only. */
export const AI_STRUCTURED_MODES = ["json_schema", "json_object", "prompt"] as const;
export type AiStructuredMode = (typeof AI_STRUCTURED_MODES)[number];

const price = z.number().min(0).max(1000);

/** One model: which provider, which model, and optional overrides of what it can do. */
export const aiModelConfigInput = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  model: z.string().trim().min(1).max(200),
  /** Only for OpenAI-compatible providers; defaults to the provider's own endpoint. */
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullish(),
  /** A new key replaces the stored one; `null` removes it; omitted keeps it. */
  apiKey: z.string().trim().min(1).max(500).nullish(),
  /** Overrides of the capabilities the gateway assumes for this model. */
  vision: z.boolean().nullish(),
  tools: z.boolean().nullish(),
  structured: z.enum(AI_STRUCTURED_MODES).nullish(),
  /** USD per million tokens, when the built-in price list is wrong or missing. */
  prices: z.object({ input: price, output: price, cacheRead: price.nullish() }).nullish(),
});
export type AiModelConfigInput = z.input<typeof aiModelConfigInput>;

export const aiConfigInput = z.object({
  primary: aiModelConfigInput,
  /** A second model that reads screenshots and PDFs when the primary one cannot. */
  vision: aiModelConfigInput.nullish(),
});
export type AiConfigInput = z.input<typeof aiConfigInput>;

export const aiConfigTestInput = z.object({
  target: z.enum(["primary", "vision"]).default("primary"),
  /** Test these settings before saving them; the saved ones otherwise. */
  draft: aiConfigInput.optional(),
});
export type AiConfigTestInput = z.input<typeof aiConfigTestInput>;

export type AiCapabilities = { vision: boolean; pdf: boolean; tools: boolean; structured: AiStructuredMode };

export type AiProviderPreset = {
  id: AiProviderId;
  name: string;
  /** The default endpoint; null for Anthropic (its SDK knows it) and for custom. */
  baseUrl: string | null;
  keyRequired: boolean;
  /** The environment variable read when no key is saved here. */
  envKey: string | null;
  defaultModel: string;
  models: Array<{ id: string; label: string; vision: boolean; tools: boolean }>;
  structured: AiStructuredMode;
  local: boolean;
  keyUrl: string | null;
  note: string | null;
};

export type AiModelConfigView = {
  provider: AiProviderId;
  providerName: string;
  model: string;
  baseUrl: string | null;
  apiKey: { set: boolean; masked: string | null; source: "admin" | "env" | null };
  capabilities: AiCapabilities;
  prices: { input: number; output: number; cacheRead: number; source: "custom" | "list" | "free" | "unknown" };
  /** The overrides as saved, so the form can show them. */
  overrides: { vision: boolean | null; tools: boolean | null; structured: AiStructuredMode | null; prices: boolean };
};

export type AiConfigView = {
  /** Where the active settings come from: saved by an admin, the server's .env, or nothing. */
  source: "admin" | "env" | "none";
  available: boolean;
  unavailableReason: string | null;
  primary: AiModelConfigView | null;
  vision: AiModelConfigView | null;
  updatedAt: string | null;
  updatedBy: string | null;
  presets: AiProviderPreset[];
};

export type AiConfigTestResult = {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  message: string;
  /** What was tried: plain text, JSON, a tool call, an image. */
  checks: Array<{ name: "text" | "json" | "tools" | "vision"; ok: boolean; message: string }>;
};
