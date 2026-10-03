// Response shapes of the business endpoints: /projects/finance,
// /projects/:id/finance, /revenue, /payroll/*. Money is base-currency minor
// units unless a row carries its own `currency`.

/** Where a number comes from: the list and filters that show its records. */
export type Drill = {
  target: "transactions" | "receivables" | "payables" | "commitments";
  query: Record<string, string | string[]>;
};

export type Figure = { amount: number; drill: Drill };

export type Range = { from: string | null; to: string };

export type CostGroup = "operating" | "development" | "ai_api" | "hosting" | "marketing" | "payroll" | "other";

export type RecurringItem = {
  commitmentId: string;
  name: string;
  kind: string;
  amount: number;
  currency: string;
  frequency: string;
  nextDueDate: string | null;
  monthly: number;
  baseMonthly: number | null;
};

export type RecurringSummary = {
  amount: number;
  items: RecurringItem[];
  unconvertible: Array<{
    commitmentId: string;
    name: string;
    currency: string;
    monthly: number;
  }>;
  drill: Drill;
};

export type ProjectInfo = {
  id: string;
  name: string;
  code: string | null;
  status: "active" | "paused" | "completed" | "archived";
  color: string | null;
  isDefault: boolean;
  startDate?: string | null;
  endDate?: string | null;
  budgetAmount: number | null;
};

export type OpenBalances = {
  outstanding: number;
  overdue: number;
  count: number;
  overdueCount: number;
  drill: Drill;
};

export type ProjectProfile = {
  project: ProjectInfo;
  currency: string;
  range: Range;
  actual: {
    revenue: Figure;
    cost: Figure;
    netContribution: Figure;
    margin: number | null;
    capitalInvested: Figure;
    ownerDrawings: Figure;
    costByGroup: Array<{
      group: CostGroup;
      label: string;
      amount: number;
      share: number | null;
      categoryIds: string[];
      drill: Drill;
    }>;
    costByCategory: Array<{
      categoryId: string | null;
      name: string;
      group: CostGroup;
      amount: number;
      share: number | null;
      drill: Drill;
    }>;
    revenueByCategory: Array<{
      categoryId: string | null;
      name: string;
      amount: number;
      share: number | null;
      drill: Drill;
    }>;
    revenueByMonth: Array<{
      month: string;
      amount: number;
      drill: Drill;
      categories: Array<{ categoryId: string | null; name: string; amount: number; drill: Drill }>;
    }>;
    topVendors: Array<{
      counterpartyId: string | null;
      name: string;
      amount: number;
      count: number;
      drill: Drill;
    }>;
    monthly: Array<{
      month: string;
      revenue: number;
      cost: number;
      net: number;
      drill: { revenue: Drill; cost: Drill };
    }>;
    burn: { monthlyBurn: Figure; netBurn: Figure; months: string[] };
    budget: {
      amount: number;
      spent: Figure;
      utilization: number | null;
      remaining: number | null;
    } | null;
    lifetime: {
      revenue: Figure;
      cost: Figure;
      netContribution: number;
      capitalInvested: Figure;
    };
    receivables: OpenBalances;
    payables: OpenBalances;
  };
  estimated: {
    runwayMonths: number | null;
    runwayBasis: string | null;
    runwayUnavailableReason: string | null;
    recurringMonthlyCost: RecurringSummary;
    expectedRecurringRevenue: RecurringSummary;
  };
  warnings: string[];
};

export type ProjectOverviewRow = {
  project: ProjectInfo;
  actual: {
    revenue: Figure;
    cost: Figure;
    netContribution: number;
    margin: number | null;
    capitalInvested: Figure;
    monthlyBurn: number;
    netBurn: number;
    budget: {
      amount: number;
      spent: number;
      utilization: number | null;
      remaining: number | null;
    } | null;
    receivablesOutstanding: number;
    payablesOutstanding: number;
  };
  estimated: { runwayMonths: number | null; recurringMonthlyCost: number };
};

export type ProjectOverview = {
  currency: string;
  range: Range;
  projects: ProjectOverviewRow[];
  unassigned: { revenue: Figure; cost: Figure };
  totals: {
    revenue: number;
    cost: number;
    netContribution: number;
    capitalInvested: number;
    monthlyBurn: number;
    receivablesOutstanding: number;
    payablesOutstanding: number;
    recurringMonthlyCost: number;
  };
};

type Share = {
  amount: number;
  count: number;
  share: number | null;
  drill: Drill;
};

export type RevenueAnalytics = {
  currency: string;
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  totals: {
    revenue: number;
    gross: number;
    refunds: number;
    transactionCount: number;
    previous: number;
    change: number;
    changePercent: number | null;
    drill: Drill;
    previousDrill: Drill;
  };
  byMonth: Array<{ month: string; amount: number; drill: Drill }>;
  byProject: Array<{ projectId: string | null; name: string } & Share>;
  bySource: Array<
    {
      source: string;
      connectionId: string | null;
      provider: string | null;
      label: string;
    } & Share
  >;
  byCustomer: Array<{ counterpartyId: string | null; name: string } & Share>;
  byCategory: Array<{ categoryId: string | null; name: string } & Share>;
  expectedRecurring: {
    label: "expected";
    monthly: number;
    annualized: number;
    items: Array<RecurringItem & { projectId: string | null }>;
    unconvertible: Array<{
      commitmentId: string;
      name: string;
      currency: string;
      monthly: number;
    }>;
    drill: Drill;
  };
};

// ------------------------------------------------------------------ payroll

export type EmploymentType = "full_time" | "part_time" | "contractor" | "intern";

export type Employee = {
  id: string;
  counterpartyId: string | null;
  name: string;
  title: string | null;
  employmentType: EmploymentType;
  salary: number;
  currency: string;
  payDay: number;
  defaultProjectId: string | null;
  accountId: string | null;
  startDate: string | null;
  endDate: string | null;
  status: "active" | "inactive";
  notes: string | null;
  projectName: string | null;
  accountName: string | null;
  counterpartyName: string | null;
};

export type EmployeeList = {
  items: Employee[];
  totals: {
    activeCount: number;
    monthlySalaryByCurrency: Array<{
      currency: string;
      count: number;
      monthlySalary: number;
    }>;
  };
};

export type EmployeeDetail = Employee & {
  payrollHistory: Array<{
    itemId: string;
    runId: string;
    period: string;
    payDate: string;
    runStatus: "draft" | "posted";
    gross: number;
    deductions: number;
    net: number;
    transactionId: string | null;
  }>;
  /** The last months they were employed, newest first, with whether each salary is paid. */
  months: Array<{
    period: string;
    status: "paid" | "unpaid";
    amount: number;
    currency: string;
    paidOn: string | null;
    transactionId: string | null;
  }>;
  commitments: Array<{
    id: string;
    name: string;
    kind: string;
    amount: number;
    currency: string;
    nextDueDate: string | null;
    status: string;
  }>;
};

export type PayrollRun = {
  id: string;
  period: string;
  status: "draft" | "posted";
  payDate: string;
  totalNet: number;
  currency: string;
  postedAt: string | null;
  createdAt: string;
  itemCount: number;
  totals: {
    net: number;
    currency: string;
    byCurrency: Array<{
      currency: string;
      count: number;
      gross: number;
      deductions: number;
      net: number;
    }>;
  };
};

export type PayrollItem = {
  id: string;
  runId: string;
  employeeId: string;
  gross: number;
  deductions: number;
  net: number;
  projectId: string | null;
  accountId: string | null;
  transactionId: string | null;
  note: string | null;
  employeeName: string;
  employeeTitle: string | null;
  currency: string;
  counterpartyId: string | null;
  projectName: string | null;
  accountName: string | null;
  transactionStatus: string | null;
};

export type PayrollRunDetail = PayrollRun & { items: PayrollItem[] };
