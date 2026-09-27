import {
  addMonths,
  computeNetWorth,
  type Day,
  endOfMonth,
  investmentMetrics,
  monthKey,
  type NetWorthAccount,
  type NetWorthHolding,
  type NetWorthLiability,
  type NetWorthResult,
  type NetWorthWarning,
  percentChange,
  startOfMonth,
} from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { db } from "../../db/index.js";
import { assets, financialAccounts, investments, liabilities, receivables } from "../../db/schema/index.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { FxService } from "../ledger/fx.service.js";
import { type AssetRow, AssetsService, type AssetValuationRow } from "./assets.service.js";
import { InvestmentsService, type InvestmentValuationRow, type InvestmentWithFlows, investmentValueAsOf } from "./investments.service.js";
import { LiabilitiesService, type LiabilityWithFlows, liabilityOutstandingAsOf } from "./liabilities.service.js";
import { ReceivablesService, type ReceivableWithPayments, receivableRemainingAsOf } from "./receivables.service.js";
import { RateBook } from "./support.js";

type Component<T> = T & { currency: string };

export type NetWorthComponents = {
  accounts: Array<Component<{ id: string; name: string; kind: string; balance: number; baseBalance: number | null; isLiability: boolean }>>;
  assets: Array<
    Component<{ id: string; name: string; kind: string; value: number; baseValue: number | null; valuedAt: Day | null; source: "valuation" | "purchase_price" }>
  >;
  investments: Array<
    Component<{ id: string; name: string; kind: string; value: number; baseValue: number | null; valuedAt: Day | null; source: "valuation" | "cost_basis" }>
  >;
  receivables: Array<Component<{ id: string; title: string; counterpartyName: string; remaining: number; baseRemaining: number | null }>>;
  liabilities: Array<Component<{ id: string; name: string; kind: string; outstanding: number; baseOutstanding: number | null }>>;
};

export type NetWorthSnapshot = NetWorthResult & {
  asOf: Day;
  currency: string;
  liabilities: NetWorthResult["liabilities"] & { byKind: Record<string, number> };
  components: NetWorthComponents;
};

export type NetWorthPoint = {
  month: string;
  asOf: Day;
  netWorth: number;
  complete: boolean;
  warningCount: number;
  /** False when nothing was on the books yet (no balances, holdings or debts). */
  hasData: boolean;
  assets: NetWorthResult["assets"];
  liabilities: NetWorthResult["liabilities"] & { byKind: Record<string, number> };
};

type Loaded = {
  accounts: Array<typeof financialAccounts.$inferSelect>;
  assets: AssetRow[];
  assetValuations: Map<string, AssetValuationRow[]>;
  investments: InvestmentWithFlows[];
  investmentValuations: Map<string, InvestmentValuationRow[]>;
  liabilities: LiabilityWithFlows[];
  receivables: ReceivableWithPayments[];
};

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

/**
 * Net worth: cash in accounts counted in net worth, assets, investments and
 * receivables, less debts. Anything that cannot be valued (no exchange rate,
 * no valuation) is left out and reported as a warning — the figure is never
 * shown as complete when it is not.
 */
@Injectable()
export class NetWorthService {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AssetsService) private readonly assets: AssetsService,
    @Inject(InvestmentsService) private readonly investments: InvestmentsService,
    @Inject(LiabilitiesService) private readonly liabilities: LiabilitiesService,
    @Inject(ReceivablesService) private readonly receivables: ReceivablesService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  private async load(ctx: WorkspaceContext): Promise<Loaded> {
    const ws = ctx.workspaceId;
    const [accountRows, assetRows, investmentRows, liabilityRows, receivableRows] = await Promise.all([
      db
        .select()
        .from(financialAccounts)
        .where(and(eq(financialAccounts.workspaceId, ws), eq(financialAccounts.status, "active"), eq(financialAccounts.includeInNetWorth, true))),
      db.select().from(assets).where(eq(assets.workspaceId, ws)),
      db.select().from(investments).where(eq(investments.workspaceId, ws)),
      db
        .select()
        .from(liabilities)
        .where(and(eq(liabilities.workspaceId, ws), ne(liabilities.status, "cancelled"))),
      db
        .select()
        .from(receivables)
        .where(and(eq(receivables.workspaceId, ws), ne(receivables.status, "cancelled"))),
    ]);
    // A credit liability tied to an account in net worth is already that
    // account's negative balance; counting both would double the debt.
    const netWorthAccounts = new Set(accountRows.map((row) => row.id));
    const debts = liabilityRows.filter((row) => !(row.accountId && netWorthAccounts.has(row.accountId)));
    const [assetValuations, investmentsWithFlows, investmentValuations, liabilitiesWithFlows, receivablesWithPayments] = await Promise.all([
      this.assets.allValuations(
        ctx,
        assetRows.map((row) => row.id),
      ),
      this.investments.withFlows(ctx, investmentRows),
      this.investments.allValuations(
        ctx,
        investmentRows.map((row) => row.id),
      ),
      this.liabilities.withFlows(ctx, debts),
      this.receivables.withPayments(ctx, receivableRows),
    ]);
    return {
      accounts: accountRows,
      assets: assetRows,
      assetValuations: groupBy(assetValuations, (row) => row.assetId),
      investments: investmentsWithFlows,
      investmentValuations: groupBy(investmentValuations, (row) => row.investmentId),
      liabilities: liabilitiesWithFlows,
      receivables: receivablesWithPayments,
    };
  }

  /** Net worth on a day, from values as they stood then (or today's values when `live`). */
  private async snapshot(ctx: WorkspaceContext, data: Loaded, asOf: Day, rates: RateBook, live: boolean): Promise<NetWorthSnapshot> {
    const base = ctx.baseCurrency;
    const toBase = (amount: number, currency: string) => rates.convert(amount, currency, base, asOf);
    const extra: NetWorthWarning[] = [];
    const components: NetWorthComponents = { accounts: [], assets: [], investments: [], receivables: [], liabilities: [] };

    // Accounts: opening balance (once opened) plus ledger entries to the day.
    if (live) {
      for (const account of await this.accounts.list(ctx, { asOf })) {
        if (!account.includeInNetWorth) continue;
        const { id, name, kind, currency, balance, baseBalance, isLiability } = account;
        components.accounts.push({ id, name, kind, currency, balance, baseBalance, isLiability });
      }
    } else {
      const sums = await this.accounts.balances(ctx.workspaceId, asOf);
      for (const account of data.accounts) {
        const balance = (account.openingDate <= asOf ? account.openingBalance : 0) + (sums.get(account.id)?.total ?? 0);
        components.accounts.push({
          id: account.id,
          name: account.name,
          kind: account.kind,
          currency: account.currency,
          balance,
          baseBalance: await toBase(balance, account.currency),
          isLiability: account.isLiability,
        });
      }
    }

    for (const asset of data.assets) {
      let value: number | null;
      let valuedAt: Day | null = null;
      let source: "valuation" | "purchase_price" = "valuation";
      if (live) {
        if (asset.status !== "owned") continue;
        value = asset.currentValue;
        valuedAt = asset.valuedAt;
      } else {
        if (asset.purchaseDate && asset.purchaseDate > asOf) continue;
        if (asset.status !== "owned" && asset.soldOn && asset.soldOn <= asOf) continue;
        const latest = (data.assetValuations.get(asset.id) ?? []).filter((row) => row.date <= asOf).at(-1);
        if (latest) {
          value = latest.value;
          valuedAt = latest.date;
        } else if (asset.purchaseDate) {
          value = asset.purchasePrice;
          source = "purchase_price";
        } else {
          // Neither bought nor valued by then: it was not on the books yet.
          continue;
        }
      }
      if (value === null) {
        extra.push({ code: "no_valuation", message: `${asset.name} has no value on ${asOf}.`, entityId: asset.id });
        continue;
      }
      components.assets.push({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        currency: asset.currency,
        value,
        baseValue: await toBase(value, asset.currency),
        valuedAt,
        source,
      });
    }

    for (const item of data.investments) {
      let result: { value: number; source: "valuation" | "cost_basis"; valuedAt: Day | null } | null;
      if (live) {
        if (item.row.status !== "active") continue;
        const metrics = investmentMetrics({ openingCostBasis: item.row.openingCostBasis, flows: item.flows, currentValue: item.row.currentValue });
        result =
          item.row.currentValue === null
            ? { value: metrics.costBasis, source: "cost_basis", valuedAt: null }
            : { value: item.row.currentValue, source: "valuation", valuedAt: item.row.valuedAt };
      } else {
        result = investmentValueAsOf(item, data.investmentValuations.get(item.row.id) ?? [], asOf, ctx.timezone);
      }
      if (!result) continue;
      if (result.source === "cost_basis") {
        extra.push({ code: "no_valuation", message: `${item.row.name} has no valuation; it is counted at its cost basis.`, entityId: item.row.id });
      }
      if (item.unconverted) {
        extra.push({
          code: "missing_rate",
          message: `${item.row.name} has transactions that could not be converted to ${item.row.currency}.`,
          entityId: item.row.id,
        });
      }
      components.investments.push({
        id: item.row.id,
        name: item.row.name,
        kind: item.row.kind,
        currency: item.row.currency,
        value: result.value,
        baseValue: await toBase(result.value, item.row.currency),
        valuedAt: result.valuedAt,
        source: result.source,
      });
    }

    for (const item of data.receivables) {
      const remaining = receivableRemainingAsOf(item, asOf);
      if (remaining === null || remaining <= 0) continue;
      if (item.unconverted) {
        extra.push({ code: "missing_rate", message: `Payments on ${item.row.title} could not be converted to ${item.row.currency}.`, entityId: item.row.id });
      }
      components.receivables.push({
        id: item.row.id,
        title: item.row.title,
        counterpartyName: item.row.counterpartyName,
        currency: item.row.currency,
        remaining,
        baseRemaining: await toBase(remaining, item.row.currency),
      });
    }

    for (const item of data.liabilities) {
      const outstanding = liabilityOutstandingAsOf(item, asOf, ctx.timezone);
      if (outstanding === null || outstanding <= 0) continue;
      if (item.unconverted) {
        extra.push({ code: "missing_rate", message: `Payments on ${item.row.name} could not be converted to ${item.row.currency}.`, entityId: item.row.id });
      }
      components.liabilities.push({
        id: item.row.id,
        name: item.row.name,
        kind: item.row.kind,
        currency: item.row.currency,
        outstanding,
        baseOutstanding: await toBase(outstanding, item.row.currency),
      });
    }

    const accountsInput: NetWorthAccount[] = components.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      baseBalance: a.baseBalance,
      currency: a.currency,
      isLiability: a.isLiability,
    }));
    // `valuedAt: undefined` tells core the value exists but has no rate.
    const holdings: NetWorthHolding[] = [
      ...components.assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: "asset" as const,
        baseValue: a.baseValue,
        currency: a.currency,
        valuedAt: a.baseValue === null ? undefined : a.valuedAt,
      })),
      ...components.investments.map((i) => ({
        id: i.id,
        name: i.name,
        kind: "investment" as const,
        baseValue: i.baseValue,
        currency: i.currency,
        valuedAt: i.baseValue === null ? undefined : i.valuedAt,
      })),
      ...components.receivables.map((r) => ({
        id: r.id,
        name: r.title,
        kind: "receivable" as const,
        baseValue: r.baseRemaining,
        currency: r.currency,
        valuedAt: r.baseRemaining === null ? undefined : null,
      })),
    ];
    const debts: NetWorthLiability[] = components.liabilities.map((l) => ({
      id: l.id,
      name: l.name,
      baseOutstanding: l.baseOutstanding,
      currency: l.currency,
    }));
    const result = computeNetWorth({ accounts: accountsInput, holdings, liabilities: debts, asOf });

    const warnings = [...result.warnings, ...extra];
    const byKind: Record<string, number> = {};
    for (const l of components.liabilities) {
      if (l.baseOutstanding !== null) byKind[l.kind] = (byKind[l.kind] ?? 0) + l.baseOutstanding;
    }
    if (result.liabilities.accounts) byKind.accounts = result.liabilities.accounts;
    return {
      ...result,
      asOf,
      currency: base,
      liabilities: { ...result.liabilities, byKind },
      warnings,
      complete: !warnings.some((w) => w.code === "missing_rate" || w.code === "no_valuation"),
      components,
    };
  }

  private point(snapshot: NetWorthSnapshot): NetWorthPoint {
    return {
      month: monthKey(snapshot.asOf),
      asOf: snapshot.asOf,
      netWorth: snapshot.netWorth,
      complete: snapshot.complete,
      warningCount: snapshot.warnings.length,
      hasData:
        snapshot.components.accounts.some((a) => a.balance !== 0) ||
        snapshot.components.assets.length > 0 ||
        snapshot.components.investments.length > 0 ||
        snapshot.components.receivables.length > 0 ||
        snapshot.components.liabilities.length > 0,
      assets: snapshot.assets,
      liabilities: snapshot.liabilities,
    };
  }

  private async series(ctx: WorkspaceContext, months: number) {
    const day = todayFor(ctx);
    const data = await this.load(ctx);
    const rates = new RateBook(this.fx, ctx.workspaceId);
    const current = await this.snapshot(ctx, data, day, rates, true);
    const points: NetWorthPoint[] = [];
    for (let back = months - 1; back >= 1; back--) {
      const asOf = endOfMonth(addMonths(startOfMonth(day), -back));
      points.push(this.point(await this.snapshot(ctx, data, asOf, rates, false)));
    }
    points.push(this.point(current));
    const previousAsOf = endOfMonth(addMonths(startOfMonth(day), -1));
    const previous = points.find((p) => p.asOf === previousAsOf) ?? this.point(await this.snapshot(ctx, data, previousAsOf, rates, false));
    // No comparison when nothing was tracked at the previous month end.
    const comparable = previous.hasData;
    return {
      current,
      points,
      previousMonth: { month: previous.month, asOf: previous.asOf, netWorth: previous.netWorth, complete: previous.complete, hasData: previous.hasData },
      previous: comparable ? previous.netWorth : null,
      change: comparable ? current.netWorth - previous.netWorth : null,
      changePercent: comparable ? percentChange(previous.netWorth, current.netWorth) : null,
    };
  }

  /** Net worth today with its breakdown, components, warnings and the change since last month end. */
  async current(ctx: WorkspaceContext) {
    const { current, previousMonth, previous, change, changePercent } = await this.series(ctx, 2);
    return { ...current, previous, previousMonth, change, changePercent };
  }

  /** Month-end net worth for the last `months` months (the current month as of today). */
  async history(ctx: WorkspaceContext, months = 12) {
    const { current, points, previousMonth, previous, change, changePercent } = await this.series(ctx, Math.max(1, Math.min(60, months)));
    return {
      currency: ctx.baseCurrency,
      months: points.length,
      points,
      current: { asOf: current.asOf, netWorth: current.netWorth, complete: current.complete },
      previous,
      previousMonth,
      change,
      changePercent,
      breakdown: { assets: current.assets, liabilities: current.liabilities },
      warnings: current.warnings,
    };
  }

  /**
   * The compact form for the dashboard (also used by analytics' overview):
   * `previous` is last month end's net worth, null when nothing was tracked
   * then. Warnings are all of them — never show `netWorth` without them.
   */
  async summary(ctx: WorkspaceContext) {
    const { current, points, previousMonth, previous, change, changePercent } = await this.series(ctx, 6);
    return {
      currency: ctx.baseCurrency,
      asOf: current.asOf,
      netWorth: current.netWorth,
      previous,
      change,
      changePercent,
      complete: current.complete,
      warnings: current.warnings,
      warningCount: current.warnings.length,
      assets: current.assets,
      liabilities: current.liabilities,
      previousMonth,
      trend: points.map((p) => ({ month: p.month, netWorth: p.netWorth, complete: p.complete })),
    };
  }
}
