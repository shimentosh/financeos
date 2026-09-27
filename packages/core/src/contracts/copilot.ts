import { z } from "zod";
import { uuid } from "./common.ts";

export const copilotAskInput = z.object({
  threadId: uuid.optional(),
  message: z.string().trim().min(1).max(2000),
});
export type CopilotAskInput = z.input<typeof copilotAskInput>;

/** A record the answer was computed from; every answer links to its evidence. */
export type CopilotSource = { label: string; href: string };

/** A figure shown beside the answer, exactly as the ledger computed it. */
export type CopilotFact = {
  label: string;
  value: string;
  href?: string | null;
  tone?: "positive" | "negative" | "warning" | null;
  /** Projections and forecasts are labelled as estimates. */
  estimate?: boolean;
};

export type CopilotMessageData = {
  /** `ai` when the model answered through the query tools; `deterministic` for the built-in answers. */
  mode?: "ai" | "deterministic";
  intent?: string;
  facts?: CopilotFact[];
  sources?: CopilotSource[];
  toolCalls?: Array<{ name: string; input: unknown; ok: boolean }>;
  /** Why the model was not used, when it was not. */
  fallbackReason?: string | null;
  model?: string | null;
  costUsd?: number;
  followUps?: string[];
  /** Changes prepared in this answer, each confirmed or discarded by the user. */
  actions?: CopilotAction[];
  /** Context saved to the assistant's memory during this answer. */
  remembered?: Array<{ id: string; text: string }>;
};

export type CopilotMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  data: CopilotMessageData;
  createdAt: string;
};

export type CopilotThreadView = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type CopilotAskResult = {
  thread: CopilotThreadView;
  question: CopilotMessageView;
  answer: CopilotMessageView;
  /** Earlier messages whose suggestions this answer confirmed or discarded ("yes" / "no"). */
  updated?: CopilotMessageView[];
};

/** Confirm or discard suggestions; all the message's open ones when `actionIds` is left out. */
export const copilotActionsInput = z.object({ actionIds: z.array(uuid).min(1).max(20).optional() });
export type CopilotActionsInput = z.input<typeof copilotActionsInput>;

// ------------------------------------------------------------------ actions

/**
 * Changes the copilot can prepare. In the chat each one is a proposal the
 * user confirms (a card, or "yes"); nothing is written before that. Over MCP
 * an API key with the write scope applies them directly.
 */
export const COPILOT_ACTION_KINDS = [
  "record_transaction",
  "update_transaction",
  "create_category",
  "create_account",
  "create_project",
  "create_subscription",
  "create_recurring",
  "create_budget",
  "create_goal",
  "create_rule",
  "create_receivable",
  "create_liability",
] as const;
export type CopilotActionKind = (typeof COPILOT_ACTION_KINDS)[number];

export type CopilotActionStatus = "proposed" | "applying" | "applied" | "discarded" | "failed";

export type CopilotAction = {
  id: string;
  kind: CopilotActionKind;
  /** "Record an expense", "Create a category". */
  title: string;
  /** One line: "৳500.00 at Foodpanda from bKash, 26 Sep". */
  summary: string;
  details: Array<{ label: string; value: string }>;
  warnings: string[];
  /** Actions in the same answer that must be applied first (a category this transaction uses). */
  dependsOn: string[];
  /** The validated request, names already resolved to ids. */
  payload: Record<string, unknown>;
  status: CopilotActionStatus;
  result: { id: string; label: string; href: string | null } | null;
  error: string | null;
  updatedAt: string | null;
};

/** What the chat returns after confirming or discarding. */
export type CopilotActionOutcome = { message: CopilotMessageView; actions: CopilotAction[] };

// ------------------------------------------------------------------- memory

/** Context the user asked the assistant to keep: "my salary lands in BRAC on the 5th". */
export const agentMemoryInput = z.object({ text: z.string().trim().min(2, "Write what to remember").max(300) });
export type AgentMemoryInput = z.input<typeof agentMemoryInput>;
export type AgentMemoryItem = { id: string; text: string; createdAt: string; createdBy: string | null };
export const AGENT_MEMORY_LIMIT = 60;
