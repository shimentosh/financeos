import type { AgentMemoryItem } from "@expensewise/core";

// Shapes of the JSONB columns. JSONB holds flexible metadata and configuration;
// every figure that is summed or reported lives in a typed column instead.

export type WorkspaceSettings = {
  /** Days before a due date to remind, e.g. [30, 14, 7, 3, 1, 0]. */
  reminderOffsets?: number[];
  /** Posted amounts at or above this (base currency, minor units) need review. */
  reviewThreshold?: number | null;
  /** Post AI captures without review when every field is high-confidence. */
  autoPostHighConfidence?: boolean;
  /** AI features on/off for this workspace. */
  aiEnabled?: boolean;
  /** Monthly AI spend ceiling in USD; overrides AI_MONTHLY_BUDGET_USD. */
  aiMonthlyBudgetUsd?: number | null;
  /** Warn when forecast cash drops below this (base currency, minor units). */
  lowCashThreshold?: number | null;
  /** Auto-detect subscriptions from captures and create them without asking. */
  autoCreateDetectedSubscriptions?: boolean;
  /** Context the user asked the assistant to keep, shown to it in every conversation. */
  agentMemory?: AgentMemoryItem[];
};

export type UserPreferences = {
  theme?: "system" | "light" | "dark";
  /** `en-IN` groups as 1,00,000 (lakh); `en-US` as 100,000. */
  numberLocale?: "en-IN" | "en-US";
  weekStartsOn?: 0 | 1 | 6;
  dashboard?: { hidden?: string[]; order?: string[]; period?: string };
  notifications?: { email?: boolean; inApp?: boolean };
  sidebarCollapsed?: boolean;
  /** `false` from sign-up until first-run setup is done; absent for accounts from before it existed. */
  onboarded?: boolean;
};

export type FieldConfidence = Partial<
  Record<
    "amount" | "currency" | "date" | "time" | "merchant" | "reference" | "type" | "category" | "account" | "project" | "workspace" | "subscription",
    number
  >
>;

export type AiConfidence = {
  overall: number;
  fields: FieldConfidence;
  /** Which layer decided each field: rules and merchant memory beat the model. */
  sources?: Partial<Record<keyof FieldConfidence, "rule" | "merchant" | "ai" | "parser" | "user">>;
  model?: string;
};

export type RuleField = "merchant" | "description" | "amount" | "currency" | "account" | "source" | "type" | "reference";

export type RuleOperator = "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "ends_with" | "gt" | "gte" | "lt" | "lte" | "between";

export type RuleCondition = {
  field: RuleField;
  operator: RuleOperator;
  /** Strings compare case-insensitively; amounts are minor units. */
  value: string | number;
  value2?: number;
};

export type RuleActions = {
  categoryId?: string;
  projectId?: string;
  accountId?: string;
  type?: "expense" | "income" | "transfer" | "refund" | "investment" | "asset_purchase" | "debt_payment";
  merchant?: string;
  requireReview?: boolean;
  /** Skip importing matching records altogether (e.g. internal test charges). */
  ignore?: boolean;
  note?: string;
};

export type ImportMapping = {
  date?: string;
  description?: string;
  merchant?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  currency?: string;
  category?: string;
  reference?: string;
  type?: string;
  balance?: string;
};

export type ImportOptions = {
  dateFormat?: "auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" | "DD-MM-YYYY" | "DD.MM.YYYY";
  /** How a single amount column encodes direction. */
  amountSign?: "negative_is_expense" | "positive_is_expense";
  defaultCurrency?: string;
  defaultCategoryId?: string | null;
  defaultProjectId?: string | null;
  skipRows?: number;
  sheet?: string;
};

export type ConnectionConfig = Record<string, unknown>;

export type SyncErrorDetail = { externalId?: string; message: string };

export type InboxData = {
  transactionIds?: string[];
  matchTransactionId?: string;
  score?: number;
  reasons?: string[];
  merchant?: string;
  amount?: number;
  currency?: string;
  cadence?: string;
  commitmentId?: string;
  subscriptionId?: string;
  occurrenceId?: string;
  previousAmount?: number;
  newAmount?: number;
  percentChange?: number;
  connectionId?: string;
  budgetId?: string;
  categoryId?: string;
  projectId?: string;
  metric?: string;
  expected?: number;
  actual?: number;
  href?: string;
  [key: string]: unknown;
};
