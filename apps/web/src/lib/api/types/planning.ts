import type { CommitmentKind, Frequency, GoalKind, IntervalUnit, OccurrenceStatus, SubscriptionStatus } from "@financeos/core";

// Response shapes of the planning endpoints: /commitments, /occurrences,
// /subscriptions, /budgets, /goals. Money is minor units; `*Base` fields are in
// the workspace base currency and null when no exchange rate exists.

export type Direction = "in" | "out";
export type CommitmentStatus = "active" | "paused" | "ended";
export type BillingCycle = "monthly" | "quarterly" | "half_yearly" | "yearly" | "custom";
export type PriceChange = {
  previous: number;
  current: number;
  difference: number;
  percent: number | null;
  direction: "increase" | "decrease";
};

// -------------------------------------------------------------- commitments

export type CommitmentRow = {
  id: string;
  workspaceId: string;
  kind: CommitmentKind;
  direction: Direction;
  name: string;
  counterpartyId: string | null;
  payee: string | null;
  amount: number;
  currency: string;
  frequency: Frequency;
  intervalCount: number;
  intervalUnit: IntervalUnit | null;
  startDate: string;
  endDate: string | null;
  nextDueDate: string | null;
  accountId: string | null;
  categoryId: string | null;
  projectId: string | null;
  liabilityId: string | null;
  autoPay: boolean;
  status: CommitmentStatus;
  reminderOffsets: number[] | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommitmentView = CommitmentRow & {
  kindLabel: string;
  frequencyLabel: string;
  accountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectName: string | null;
  projectColor: string | null;
  counterpartyName: string | null;
  liabilityName: string | null;
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  baseCurrency: string;
  baseAmount: number | null;
  monthlyEquivalent: number;
  monthlyEquivalentBase: number | null;
  annualized: number;
  annualizedBase: number | null;
  nextOccurrence: {
    id: string;
    dueDate: string;
    amount: number;
    currency: string;
    status: OccurrenceStatus;
  } | null;
  daysUntilDue: number | null;
  overdue: boolean;
  effectiveReminderOffsets: number[];
  links: {
    self: string;
    commitment: string;
    subscription: string | null;
    transactions: string;
  };
};

export type CommitmentList = {
  items: CommitmentView[];
  total: number;
  totals: {
    currency: string;
    monthlyOut: number;
    monthlyIn: number;
    annualOut: number;
    annualIn: number;
    unconverted: Array<{
      currency: string;
      monthly: number;
      annual: number;
      direction: Direction;
    }>;
  };
};

export type OccurrenceRow = {
  id: string;
  workspaceId: string;
  commitmentId: string;
  dueDate: string;
  amount: number;
  currency: string;
  status: OccurrenceStatus;
  transactionId: string | null;
  paidOn: string | null;
  paidAmount: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OccurrenceView = OccurrenceRow & {
  overdue: boolean;
  daysUntil: number;
  transaction: {
    id: string;
    type: string;
    direction: Direction;
    status: string;
    date: string;
    amount: number;
    currency: string;
    baseAmount: number | null;
    baseCurrency: string | null;
    accountId: string | null;
    accountName: string | null;
    merchant: string | null;
    source: string;
    createdByPayment: boolean;
    href: string;
  } | null;
  priceChange:
    | (PriceChange & {
        previousOccurrenceId: string;
        previousTransactionId: string | null;
      })
    | null;
};

export type OccurrenceStats = {
  paidCount: number;
  skippedCount: number;
  scheduledCount: number;
  totalPaid: number;
  totalPaidBase: number;
  lastPaidOn: string | null;
  transactionsHref: string | null;
};

export type ProjectedDue = { date: string; amount: number; currency: string };

export type CommitmentDetail = CommitmentView & {
  occurrences: OccurrenceView[];
  stats: OccurrenceStats;
  upcoming: ProjectedDue[];
};

export type ScheduleItemStatus = "scheduled" | "overdue" | "projected" | "paid" | "skipped" | "cancelled";

export type ScheduleItem = {
  key: string;
  date: string;
  status: ScheduleItemStatus;
  commitmentId: string;
  occurrenceId: string | null;
  subscriptionId: string | null;
  name: string;
  kind: CommitmentKind;
  kindLabel: string;
  direction: Direction;
  amount: number;
  currency: string;
  baseAmount: number | null;
  baseCurrency: string;
  autoPay: boolean;
  daysUntil: number;
  paidAmount: number | null;
  paidOn: string | null;
  transactionId: string | null;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectId: string | null;
  projectName: string | null;
  href: string;
};

export type ScheduleTotals = {
  count: number;
  out: number;
  in: number;
  paidOut: number;
  paidIn: number;
  overdueCount: number;
  unconverted: Array<{
    currency: string;
    amount: number;
    direction: Direction;
    paid: boolean;
  }>;
};

export type ScheduleDay = {
  date: string;
  items: ScheduleItem[];
  totalOut: number;
  totalIn: number;
  paidOut: number;
  paidIn: number;
  unconverted: ScheduleTotals["unconverted"];
};

export type Upcoming = {
  today: string;
  from: string;
  to: string;
  days: number;
  baseCurrency: string;
  totals: ScheduleTotals;
  items: ScheduleItem[];
  groups: ScheduleDay[];
};

export type CalendarData = {
  from: string;
  to: string;
  today: string;
  baseCurrency: string;
  totals: ScheduleTotals;
  items: ScheduleItem[];
  days: ScheduleDay[];
};

export type AnnualBucket = {
  count: number;
  annualized: number;
  inYear: number;
  monthlyEquivalent: number;
};

export type AnnualCommitments = {
  year: number;
  from: string;
  to: string;
  baseCurrency: string;
  totals: { out: AnnualBucket; in: AnnualBucket };
  byKind: Array<
    AnnualBucket & {
      kind: CommitmentKind;
      kindLabel: string;
      direction: Direction;
    }
  >;
  byCategory: Array<
    AnnualBucket & {
      categoryId: string | null;
      categoryName: string | null;
      direction: Direction;
    }
  >;
  items: Array<{
    commitmentId: string;
    subscriptionId: string | null;
    name: string;
    kind: CommitmentKind;
    kindLabel: string;
    direction: Direction;
    frequency: Frequency;
    frequencyLabel: string;
    amount: number;
    currency: string;
    occurrencesInYear: number;
    inYear: number;
    inYearBase: number | null;
    annualized: number;
    annualizedBase: number | null;
    monthlyEquivalent: number;
    monthlyEquivalentBase: number | null;
    categoryId: string | null;
    categoryName: string | null;
    projectId: string | null;
    projectName: string | null;
    href: string;
  }>;
  unconverted: Array<{
    commitmentId: string;
    name: string;
    direction: Direction;
    currency: string;
    annualized: number;
    inYear: number;
  }>;
};

// ---------------------------------------------------------------- payments

export type PaymentCandidate = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  baseAmount: number | null;
  type: string;
  status: string;
  merchant: string | null;
  description: string | null;
  accountId: string | null;
  accountName: string | null;
  score: number;
  exact: boolean;
  reasons: string[];
  href: string;
};

export type SubscriptionRow = {
  id: string;
  workspaceId: string;
  commitmentId: string;
  provider: string;
  planName: string | null;
  purchaseDate: string | null;
  startDate: string | null;
  trialEndsOn: string | null;
  expiryDate: string | null;
  cancellationDeadline: string | null;
  autoRenew: boolean;
  status: SubscriptionStatus;
  externalProviderId: string | null;
  attachmentFileId: string | null;
  cancelledAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarkPaidResult = {
  occurrence: OccurrenceRow;
  transaction: { id: string; amount: number; currency: string; date: string };
  created: boolean;
  commitment: CommitmentRow;
  nextOccurrence: OccurrenceRow | null;
  subscription: SubscriptionRow | null;
  priceChange: PriceChange | null;
  inboxItemId: string | null;
  amountUpdated: boolean;
};

export type MarkPaidBody = {
  paidOn: string;
  amount?: number;
  currency?: string;
  accountId?: string | null;
  existingTransactionId?: string | null;
  updateFutureAmount?: boolean;
  note?: string | null;
  force?: boolean;
  attachmentFileIds?: string[];
};

// ------------------------------------------------------------ subscriptions

export type SubscriptionView = SubscriptionRow & {
  name: string;
  derivedStatus: SubscriptionStatus;
  statusLabel: string;
  commitmentStatus: CommitmentStatus;
  amount: number;
  currency: string;
  billingCycle: BillingCycle;
  billingLabel: string;
  intervalCount: number;
  intervalUnit: IntervalUnit | null;
  nextRenewalDate: string | null;
  daysUntilRenewal: number | null;
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  reminderOffsets: number[] | null;
  baseCurrency: string;
  baseAmount: number | null;
  monthlyEquivalent: number;
  monthlyEquivalentBase: number | null;
  annualCost: number;
  annualCostBase: number | null;
  nextOccurrenceId: string | null;
  lastPayment: {
    occurrenceId: string;
    dueDate: string;
    paidOn: string | null;
    paidAmount: number | null;
    currency: string;
    transactionId: string | null;
  } | null;
  links: { self: string; commitment: string; transactions: string };
};

export type SubscriptionList = {
  items: SubscriptionView[];
  total: number;
  baseCurrency: string;
};

export type SubscriptionPriceChange = {
  occurrenceId: string;
  dueDate: string;
  paidOn: string | null;
  currency: string;
  previousOccurrenceId: string | null;
  previousTransactionId: string | null;
  transactionId: string | null;
  previous: number;
  current: number;
  difference: number;
  percent: number | null;
  direction: "increase" | "decrease";
};

export type SubscriptionDetail = SubscriptionView & {
  commitment: CommitmentRow;
  renewals: OccurrenceView[];
  priceChanges: SubscriptionPriceChange[];
  stats: OccurrenceStats;
  upcomingRenewals: ProjectedDue[];
};

type Group = { count: number; monthly: number; annual: number };

export type SubscriptionAnalytics = {
  baseCurrency: string;
  asOf: string;
  totalCount: number;
  activeCount: number;
  byStatus: Record<SubscriptionStatus, number>;
  monthlyTotal: number;
  annualTotal: number;
  annualCommitments: {
    count: number;
    total: number;
    unconverted: Array<{ currency: string; amount: number }>;
    items: Array<{
      subscriptionId: string;
      name: string;
      amount: number;
      currency: string;
      baseAmount: number | null;
      nextRenewalDate: string | null;
      autoRenew: boolean;
    }>;
  };
  upcoming30: {
    from: string;
    to: string;
    count: number;
    total: number;
    unconverted: Array<{ currency: string; amount: number }>;
    items: Array<{
      subscriptionId: string;
      name: string;
      date: string;
      amount: number;
      currency: string;
      baseAmount: number | null;
      autoRenew: boolean;
    }>;
  };
  overdue: {
    count: number;
    total: number;
    unconverted: Array<{ currency: string; amount: number }>;
  };
  byProject: Array<Group & { projectId: string | null; projectName: string | null }>;
  byCategory: Array<Group & { categoryId: string | null; categoryName: string | null }>;
  byBillingCycle: Array<Group & { billingCycle: BillingCycle }>;
  unconverted: Array<{
    subscriptionId: string;
    name: string;
    amount: number;
    currency: string;
    monthlyEquivalent: number;
    annualCost: number;
  }>;
};

// ------------------------------------------------------------------ budgets

export type BudgetPeriod = "monthly" | "quarterly" | "yearly" | "total";
export type BudgetStatus = "on_track" | "warning" | "over" | "under";

export type BudgetMetrics = {
  budget: number;
  actual: number;
  remaining: number;
  variance: number;
  utilization: number;
  status: BudgetStatus;
  projected: number | null;
  daysLeft: number;
};

export type BudgetDrilldown = {
  query: {
    from: string;
    to?: string;
    categoryId?: string;
    includeChildren?: boolean;
    projectId?: string;
    type: string[];
    status: string[];
  };
  href: string;
};

export type BudgetHistoryPoint = {
  from: string;
  to: string;
  budget: number;
  actual: number;
  remaining: number;
  utilization: number;
  status: BudgetStatus;
  drilldown: BudgetDrilldown;
};

export type BudgetView = {
  id: string;
  workspaceId: string;
  name: string;
  period: BudgetPeriod;
  amount: number;
  categoryId: string | null;
  projectId: string | null;
  startDate: string;
  endDate: string | null;
  alertThreshold: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  currency: string;
  scope: "workspace" | "category" | "project" | "category_project";
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  projectName: string | null;
  inEffect: boolean;
  range: { from: string; to: string };
  metrics: BudgetMetrics;
  drilldown: BudgetDrilldown;
  links: { self: string };
  history?: BudgetHistoryPoint[];
};

export type BudgetList = {
  date: string;
  baseCurrency: string;
  items: BudgetView[];
  total: number;
  summary: { inEffect: number; over: number; warning: number; onTrack: number };
};

export type BudgetDetail = BudgetView & {
  categoryIds: string[];
  history: BudgetHistoryPoint[];
};

// -------------------------------------------------------------------- goals

export type GoalStatus = "active" | "achieved" | "paused" | "archived";
export type Priority = "low" | "medium" | "high";

export type GoalProgress = {
  target: number;
  current: number;
  remaining: number;
  progress: number;
  requiredMonthly: number | null;
  monthsLeft: number | null;
  onTrack: boolean | null;
  projectedCompletion: string | null;
};

export type GoalView = {
  id: string;
  workspaceId: string;
  kind: GoalKind;
  name: string;
  targetAmount: number;
  currency: string;
  targetDate: string | null;
  priority: Priority;
  monthlyPlan: number | null;
  startingAmount: number;
  linkedAccountId: string | null;
  imageFileId: string | null;
  icon: string | null;
  notes: string | null;
  status: GoalStatus;
  achievedAt: string | null;
  createdAt: string;
  updatedAt: string;
  current: number;
  contributed: number;
  currentSource: "account" | "contributions";
  linkedAccountName: string | null;
  linkedAccountCurrency: string | null;
  accountUnconverted: boolean;
  progress: GoalProgress;
  isSavingsPlan: boolean;
  isDreamAsset: boolean;
  baseCurrency: string;
  targetBase: number | null;
  currentBase: number | null;
  links: { self: string };
};

export type GoalList = {
  items: GoalView[];
  total: number;
  baseCurrency: string;
  summary: {
    active: number;
    achieved: number;
    targetBase: number;
    currentBase: number;
    monthlyPlanned: number;
    unconverted: Array<{ goalId: string; currency: string }>;
  };
};

export type GoalContribution = {
  id: string;
  goalId: string;
  amount: number;
  date: string;
  note: string | null;
  transactionId: string | null;
  createdBy: string | null;
  createdAt: string;
  transaction: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    accountId: string | null;
    toAccountId: string | null;
  } | null;
  transactionHref: string | null;
};

export type GoalMonth = {
  month: string;
  planned: number | null;
  actual: number;
  deposits: number;
  withdrawals: number;
  cumulative: number;
  metPlan: boolean | null;
};

export type GoalDetail = GoalView & {
  contributions: GoalContribution[];
  monthly: GoalMonth[];
};

/** 409 body details for a payment that probably already exists. */
export type DuplicateIssues = { candidates: PaymentCandidate[] };
