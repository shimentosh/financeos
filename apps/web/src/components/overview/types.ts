// Response of GET /analytics/overview — the dashboard's single read model.

export type OverviewData = {
  asOf: string;
  baseCurrency: string;
  workspaceKind: "personal" | "business";
  netWorth: {
    value: number;
    previous: number | null;
    change: number | null;
    changePct: number | null;
    complete: boolean;
    warnings: Array<{ code: string; message: string }>;
    assets: number;
    liabilities: number;
  } | null;
  cash: { total: number; accounts: number; unconverted: number };
  month: {
    from: string;
    to: string;
    income: number;
    expenses: number;
    net: number;
    savingsRate: number | null;
    incomeChangePct: number | null;
    expenseChangePct: number | null;
  };
  series: Array<{ month: string; income: number; expenses: number; net: number }>;
  topCategories: Array<{
    categoryId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    amount: number;
    count: number;
    share: number;
    href: string;
  }>;
  business: {
    revenue: number;
    revenueChangePct: number | null;
    burn: number;
    projects: Array<{ id: string; name: string; color: string | null; revenue: number; cost: number; net: number; budgetUsed: number | null; href: string }>;
  } | null;
  upcoming: Array<{
    id: string;
    date: string;
    name: string;
    kind: string;
    amount: number;
    currency: string;
    baseAmount: number | null;
    autoPay: boolean;
    overdue: boolean;
    direction: "in" | "out";
    href: string;
  }>;
  receivables: { outstanding: number; overdue: number; count: number; href: string };
  payables: { outstanding: number; count: number; href: string };
  goals: Array<{
    id: string;
    name: string;
    kind: string;
    progress: number;
    current: number;
    target: number;
    currency: string;
    targetDate: string | null;
    href: string;
  }>;
  insights: Array<{ id: string; kind: string; severity: string; title: string; body: string | null; href: string | null }>;
  integrations: {
    total: number;
    healthy: number;
    failing: number;
    lastSyncedAt: string | null;
    items: Array<{ id: string; name: string; provider: string; status: string; lastSyncedAt: string | null }>;
  };
  attention: { drafts: number; uncategorized: number; duplicates: number; overdueCommitments: number; overdueReceivables: number };
  forecast: { horizonDays: number; endBalance: number; lowest: { date: string; balance: number }; belowThreshold: boolean } | null;
};
