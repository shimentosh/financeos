import { RoutingProvider } from "./router.provider.js";
import type { AiProvider } from "./types.js";

/**
 * The AI provider: whichever model is saved in Admin → AI, or the one .env
 * names, reloaded as it changes. Tests replace AI_PROVIDER with a fake.
 */
export async function createAiProvider(): Promise<AiProvider> {
  const provider = new RoutingProvider();
  await provider.refresh();
  if (process.env.NODE_ENV !== "test") provider.startPolling();
  return provider;
}
