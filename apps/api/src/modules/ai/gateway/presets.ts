import type { AiCapabilities, AiProviderId, AiProviderPreset, AiStructuredMode } from "@financeos/core";

// What the gateway knows about each provider. Model lists are suggestions: any
// model id the provider accepts can be typed in, and its capabilities are
// guessed from its name (and can be overridden in Admin → AI).

type Model = { id: string; label: string; vision: boolean; tools: boolean };
const m = (id: string, label: string, vision: boolean, tools = true): Model => ({ id, label, vision, tools });

export const PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    baseUrl: null,
    keyRequired: true,
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-5",
    models: [m("claude-opus-5", "Claude Opus 5", true), m("claude-sonnet-5", "Claude Sonnet 5", true), m("claude-haiku-4-5", "Claude Haiku 4.5", true)],
    structured: "json_schema",
    local: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Reads screenshots, receipts and PDFs. Requests use Anthropic's server-side model fallback.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyRequired: true,
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-flash",
    models: [m("deepseek-flash", "DeepSeek V4.1 Flash", true), m("deepseek-v4-pro", "DeepSeek V4 Pro", false)],
    structured: "json_object",
    local: false,
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "V4.1 Flash reads screenshots and receipts. V4 Pro can't read images: pair it with an image model below.",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-5-mini",
    models: [
      m("gpt-5", "GPT-5", true),
      m("gpt-5-mini", "GPT-5 mini", true),
      m("gpt-5-nano", "GPT-5 nano", true),
      m("gpt-4.1-mini", "GPT-4.1 mini", true),
      m("gpt-4o-mini", "GPT-4o mini", true),
    ],
    structured: "json_schema",
    local: false,
    keyUrl: "https://platform.openai.com/api-keys",
    note: null,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyRequired: true,
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    models: [
      m("gemini-2.5-flash", "Gemini 2.5 Flash", true),
      m("gemini-2.5-pro", "Gemini 2.5 Pro", true),
      m("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", true),
    ],
    structured: "json_schema",
    local: false,
    keyUrl: "https://aistudio.google.com/apikey",
    note: "A good, inexpensive image model to pair with DeepSeek.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "deepseek/deepseek-chat",
    models: [
      m("deepseek/deepseek-chat", "DeepSeek Chat", false),
      m("google/gemini-2.5-flash", "Gemini 2.5 Flash", true),
      m("openai/gpt-5-mini", "GPT-5 mini", true),
      m("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B", false),
    ],
    structured: "json_object",
    local: false,
    keyUrl: "https://openrouter.ai/keys",
    note: "One key for hundreds of models; use the provider/model ids OpenRouter lists.",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyRequired: true,
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      m("llama-3.3-70b-versatile", "Llama 3.3 70B", false),
      m("openai/gpt-oss-120b", "GPT-OSS 120B", false),
      m("meta-llama/llama-4-scout-17b-16e-instruct", "Llama 4 Scout (vision)", true),
    ],
    structured: "json_object",
    local: false,
    keyUrl: "https://console.groq.com/keys",
    note: null,
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyRequired: true,
    envKey: "MISTRAL_API_KEY",
    defaultModel: "mistral-small-latest",
    models: [
      m("mistral-small-latest", "Mistral Small", true),
      m("mistral-large-latest", "Mistral Large", false),
      m("pixtral-large-latest", "Pixtral Large (vision)", true),
    ],
    structured: "json_object",
    local: false,
    keyUrl: "https://console.mistral.ai/api-keys",
    note: null,
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keyRequired: true,
    envKey: "XAI_API_KEY",
    defaultModel: "grok-4",
    models: [m("grok-4", "Grok 4", true), m("grok-3-mini", "Grok 3 mini", false)],
    structured: "json_schema",
    local: false,
    keyUrl: "https://console.x.ai",
    note: null,
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyRequired: true,
    envKey: "DASHSCOPE_API_KEY",
    defaultModel: "qwen-plus",
    models: [m("qwen-plus", "Qwen Plus", false), m("qwen-max", "Qwen Max", false), m("qwen-vl-plus", "Qwen VL Plus (vision)", true)],
    structured: "json_object",
    local: false,
    keyUrl: "https://modelstudio.console.alibabacloud.com",
    note: null,
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    keyRequired: true,
    envKey: "MOONSHOT_API_KEY",
    defaultModel: "kimi-latest",
    models: [m("kimi-latest", "Kimi (latest)", true), m("moonshot-v1-32k", "Moonshot v1 32k", false)],
    structured: "json_object",
    local: false,
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    note: null,
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyRequired: true,
    envKey: "TOGETHER_API_KEY",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: [
      m("deepseek-ai/DeepSeek-V3", "DeepSeek V3", false),
      m("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo", false),
      m("Qwen/Qwen2.5-VL-72B-Instruct", "Qwen2.5 VL 72B (vision)", true),
    ],
    structured: "json_object",
    local: false,
    keyUrl: "https://api.together.ai/settings/api-keys",
    note: null,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyRequired: false,
    envKey: null,
    defaultModel: "llama3.2",
    models: [
      m("llama3.2", "Llama 3.2", false),
      m("qwen2.5", "Qwen 2.5", false),
      m("gemma3", "Gemma 3 (vision)", true),
      m("llama3.2-vision", "Llama 3.2 Vision", true, false),
    ],
    structured: "json_object",
    local: true,
    keyUrl: null,
    note: "Runs on your own machine: free and private. Small models make more mistakes; every capture still waits for your review.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    keyRequired: false,
    envKey: null,
    defaultModel: "qwen2.5-7b-instruct",
    models: [m("qwen2.5-7b-instruct", "Qwen 2.5 7B Instruct", false)],
    structured: "json_schema",
    local: true,
    keyUrl: null,
    note: "Use the model id LM Studio shows for the model you loaded.",
  },
  {
    id: "custom",
    name: "Other (OpenAI-compatible)",
    baseUrl: null,
    keyRequired: false,
    envKey: "AI_API_KEY",
    defaultModel: "",
    models: [],
    structured: "json_object",
    local: false,
    keyUrl: null,
    note: "Any service with an OpenAI-style /chat/completions endpoint: vLLM, LiteLLM, Azure, a company gateway.",
  },
];

export function presetFor(id: AiProviderId): AiProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? (PROVIDER_PRESETS.at(-1) as AiProviderPreset);
}

const VISION_NAMES = /vision|[-_/]vl\b|vl-|pixtral|gpt-4o|gpt-4\.1|gpt-5|gemini|claude|grok-4|llama-4|gemma3|kimi-latest|llava/i;
const NO_TOOL_NAMES = /reasoner|deepseek-r1|\br1\b|llama3\.2-vision/i;

/**
 * What a model can do: the preset's word for a known model, a guess from the
 * name otherwise, and an admin's override on top of either.
 */
export function capabilitiesFor(
  provider: AiProviderId,
  model: string,
  overrides: { vision?: boolean | null; tools?: boolean | null; structured?: AiStructuredMode | null } = {},
): AiCapabilities {
  const preset = presetFor(provider);
  const known = preset.models.find((candidate) => candidate.id === model);
  const vision = overrides.vision ?? known?.vision ?? (provider === "anthropic" || VISION_NAMES.test(model));
  const tools = overrides.tools ?? known?.tools ?? !NO_TOOL_NAMES.test(model);
  // PDFs as documents: Claude natively, OpenAI through file inputs; others read page images only.
  const pdf = provider === "anthropic" || (provider === "openai" && vision);
  return { vision, pdf, tools, structured: overrides.structured ?? preset.structured };
}
