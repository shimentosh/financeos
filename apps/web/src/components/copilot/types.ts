import type { CopilotMessageView, CopilotThreadView } from "@expensewise/core";

export type CopilotThreadList = {
  items: CopilotThreadView[];
  suggestions: string[];
  ai: { available: boolean; reason: "not_configured" | "disabled" | "budget" | "credits" | null; model: string | null };
};

export type CopilotThreadDetail = { thread: CopilotThreadView; messages: CopilotMessageView[] };
