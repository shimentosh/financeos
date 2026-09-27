import type { Direction, TransactionStatus, TransactionType } from "@expensewise/core";

// Response shapes of the wealth endpoints: /assets, /investments,
// /liabilities, /payables, /receivables, /net-worth. Money is minor units;
// `base*` fields are in the workspace base currency and null without a rate.

/** A transaction linked to a holding, debt or receivable (its history). */
export type LinkedTx = {
  id: string;
  type: TransactionType;
  direction: Direction;
  status: TransactionStatus;
  date: string;
  amount: number;
  currency: string;
  baseAmount: number | null;
  costBasis: number | null;
  accountId: string | null;
  accountName: string | null;
  description: string | null;
  notes: string | null;
  categoryId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown>;
};

export type Valuation = {
  id: string;
  value: number;
  date: string;
  note: string | null;
  createdAt: string;
};

// ------------------------------------------------------------------- assets

export type AssetKind = "equipment" | "electronics" | "vehicle" | "property" | "land" | "jewelry" | "business_asset" | "other";
export type AssetStatus = "owned" | "sold" | "disposed";

export type Asset = {
  id: string;
  name: string;
  kind: AssetKind;
  purchasePrice: number | null;
  currency: string;
  purchaseDate: string | null;
  currentValue: number;
  valuedAt: string | null;
  owner: string | null;
  projectId: string | null;
  status: AssetStatus;
  soldOn: string | null;
  soldAmount: number | null;
  notes: string | null;
  createdAt: string;
  projectName: string | null;
  gain: number | null;
  gainPercent: number | null;
  baseCurrentValue: number | null;
  basePurchasePrice: number | null;
  baseGain: number | null;
  valuationAgeDays: number | null;
};

export type AssetDetail = Asset & {
  valuations: Valuation[];
  transactions: LinkedTx[];
};

export type AssetList = {
  items: Asset[];
  totals: {
    currency: string;
    count: number;
    currentValue: number;
    purchasePrice: number;
    gain: number;
    realizedGain: number;
    byKind: Array<{ kind: AssetKind; count: number; currentValue: number }>;
  };
  unconvertible: Array<{
    id: string;
    name: string;
    currency: string;
    currentValue: number;
  }>;
};

export type SellResult = {
  asset: AssetDetail;
  proceedsTransactionId: string | null;
  realizedGain: number | null;
};

// -------------------------------------------------------------- investments

export type InvestmentKind =
  | "stock"
  | "mutual_fund"
  | "fixed_deposit"
  | "savings_certificate"
  | "bond"
  | "dps"
  | "gold"
  | "crypto"
  | "real_estate"
  | "business_equity"
  | "retirement"
  | "other";

export type InvestmentMetrics = {
  contributed: number;
  withdrawn: number;
  costBasis: number;
  currentValue: number | null;
  realizedGain: number;
  unrealizedGain: number | null;
  roi: number | null;
};

export type Investment = {
  id: string;
  name: string;
  kind: InvestmentKind;
  institution: string | null;
  currency: string;
  openedOn: string | null;
  maturityDate: string | null;
  interestRate: string | null;
  openingCostBasis: number;
  currentValue: number | null;
  valuedAt: string | null;
  status: "active" | "closed";
  notes: string | null;
  metrics: InvestmentMetrics;
  value: number;
  valueSource: "valuation" | "cost_basis";
  base: {
    value: number;
    costBasis: number;
    contributed: number;
    withdrawn: number;
    realizedGain: number;
    unrealizedGain: number | null;
  } | null;
  valuationOutdated: boolean;
  lastFlowDate: string | null;
  flowCount: number;
  unconvertedFlows: number;
};

export type InvestmentDetail = Investment & {
  valuations: Valuation[];
  flows: LinkedTx[];
};

export type PortfolioTotals = {
  count: number;
  valuedCount: number;
  contributed: number;
  withdrawn: number;
  costBasis: number;
  value: number;
  realizedGain: number;
  unrealizedGain: number;
  roi: number | null;
};

export type InvestmentList = {
  items: Investment[];
  byKind: Array<{ kind: InvestmentKind } & PortfolioTotals>;
  totals: { currency: string } & PortfolioTotals;
  unconvertible: Array<{
    id: string;
    name: string;
    currency: string;
    value: number;
  }>;
};

// -------------------------------------------------------------- liabilities

export type LiabilityKind = "loan" | "credit" | "personal_debt" | "business_debt" | "payable" | "mortgage" | "other";
export type LiabilityStatus = "active" | "paid_off" | "overdue" | "cancelled";

export type Liability = {
  id: string;
  kind: LiabilityKind;
  name: string;
  counterpartyId: string | null;
  counterpartyName: string | null;
  principal: number;
  currency: string;
  openingOutstanding: number;
  interestRate: string | null;
  startDate: string | null;
  dueDate: string | null;
  categoryId: string | null;
  projectId: string | null;
  accountId: string | null;
  notes: string | null;
  storedStatus: LiabilityStatus;
  status: LiabilityStatus;
  outstanding: number;
  paid: number;
  borrowed: number;
  total: number;
  interestPaid: number;
  baseOutstanding: number | null;
  daysOverdue: number;
  lastPaymentDate: string | null;
  counterparty: string | null;
  categoryName: string | null;
  projectName: string | null;
  unconvertedFlows: number;
};

export type LiabilityCommitment = {
  id: string;
  name: string;
  kind: string;
  amount: number;
  currency: string;
  frequency: string;
  nextDueDate: string | null;
  status: string;
  autoPay: boolean;
};

export type LiabilityDetail = Liability & {
  transactions: LinkedTx[];
  commitments: LiabilityCommitment[];
  nextDueDate: string | null;
};

export type LiabilityList = {
  items: Liability[];
  groups: Array<{
    kind: LiabilityKind;
    count: number;
    outstanding: number;
    overdueCount: number;
  }>;
  totals: {
    currency: string;
    count: number;
    outstanding: number;
    overdueCount: number;
    overdueOutstanding: number;
  };
  unconvertible: Array<{
    id: string;
    name: string;
    currency: string;
    outstanding: number;
  }>;
};

export type Payable = {
  id: string;
  kind: LiabilityKind;
  name: string;
  counterpartyId: string | null;
  counterparty: string | null;
  dueDate: string | null;
  currency: string;
  amount: number;
  paid: number;
  remaining: number;
  baseRemaining: number | null;
  categoryId: string | null;
  categoryName: string | null;
  projectId: string | null;
  projectName: string | null;
  status: LiabilityStatus;
  daysOverdue: number;
  lastPaymentDate: string | null;
  notes: string | null;
};

export type PayableList = {
  items: Payable[];
  totals: {
    currency: string;
    count: number;
    remaining: number;
    overdue: number;
    overdueCount: number;
    dueNext30Days: number;
  };
  unconvertible: Array<{
    id: string;
    name: string;
    currency: string;
    remaining: number;
  }>;
};

export type LiabilityPaymentResult = {
  principal: number;
  interest: number;
  principalTransactionId: string | null;
  interestTransactionId: string | null;
  liability: LiabilityDetail;
};

// -------------------------------------------------------------- receivables

export type ReceivableKind = "invoice" | "loan" | "other";
export type ReceivableStatus = "pending" | "partially_paid" | "paid" | "overdue" | "cancelled";
export type AgingBucket = "current" | "0-30" | "31-60" | "61-90" | "90+";

export type Receivable = {
  id: string;
  kind: ReceivableKind;
  counterpartyId: string | null;
  counterpartyName: string;
  title: string;
  reference: string | null;
  amount: number;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  projectId: string | null;
  categoryId: string | null;
  source: string;
  notes: string | null;
  storedStatus: ReceivableStatus;
  status: ReceivableStatus;
  paid: number;
  remaining: number;
  daysOverdue: number;
  baseAmount: number | null;
  baseRemaining: number | null;
  projectName: string | null;
  categoryName: string | null;
  lastPaymentDate: string | null;
  agingBucket: AgingBucket | null;
  unconvertedPayments: number;
};

export type ReceivableDetail = Receivable & { transactions: LinkedTx[] };

export type ReceivableList = {
  items: Receivable[];
  totals: {
    currency: string;
    count: number;
    outstanding: number;
    overdueAmount: number;
    overdueCount: number;
    byStatus: Record<ReceivableStatus, { count: number; amount: number; outstanding: number }>;
    aging: Record<AgingBucket, number>;
  };
  unconvertible: Array<{
    id: string;
    title: string;
    currency: string;
    remaining: number;
  }>;
};

// ---------------------------------------------------------------- net worth

export type NetWorthWarning = {
  code: "missing_rate" | "stale_valuation" | "no_valuation" | "no_accounts";
  message: string;
  entityId?: string;
};

export type NetWorthAssets = {
  cash: number;
  investments: number;
  assets: number;
  receivables: number;
  total: number;
};
export type NetWorthLiabilities = {
  accounts: number;
  debts: number;
  total: number;
  byKind: Partial<Record<LiabilityKind | "accounts", number>>;
};

export type NetWorthComponents = {
  accounts: Array<{
    id: string;
    name: string;
    kind: string;
    currency: string;
    balance: number;
    baseBalance: number | null;
    isLiability: boolean;
  }>;
  assets: Array<{
    id: string;
    name: string;
    kind: AssetKind;
    currency: string;
    value: number;
    baseValue: number | null;
    valuedAt: string | null;
    source: "valuation" | "purchase_price";
  }>;
  investments: Array<{
    id: string;
    name: string;
    kind: InvestmentKind;
    currency: string;
    value: number;
    baseValue: number | null;
    valuedAt: string | null;
    source: "valuation" | "cost_basis";
  }>;
  receivables: Array<{
    id: string;
    title: string;
    counterpartyName: string;
    currency: string;
    remaining: number;
    baseRemaining: number | null;
  }>;
  liabilities: Array<{
    id: string;
    name: string;
    kind: LiabilityKind;
    currency: string;
    outstanding: number;
    baseOutstanding: number | null;
  }>;
};

export type PreviousMonth = {
  month: string;
  asOf: string;
  netWorth: number;
  complete: boolean;
  hasData: boolean;
};

export type NetWorthCurrent = {
  asOf: string;
  currency: string;
  netWorth: number;
  complete: boolean;
  warnings: NetWorthWarning[];
  assets: NetWorthAssets;
  liabilities: NetWorthLiabilities;
  components: NetWorthComponents;
  previous: number | null;
  previousMonth: PreviousMonth;
  change: number | null;
  changePercent: number | null;
};

export type NetWorthPoint = {
  month: string;
  asOf: string;
  netWorth: number;
  complete: boolean;
  warningCount: number;
  hasData: boolean;
  assets: NetWorthAssets;
  liabilities: NetWorthLiabilities;
};

export type NetWorthHistory = {
  currency: string;
  months: number;
  points: NetWorthPoint[];
  current: { asOf: string; netWorth: number; complete: boolean };
  previous: number | null;
  previousMonth: PreviousMonth;
  change: number | null;
  changePercent: number | null;
  breakdown: { assets: NetWorthAssets; liabilities: NetWorthLiabilities };
  warnings: NetWorthWarning[];
};
