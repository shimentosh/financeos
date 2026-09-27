import "./load-env.js";
import { AI_PROVIDER_IDS } from "@expensewise/core";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((value) => value === "true" || value === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  ALLOW_SIGN_UP: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  /** Comma-separated emails that get the platform admin role. */
  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
        : [],
    ),
  ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, "ENCRYPTION_KEY must be base64 of exactly 32 bytes"),
  /** The default AI provider when none is saved in Admin → AI; `none` turns AI off. */
  AI_PROVIDER: z.enum([...AI_PROVIDER_IDS, "none"]).default("anthropic"),
  /** Defaults to the provider's recommended model. */
  AI_MODEL: z.string().optional(),
  /** A key for AI_PROVIDER when its own variable (DEEPSEEK_API_KEY, …) is not set. */
  AI_API_KEY: z.string().optional(),
  /** OpenAI-compatible endpoint override (required for AI_PROVIDER=custom). */
  AI_BASE_URL: z.string().optional(),
  /** An optional second model for screenshots and PDFs when the main one cannot read images. */
  AI_VISION_PROVIDER: z.enum([...AI_PROVIDER_IDS, "none"]).default("none"),
  AI_VISION_MODEL: z.string().optional(),
  AI_VISION_API_KEY: z.string().optional(),
  AI_VISION_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  DASHSCOPE_API_KEY: z.string().optional(),
  MOONSHOT_API_KEY: z.string().optional(),
  TOGETHER_API_KEY: z.string().optional(),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(25),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanString,
  RUN_WORKER_IN_PROCESS: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  CRON_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Expense Wise <alerts@example.com>"),
  /** Where support requests and operational alerts go. */
  SUPPORT_EMAIL: z.string().optional(),
  /** Sign-in waits for a verified email. Defaults to on in production. */
  REQUIRE_EMAIL_VERIFICATION: z.enum(["true", "false", "1", "0", ""]).optional(),
  /** "Continue with Google" appears when both are set. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Error reports go to Sentry (or any Sentry-compatible service) when set. */
  SENTRY_DSN: z.string().optional(),
  /** `json` writes one JSON object per log line, for log collectors. */
  LOG_FORMAT: z.enum(["text", "json"]).default("text"),
  /** Express "trust proxy": hops of reverse proxies in front of the API (the web server counts as one). */
  TRUST_PROXY: z.string().default("1"),
  /** Earlier ENCRYPTION_KEY values (comma-separated), still accepted for decryption after a rotation. */
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  if (parsed.data.STORAGE_DRIVER === "s3" && !parsed.data.S3_BUCKET) {
    throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET");
  }
  return parsed.data;
}

export const env = load();

/** Email verification is required in production unless REQUIRE_EMAIL_VERIFICATION says otherwise. */
export const requireEmailVerification = env.REQUIRE_EMAIL_VERIFICATION
  ? env.REQUIRE_EMAIL_VERIFICATION === "true" || env.REQUIRE_EMAIL_VERIFICATION === "1"
  : env.NODE_ENV === "production";

/** An environment variable holding an AI provider key (named in the provider presets). */
export function envKey(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
