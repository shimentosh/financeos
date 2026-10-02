// The shared vocabulary. The database enums are built from these arrays, so the
// schema, the API contracts and the UI can never disagree about a value.

export const WORKSPACE_KINDS = ["personal", "business"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const ACCOUNT_KINDS = ["bank", "cash", "mobile_wallet", "card", "digital_wallet", "payment_processor", "savings", "loan", "other"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const TRANSACTION_TYPES = [
  "expense",
  "income",
  "transfer",
  "refund",
  "adjustment",
  "investment",
  "asset_purchase",
  "debt_payment",
  "loan",
  "equity",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const DIRECTIONS = ["in", "out"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const TRANSACTION_STATUSES = ["draft", "pending", "posted", "void"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_SOURCES = [
  "manual",
  "screenshot",
  "receipt",
  "text",
  "voice",
  "csv",
  "excel",
  "pdf",
  "integration",
  "webhook",
  "api",
  "recurring",
  "system",
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const CATEGORY_KINDS = ["expense", "income"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const COUNTERPARTY_KINDS = ["merchant", "customer", "vendor", "person", "employee", "institution", "other"] as const;

export const PROJECT_STATUSES = ["active", "paused", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const BUDGET_PERIODS = ["monthly", "quarterly", "yearly", "total"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const COMMITMENT_KINDS = [
  "subscription",
  "salary",
  "payroll",
  "rent",
  "loan_payment",
  "insurance",
  "tax",
  "utility",
  "domain",
  "hosting",
  "software",
  "contractor",
  "education",
  "income",
  "custom",
] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

export const FREQUENCIES = ["once", "weekly", "monthly", "quarterly", "half_yearly", "yearly", "custom"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const INTERVAL_UNITS = ["day", "week", "month", "year"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export const COMMITMENT_STATUSES = ["active", "paused", "ended"] as const;

export const SUBSCRIPTION_STATUSES = ["trial", "active", "renewal_due", "renewed", "cancellation_pending", "cancelled", "expired", "paused"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const OCCURRENCE_STATUSES = ["scheduled", "paid", "skipped", "cancelled"] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const RECEIVABLE_KINDS = ["invoice", "loan", "other"] as const;
export const RECEIVABLE_STATUSES = ["pending", "partially_paid", "paid", "overdue", "cancelled"] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];

export const LIABILITY_KINDS = ["loan", "credit", "personal_debt", "business_debt", "payable", "mortgage", "other"] as const;
export type LiabilityKind = (typeof LIABILITY_KINDS)[number];
export const LIABILITY_STATUSES = ["active", "paid_off", "overdue", "cancelled"] as const;

export const ASSET_KINDS = ["equipment", "electronics", "vehicle", "property", "land", "jewelry", "business_asset", "other"] as const;
export const ASSET_STATUSES = ["owned", "sold", "disposed"] as const;

export const INVESTMENT_KINDS = [
  "stock",
  "mutual_fund",
  "fixed_deposit",
  "savings_certificate",
  "bond",
  "dps",
  "gold",
  "crypto",
  "real_estate",
  "business_equity",
  "retirement",
  "other",
] as const;

export const GOAL_KINDS = [
  "savings",
  "emergency_fund",
  "asset_purchase",
  "business_capital",
  "travel",
  "investment",
  "education",
  "dream_asset",
  "custom",
] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const GOAL_STATUSES = ["active", "achieved", "paused", "archived"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;

export const INBOX_KINDS = [
  "duplicate",
  "recurring_candidate",
  "subscription_candidate",
  "anomaly",
  "integration_error",
  "budget_warning",
  "price_change",
  "renewal",
  "large_transaction",
  "forecast_warning",
  "receivable_overdue",
  "observation",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const SEVERITIES = ["info", "success", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DEFAULT_REMINDER_OFFSETS = [2, 1, 0];

/** Where a type sits in reports. Only these move profit and loss. */
export const TYPE_LABELS: Record<TransactionType, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
  refund: "Refund",
  adjustment: "Adjustment",
  investment: "Investment",
  asset_purchase: "Asset purchase",
  debt_payment: "Debt payment",
  loan: "Loan",
  equity: "Owner equity",
};

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  bank: "Bank account",
  cash: "Cash",
  mobile_wallet: "Mobile wallet",
  card: "Credit card",
  digital_wallet: "Digital wallet",
  payment_processor: "Payment processor",
  savings: "Savings",
  loan: "Loan account",
  other: "Other",
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  once: "One-off",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-yearly",
  yearly: "Yearly",
  custom: "Custom",
};

export const COMMITMENT_KIND_LABELS: Record<CommitmentKind, string> = {
  subscription: "Subscription",
  salary: "Salary",
  payroll: "Payroll",
  rent: "Rent",
  loan_payment: "Loan installment",
  insurance: "Insurance",
  tax: "Tax",
  utility: "Utility bill",
  domain: "Domain renewal",
  hosting: "Hosting",
  software: "Software",
  contractor: "Contractor",
  education: "Education",
  income: "Expected income",
  custom: "Other",
};

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trial: "Trial",
  active: "Active",
  renewal_due: "Renewal due",
  renewed: "Renewed",
  cancellation_pending: "Cancellation pending",
  cancelled: "Cancelled",
  expired: "Expired",
  paused: "Paused",
};

/** Currencies offered in pickers; any ISO code still works via the API. */
export const COMMON_CURRENCIES = ["BDT", "USD", "EUR", "GBP", "INR", "AED", "SAR", "SGD", "MYR", "CAD", "AUD", "JPY", "CNY"] as const;
