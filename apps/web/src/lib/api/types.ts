import type { AccountKind, Direction, MemberRole, TransactionSource, TransactionStatus, TransactionType, WorkspaceKind } from "@financeos/core";

// Response shapes of the ledger and workspace endpoints. Domain areas add
// their own files next to this one (types/<area>.ts).

export type Me = {
  user: { id: string; name: string; email: string; role: string; image?: string | null; isAdmin: boolean };
  workspaces: Array<{ id: string; name: string; kind: WorkspaceKind; baseCurrency: string; role: MemberRole }>;
  activeWorkspaceId: string | null;
  preferences: {
    theme?: "system" | "light" | "dark";
    numberLocale?: "en-IN" | "en-US";
    weekStartsOn?: 0 | 1 | 6;
    dashboard?: { hidden?: string[]; order?: string[]; period?: string };
    notifications?: { email?: boolean; inApp?: boolean };
    sidebarCollapsed?: boolean;
  };
};

export type WorkspaceSettings = {
  reminderOffsets?: number[];
  reviewThreshold?: number | null;
  autoPostHighConfidence?: boolean;
  aiEnabled?: boolean;
  aiMonthlyBudgetUsd?: number | null;
  lowCashThreshold?: number | null;
  autoCreateDetectedSubscriptions?: boolean;
};

export type CurrentWorkspace = {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: MemberRole;
  baseCurrency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  settings: WorkspaceSettings;
};

export type Account = {
  id: string;
  workspaceId: string;
  name: string;
  kind: AccountKind;
  provider: string | null;
  institution: string | null;
  mask: string | null;
  currency: string;
  openingBalance: number;
  openingDate: string;
  creditLimit: number | null;
  isLiability: boolean;
  includeInNetWorth: boolean;
  status: "active" | "archived";
  color: string | null;
  notes: string | null;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
  sortOrder: number;
  balance: number;
  baseBalance: number | null;
  entryCount: number;
  lastActivity: string | null;
};

export type AccountDetail = Account & { history: Array<{ month: string; balance: number }> };

export type Category = {
  id: string;
  name: string;
  kind: "expense" | "income";
  parentId: string | null;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
  archived: boolean;
  sortOrder: number;
};

export type Project = {
  id: string;
  name: string;
  code: string | null;
  status: "active" | "paused" | "completed" | "archived";
  color: string | null;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetAmount: number | null;
  isDefault: boolean;
};

export type AiConfidence = {
  overall: number;
  fields: Partial<Record<string, number>>;
  sources?: Partial<Record<string, "rule" | "merchant" | "ai" | "parser" | "user">>;
  model?: string;
};

export type Transaction = {
  id: string;
  workspaceId: string;
  type: TransactionType;
  direction: Direction;
  status: TransactionStatus;
  accountId: string | null;
  toAccountId: string | null;
  amount: number;
  currency: string;
  accountAmount: number | null;
  toAccountAmount: number | null;
  fxRate: string | null;
  baseAmount: number | null;
  baseCurrency: string | null;
  date: string;
  occurredAt: string | null;
  merchant: string | null;
  counterpartyId: string | null;
  categoryId: string | null;
  projectId: string | null;
  description: string | null;
  notes: string | null;
  reference: string | null;
  source: TransactionSource;
  sourceRef: string | null;
  externalId: string | null;
  connectionId: string | null;
  attachmentFileId: string | null;
  aiConfidence: AiConfidence | null;
  metadata: Record<string, unknown>;
  costBasis: number | null;
  liabilityId: string | null;
  receivableId: string | null;
  assetId: string | null;
  investmentId: string | null;
  linkedTransactionId: string | null;
  reviewReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
  voidedAt: string | null;
};

export type TransactionListItem = Transaction & {
  accountName: string | null;
  accountCurrency: string | null;
  toAccountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectName: string | null;
  projectColor: string | null;
  counterpartyName: string | null;
};

export type TransactionPage = {
  items: TransactionListItem[];
  total: number;
  page: number;
  pageSize: number;
  totals: { income: number; expense: number; moneyIn: number; moneyOut: number; currency: string };
};

export type DuplicateMatch = { id: string; score: number; exact: boolean; reasons: string[]; transaction: Transaction };

export type TransactionDetail = TransactionListItem & {
  entries: Array<{ id: string; accountId: string; accountName: string; amount: number; currency: string; baseAmount: number; date: string }>;
  attachments: Array<{ id: string; filename: string; contentType: string; size: number }>;
  history: Array<{
    id: string;
    action: string;
    actorType: string;
    actorId: string | null;
    createdAt: string;
    source: string | null;
    before: unknown;
    after: unknown;
  }>;
  commitment: { id: string; commitmentId: string; dueDate: string; name: string; kind: string } | null;
  possibleDuplicates: DuplicateMatch[];
};

export type Counterparty = {
  id: string;
  name: string;
  kind: string;
  defaultCategoryId: string | null;
  defaultProjectId: string | null;
  confirmations: number;
  lastSeenAt: string | null;
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: "all" | "any";
  conditions: Array<{ field: string; operator: string; value: string | number; value2?: number }>;
  actions: {
    categoryId?: string;
    projectId?: string;
    accountId?: string;
    type?: string;
    merchant?: string;
    requireReview?: boolean;
    ignore?: boolean;
    note?: string;
  };
  stopProcessing: boolean;
  timesApplied: number;
  lastAppliedAt: string | null;
};

export type ExchangeRate = {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  date: string;
  source: "manual" | "seed" | "api" | "transaction";
};

export type Notification = {
  id: string;
  kind: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};
