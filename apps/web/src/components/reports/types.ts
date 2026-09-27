export type Statement = { income: number; expenses: number; net: number; rate: number | null };

export type Compare = {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  current: Statement;
  previous: Statement;
  incomeChangePct: number | null;
  expenseChangePct: number | null;
  netChangePct: number | null;
};

export type CategoryShare = {
  categoryId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  amount: number;
  count: number;
  share: number;
  href: string;
};
export type Merchant = { counterpartyId: string | null; name: string; amount: number; count: number; href: string };
export type MonthPoint = { month: string; income: number; expenses: number; net: number };

export type CashFlowStatement = {
  opening: number;
  income: number;
  expenses: number;
  refunds: number;
  debtPayments: number;
  borrowing: number;
  lending: number;
  collections: number;
  investing: number;
  equity: number;
  transfersIn: number;
  transfersOut: number;
  adjustments: number;
  closing: number;
  net: number;
};

export type CashFlow = {
  range: { from: string; to: string };
  accounts: Array<{ id: string; name: string; currency: string }>;
  statement: CashFlowStatement;
  closingByBalances: number;
  fxDifference: number;
  unconvertedAccounts: number;
  label: "actual";
};

export type CashFlowPoint = { month: string; moneyIn: number; moneyOut: number; net: number; closing: number };

export type Forecast = {
  startBalance: number;
  days: Array<{ date: string; balance: number; low: number; high: number; inflow: number; outflow: number }>;
  endBalance: number;
  lowest: { date: string; balance: number };
  scheduledIn: number;
  scheduledOut: number;
  discretionaryOut: number;
  events: Array<{ date: string; amount: number; label: string; kind: string; certainty: "confirmed" | "expected"; ref?: string }>;
  assumptions: string[];
  horizonDays: number;
  label: "estimate";
  threshold: number;
  belowThreshold: boolean;
  unconvertedAccounts: number;
  windows: Array<{ days: number; endBalance: number; low: number; high: number; lowest: { date: string; balance: number } }>;
};

export type ReportSummary = {
  id: string;
  kind: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  narrativeSource: "ai" | "template";
  createdAt: string;
};

export type ReportData = {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  baseCurrency: string;
  workspaceKind: "personal" | "business";
  income: number;
  expenses: number;
  net: number;
  rate: number | null;
  previous: { income: number; expenses: number; net: number };
  categories: CategoryShare[];
  incomeCategories: CategoryShare[];
  categoryChanges: Array<{ name: string; current: number; previous: number; change: number; href: string }>;
  topMerchants: Merchant[];
  cashFlow: CashFlowStatement;
  netWorth: { value: number; previous: number | null; changePct: number | null; complete: boolean } | null;
  receivables: { outstanding: number; overdue: number; count: number };
  payables: { outstanding: number; count: number };
  goals: Array<{ id: string; name: string; progress: number; current: number; target: number; currency: string; href: string }>;
  projects: Array<{ id: string; name: string; revenue: number; cost: number; net: number; budgetUsed: number | null; href: string }>;
  recurringMonthly: number;
  recurringCount: number;
  anomalies: Array<{ title: string; body: string | null; href: string | null }>;
  links: { expenses: string; income: string; all: string };
};

export type Report = ReportSummary & { data: ReportData; narrative: string | null; provider: string | null; model: string | null };
