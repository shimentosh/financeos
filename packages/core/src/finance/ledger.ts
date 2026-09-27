import type { Direction, TransactionType } from "../constants.ts";

/**
 * How every transaction type behaves. `pnl` says whether it is income or
 * spending; everything else moves money between places the user owns (a
 * transfer), into holdings (investment, asset purchase), or into and out of
 * debt and equity — none of which is income or an expense.
 */
export const TYPE_RULES: Record<
  TransactionType,
  {
    directions: readonly Direction[];
    defaultDirection: Direction;
    cashFlow: CashFlowBucket;
  }
> = {
  expense: { directions: ["out"], defaultDirection: "out", cashFlow: "operating" },
  income: { directions: ["in"], defaultDirection: "in", cashFlow: "operating" },
  // Refund in: money back on a purchase (reduces spending).
  // Refund out: money returned to a customer (reduces revenue).
  refund: { directions: ["in", "out"], defaultDirection: "in", cashFlow: "operating" },
  transfer: { directions: ["out"], defaultDirection: "out", cashFlow: "transfer" },
  adjustment: { directions: ["in", "out"], defaultDirection: "in", cashFlow: "adjustment" },
  // Out: contribution into a holding. In: withdrawal or sale proceeds.
  investment: { directions: ["in", "out"], defaultDirection: "out", cashFlow: "investing" },
  asset_purchase: { directions: ["out"], defaultDirection: "out", cashFlow: "investing" },
  // Out: paying down a liability. In: someone repaying money they owe you.
  debt_payment: { directions: ["in", "out"], defaultDirection: "out", cashFlow: "financing" },
  // In: borrowing (a liability grows). Out: lending (a receivable grows).
  loan: { directions: ["in", "out"], defaultDirection: "in", cashFlow: "financing" },
  // In: owner's capital put into the business. Out: owner's drawings.
  equity: { directions: ["in", "out"], defaultDirection: "in", cashFlow: "financing" },
};

export type CashFlowBucket = "operating" | "investing" | "financing" | "transfer" | "adjustment";

export function isDirectionAllowed(type: TransactionType, direction: Direction): boolean {
  return TYPE_RULES[type].directions.includes(direction);
}

export type EntryInput = {
  type: TransactionType;
  direction: Direction;
  accountId: string;
  accountCurrency: string;
  /** Positive, in the account's currency. */
  accountAmount: number;
  /** Positive, in the base currency. */
  baseAmount: number;
  toAccountId?: string | null;
  toAccountCurrency?: string | null;
  toAccountAmount?: number | null;
  date: string;
};

export type EntryDraft = {
  accountId: string;
  /** Signed, in the account's currency. */
  amount: number;
  currency: string;
  /** Signed, in the base currency. */
  baseAmount: number;
  date: string;
};

export class LedgerError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/**
 * The ledger lines a posted transaction produces: one for the account it
 * touches, two for a transfer. Amounts arrive positive; the sign comes from
 * the direction, so a wrong sign can never be typed in.
 */
export function computeEntries(input: EntryInput): EntryDraft[] {
  if (!(input.accountAmount > 0) || !Number.isInteger(input.accountAmount)) {
    throw new LedgerError("Amount must be a positive whole number of minor units", "invalid_amount");
  }
  if (!Number.isInteger(input.baseAmount) || input.baseAmount < 0) {
    throw new LedgerError("Base amount must be a whole number of minor units", "invalid_amount");
  }
  if (!isDirectionAllowed(input.type, input.direction)) {
    throw new LedgerError(`A ${input.type} cannot be money ${input.direction === "in" ? "in" : "out"}`, "invalid_direction");
  }

  if (input.type === "transfer") {
    if (!input.toAccountId || !input.toAccountCurrency) {
      throw new LedgerError("A transfer needs a destination account", "missing_destination");
    }
    if (input.toAccountId === input.accountId) {
      throw new LedgerError("A transfer needs two different accounts", "same_account");
    }
    const arrived = input.toAccountAmount ?? input.accountAmount;
    if (!(arrived > 0) || !Number.isInteger(arrived)) {
      throw new LedgerError("The amount received must be positive", "invalid_amount");
    }
    return [
      {
        accountId: input.accountId,
        amount: -input.accountAmount,
        currency: input.accountCurrency,
        baseAmount: -input.baseAmount,
        date: input.date,
      },
      {
        accountId: input.toAccountId,
        amount: arrived,
        currency: input.toAccountCurrency,
        baseAmount: input.baseAmount,
        date: input.date,
      },
    ];
  }

  const sign = input.direction === "in" ? 1 : -1;
  return [
    {
      accountId: input.accountId,
      amount: sign * input.accountAmount,
      currency: input.accountCurrency,
      baseAmount: sign * input.baseAmount,
      date: input.date,
    },
  ];
}

/**
 * A transaction's effect on income and spending, in base units. Refunds net
 * against the side they reverse; everything else is zero.
 */
export function pnlEffect(type: TransactionType, direction: Direction, baseAmount: number): { income: number; expense: number } {
  switch (type) {
    case "income":
      return { income: baseAmount, expense: 0 };
    case "expense":
      return { income: 0, expense: baseAmount };
    case "refund":
      return direction === "in" ? { income: 0, expense: -baseAmount } : { income: -baseAmount, expense: 0 };
    default:
      return { income: 0, expense: 0 };
  }
}

export type FlowRow = {
  type: TransactionType;
  direction: Direction;
  /** Positive base amount. */
  amount: number;
};

export type IncomeStatement = {
  income: number;
  expenses: number;
  net: number;
  /** Savings rate for personal, net margin for business; null without income. */
  rate: number | null;
};

export function incomeStatement(rows: Iterable<FlowRow>): IncomeStatement {
  let income = 0;
  let expenses = 0;
  for (const row of rows) {
    const effect = pnlEffect(row.type, row.direction, row.amount);
    income += effect.income;
    expenses += effect.expense;
  }
  const net = income - expenses;
  return {
    income,
    expenses,
    net,
    rate: income > 0 ? Math.round((net / income) * 1000) / 10 : null,
  };
}

export type CashFlowStatement = {
  opening: number;
  income: number;
  expenses: number;
  /** Refunds in net of refunds out. */
  refunds: number;
  debtPayments: number;
  borrowing: number;
  lending: number;
  collections: number;
  investing: number;
  equity: number;
  /** Money in from outside the account set (transfers between members net to zero). */
  transfersIn: number;
  transfersOut: number;
  adjustments: number;
  closing: number;
  net: number;
};

export type CashFlowEntry = {
  type: TransactionType;
  direction: Direction;
  /** Signed base amount of the entry on an account inside the set. */
  amount: number;
};

/**
 * Opening cash + income − expenses − debt payments ± transfers = closing cash,
 * for a set of accounts. The rows are ledger entries on those accounts; a
 * transfer between two accounts in the set contributes both of its legs and
 * nets to zero, a transfer leaving the set counts once.
 */
export function cashFlowStatement(opening: number, entries: Iterable<CashFlowEntry>): CashFlowStatement {
  const s: CashFlowStatement = {
    opening,
    income: 0,
    expenses: 0,
    refunds: 0,
    debtPayments: 0,
    borrowing: 0,
    lending: 0,
    collections: 0,
    investing: 0,
    equity: 0,
    transfersIn: 0,
    transfersOut: 0,
    adjustments: 0,
    closing: opening,
    net: 0,
  };
  for (const entry of entries) {
    const value = entry.amount;
    switch (entry.type) {
      case "income":
        s.income += value;
        break;
      case "expense":
        s.expenses += -value;
        break;
      case "refund":
        s.refunds += value;
        break;
      case "debt_payment":
        if (value < 0) s.debtPayments += -value;
        else s.collections += value;
        break;
      case "loan":
        if (value > 0) s.borrowing += value;
        else s.lending += -value;
        break;
      case "investment":
      case "asset_purchase":
        s.investing += value;
        break;
      case "equity":
        s.equity += value;
        break;
      case "transfer":
        if (value > 0) s.transfersIn += value;
        else s.transfersOut += -value;
        break;
      case "adjustment":
        s.adjustments += value;
        break;
    }
    s.net += value;
  }
  s.closing = opening + s.net;
  return s;
}
