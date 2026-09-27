import type { Day } from "../dates.ts";
import { diffDays } from "../dates.ts";

export type NetWorthAccount = {
  id: string;
  name: string;
  /** Balance converted to base; null when no exchange rate exists. */
  baseBalance: number | null;
  currency: string;
  isLiability: boolean;
};

export type NetWorthHolding = {
  id: string;
  name: string;
  kind: "asset" | "investment" | "receivable";
  /** Value in base; null when the value is unknown or unconvertible. */
  baseValue: number | null;
  currency: string;
  /** Date of the valuation behind the value. */
  valuedAt?: Day | null;
};

export type NetWorthLiability = {
  id: string;
  name: string;
  baseOutstanding: number | null;
  currency: string;
};

export type NetWorthWarning = {
  code: "missing_rate" | "stale_valuation" | "no_valuation" | "no_accounts";
  message: string;
  entityId?: string;
};

export type NetWorthResult = {
  assets: {
    cash: number;
    investments: number;
    assets: number;
    receivables: number;
    total: number;
  };
  liabilities: {
    accounts: number;
    debts: number;
    total: number;
  };
  netWorth: number;
  /** True when every component could be valued. */
  complete: boolean;
  warnings: NetWorthWarning[];
};

const STALE_AFTER_DAYS = 180;

/**
 * Net worth = total assets − total liabilities. A component that cannot be
 * valued (no exchange rate, no valuation) is left out and reported, never
 * silently counted as zero.
 */
export function computeNetWorth(input: {
  accounts: NetWorthAccount[];
  holdings: NetWorthHolding[];
  liabilities: NetWorthLiability[];
  asOf: Day;
}): NetWorthResult {
  const warnings: NetWorthWarning[] = [];
  let cash = 0;
  let accountDebt = 0;

  for (const account of input.accounts) {
    if (account.baseBalance === null) {
      warnings.push({
        code: "missing_rate",
        message: `${account.name} (${account.currency}) has no exchange rate to the base currency.`,
        entityId: account.id,
      });
      continue;
    }
    // A negative balance is money owed whatever the account type: an overdrawn
    // wallet is a debt, a credit card in credit is an asset.
    if (account.baseBalance < 0) accountDebt += -account.baseBalance;
    else cash += account.baseBalance;
  }

  const totals = { investments: 0, assets: 0, receivables: 0 };
  for (const holding of input.holdings) {
    if (holding.baseValue === null) {
      warnings.push({
        code: holding.valuedAt === undefined ? "missing_rate" : "no_valuation",
        message:
          holding.valuedAt === undefined
            ? `${holding.name} (${holding.currency}) has no exchange rate to the base currency.`
            : `${holding.name} has no current value.`,
        entityId: holding.id,
      });
      continue;
    }
    if (holding.kind !== "receivable" && holding.valuedAt && diffDays(holding.valuedAt, input.asOf) > STALE_AFTER_DAYS) {
      warnings.push({
        code: "stale_valuation",
        message: `${holding.name} was last valued ${diffDays(holding.valuedAt, input.asOf)} days ago.`,
        entityId: holding.id,
      });
    }
    if (holding.kind === "investment") totals.investments += holding.baseValue;
    else if (holding.kind === "asset") totals.assets += holding.baseValue;
    else totals.receivables += holding.baseValue;
  }

  let debts = 0;
  for (const liability of input.liabilities) {
    if (liability.baseOutstanding === null) {
      warnings.push({
        code: "missing_rate",
        message: `${liability.name} (${liability.currency}) has no exchange rate to the base currency.`,
        entityId: liability.id,
      });
      continue;
    }
    debts += Math.max(0, liability.baseOutstanding);
  }

  if (input.accounts.length === 0) {
    warnings.push({ code: "no_accounts", message: "No accounts yet: cash is not included." });
  }

  const assetTotal = cash + totals.investments + totals.assets + totals.receivables;
  const liabilityTotal = accountDebt + debts;
  return {
    assets: { cash, ...totals, total: assetTotal },
    liabilities: { accounts: accountDebt, debts, total: liabilityTotal },
    netWorth: assetTotal - liabilityTotal,
    complete: !warnings.some((w) => w.code === "missing_rate" || w.code === "no_valuation"),
    warnings,
  };
}
