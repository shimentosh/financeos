import { assetInput, assetUpdate, type Day, diffDays, valuationInput } from "@expensewise/core";
import { type AssetQuery, type AssetSellInput, assetQuery, assetSellInput } from "@expensewise/core/contracts/wealth-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { assets, assetValuations, financialAccounts, projects, transactions } from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { RateBook, share } from "./support.js";

export type AssetRow = typeof assets.$inferSelect;
export type AssetValuationRow = typeof assetValuations.$inferSelect;

export type AssetView = AssetRow & {
  projectName: string | null;
  /** Current value (or sale amount once sold) minus purchase price, in the asset's currency. */
  gain: number | null;
  gainPercent: number | null;
  /** In the workspace base currency at today's rate; null when no rate exists. */
  baseCurrentValue: number | null;
  basePurchasePrice: number | null;
  baseGain: number | null;
  /** Days since the last valuation. */
  valuationAgeDays: number | null;
};

/** Transactions linked to a holding or debt, as shown in its history. */
export const linkedTransactionColumns = {
  id: transactions.id,
  type: transactions.type,
  direction: transactions.direction,
  status: transactions.status,
  date: transactions.date,
  amount: transactions.amount,
  currency: transactions.currency,
  baseAmount: transactions.baseAmount,
  costBasis: transactions.costBasis,
  accountId: transactions.accountId,
  accountName: financialAccounts.name,
  description: transactions.description,
  notes: transactions.notes,
  categoryId: transactions.categoryId,
  projectId: transactions.projectId,
  metadata: transactions.metadata,
};

@Injectable()
export class AssetsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<AssetRow> {
    const [row] = await exec
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Asset");
  }

  private async views(ctx: WorkspaceContext, rows: Array<AssetRow & { projectName: string | null }>): Promise<AssetView[]> {
    const day = todayFor(ctx);
    const rates = new RateBook(this.fx, ctx.workspaceId);
    return Promise.all(
      rows.map(async (row) => {
        const endValue = row.status === "owned" ? row.currentValue : (row.soldAmount ?? 0);
        const gain = row.purchasePrice === null ? null : endValue - row.purchasePrice;
        const baseCurrentValue = await rates.convert(row.currentValue, row.currency, ctx.baseCurrency, day);
        const basePurchasePrice = row.purchasePrice === null ? null : await rates.convert(row.purchasePrice, row.currency, ctx.baseCurrency, day);
        const baseGain = gain === null ? null : await rates.convert(gain, row.currency, ctx.baseCurrency, day);
        return {
          ...row,
          gain,
          gainPercent: gain === null || !row.purchasePrice ? null : share(gain, row.purchasePrice),
          baseCurrentValue,
          basePurchasePrice,
          baseGain,
          valuationAgeDays: row.valuedAt ? Math.max(0, diffDays(row.valuedAt, day)) : null,
        };
      }),
    );
  }

  private select(exec: Executor = db) {
    return exec.select({ asset: assets, projectName: projects.name }).from(assets).leftJoin(projects, eq(projects.id, assets.projectId));
  }

  /** Assets with values in base currency, totals, and those that could not be converted. */
  async list(ctx: WorkspaceContext, raw: AssetQuery = {}) {
    const query = assetQuery.parse(raw);
    const rows = await this.select()
      .where(
        and(
          eq(assets.workspaceId, ctx.workspaceId),
          query.status === "all" ? undefined : eq(assets.status, query.status),
          query.kind ? eq(assets.kind, query.kind) : undefined,
          query.projectId ? eq(assets.projectId, query.projectId) : undefined,
        ),
      )
      .orderBy(asc(assets.status), desc(assets.currentValue), asc(assets.name));
    const items = await this.views(
      ctx,
      rows.map((r) => ({ ...r.asset, projectName: r.projectName })),
    );

    const owned = items.filter((item) => item.status === "owned");
    const disposedOf = items.filter((item) => item.status !== "owned");
    const unconvertible = items
      .filter((item) => item.baseCurrentValue === null)
      .map((item) => ({ id: item.id, name: item.name, currency: item.currency, currentValue: item.currentValue }));
    const byKind = new Map<string, { kind: string; count: number; currentValue: number }>();
    for (const item of owned) {
      const entry = byKind.get(item.kind) ?? { kind: item.kind, count: 0, currentValue: 0 };
      entry.count += 1;
      entry.currentValue += item.baseCurrentValue ?? 0;
      byKind.set(item.kind, entry);
    }
    const sum = (list: AssetView[], pick: (item: AssetView) => number | null) => list.reduce((acc, item) => acc + (pick(item) ?? 0), 0);
    return {
      items,
      totals: {
        currency: ctx.baseCurrency,
        count: owned.length,
        /** Owned assets that could be converted. */
        currentValue: sum(owned, (item) => item.baseCurrentValue),
        /** Owned assets with a known purchase price. */
        purchasePrice: sum(owned, (item) => (item.baseCurrentValue === null ? null : item.basePurchasePrice)),
        /** Unrealised: current value over purchase price, owned assets with both known. */
        gain: sum(owned, (item) => item.baseGain),
        /** Realised on assets sold or disposed of (in this list). */
        realizedGain: sum(disposedOf, (item) => item.baseGain),
        byKind: [...byKind.values()].sort((a, b) => b.currentValue - a.currentValue),
      },
      unconvertible,
    };
  }

  async detail(ctx: WorkspaceContext, id: string) {
    await this.get(ctx, id);
    const [row] = await this.select().where(and(eq(assets.id, id), eq(assets.workspaceId, ctx.workspaceId)));
    const [view] = await this.views(ctx, [{ ...(row?.asset as AssetRow), projectName: row?.projectName ?? null }]);
    const [valuations, linked] = await Promise.all([this.valuations(ctx, id), this.linkedTransactions(ctx, id)]);
    return { ...(view as AssetView), valuations, transactions: linked };
  }

  linkedTransactions(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    return exec
      .select(linkedTransactionColumns)
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.assetId, id), ne(transactions.status, "void")))
      .orderBy(desc(transactions.date), desc(transactions.createdAt));
  }

  async create(ctx: WorkspaceContext, raw: z.input<typeof assetInput>) {
    const input = assetInput.parse(raw);
    const day = todayFor(ctx);
    const valuedAt = input.valuedAt ?? day;
    if (valuedAt > day) throw unprocessable("A valuation cannot be dated in the future", "future_valuation");
    if (input.paidFromAccountId && !input.purchasePrice) {
      throw unprocessable("Enter the purchase price to record the payment", "missing_purchase_price");
    }
    const id = await db.transaction(async (tx) => {
      await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.paidFromAccountId], "Account");
      const { paidFromAccountId, attachmentFileIds, ...fields } = input;
      const purchaseDate = fields.purchaseDate ?? (paidFromAccountId ? day : null);
      const [row] = await tx
        .insert(assets)
        .values({ workspaceId: ctx.workspaceId, ...fields, purchaseDate, valuedAt })
        .returning();
      const asset = assertFound(row, "Asset");
      await tx
        .insert(assetValuations)
        .values({ workspaceId: ctx.workspaceId, assetId: asset.id, value: asset.currentValue, date: valuedAt, note: "Initial value" });
      let purchaseTransactionId: string | null = null;
      if (paidFromAccountId && asset.purchasePrice) {
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "asset_purchase",
            direction: "out",
            accountId: paidFromAccountId,
            amount: asset.purchasePrice,
            currency: asset.currency,
            date: purchaseDate ?? day,
            assetId: asset.id,
            projectId: asset.projectId,
            description: `Purchase of ${asset.name}`,
            attachmentFileIds,
          },
          { exec: tx, metadata: { assetId: asset.id } },
        );
        purchaseTransactionId = transaction.id;
      }
      await this.audit.record(tx, ctx, { action: "asset.created", entityType: "asset", entityId: asset.id, after: { ...asset, purchaseTransactionId } });
      return asset.id;
    });
    return this.detail(ctx, id);
  }

  async update(ctx: WorkspaceContext, id: string, raw: z.input<typeof assetUpdate>) {
    const input = assetUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      await assertInWorkspace(tx, projects, ctx.workspaceId, [input.projectId], "Project");
      const { currentValue, valuedAt, ...fields } = input;
      const currencyChanged = fields.currency !== undefined && fields.currency !== before.currency;
      if (currencyChanged) {
        const [used] = await this.linkedTransactions(ctx, id, tx).limit(1);
        if (used) throw conflict("The currency of an asset with transactions cannot change", "currency_locked");
      }
      if (fields.status === "owned") Object.assign(fields, { soldOn: null, soldAmount: null });
      if (fields.status && fields.status !== "owned" && !(fields.soldOn ?? before.soldOn)) fields.soldOn = todayFor(ctx);
      const [row] = Object.keys(fields).length ? await tx.update(assets).set(fields).where(eq(assets.id, id)).returning() : [before];
      if (currencyChanged) {
        // Old valuations were in the old currency: the history restarts.
        await tx.delete(assetValuations).where(eq(assetValuations.assetId, id));
        await this.recordValuation(tx, ctx, row as AssetRow, currentValue ?? before.currentValue, valuedAt ?? todayFor(ctx), "Currency changed");
      } else if (currentValue !== undefined && (currentValue !== before.currentValue || valuedAt)) {
        await this.recordValuation(tx, ctx, row as AssetRow, currentValue, valuedAt ?? todayFor(ctx), null);
      } else if (valuedAt && valuedAt !== before.valuedAt) {
        await this.recordValuation(tx, ctx, row as AssetRow, before.currentValue, valuedAt, null);
      }
      const after = await this.get(ctx, id, tx);
      await this.audit.record(tx, ctx, { action: "asset.updated", entityType: "asset", entityId: id, before, after });
    });
    return this.detail(ctx, id);
  }

  /** Deletes an asset. Refused while money moved through it, unless those transactions are voided too. */
  async remove(ctx: WorkspaceContext, id: string, options: { voidLinked?: boolean } = {}) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const linked = await this.linkedTransactions(ctx, id, tx);
      if (linked.length && !options.voidLinked) {
        throw conflict(
          `${before.name} has ${linked.length} linked transaction${linked.length === 1 ? "" : "s"}. Void them too, or mark it as sold or disposed instead.`,
          "has_transactions",
          linked.map((row) => ({ path: "transactionId", message: row.id })),
        );
      }
      for (const row of linked) await this.transactions.void(ctx, row.id, `Asset ${before.name} deleted`, { exec: tx });
      await tx.delete(assets).where(eq(assets.id, id));
      await this.audit.record(tx, ctx, {
        action: "asset.deleted",
        entityType: "asset",
        entityId: id,
        before,
        after: { voidedTransactionIds: linked.map((row) => row.id) },
      });
      return { deleted: true, voidedTransactionIds: linked.map((row) => row.id) };
    });
  }

  async valuations(ctx: WorkspaceContext, id: string, exec: Executor = db) {
    await this.get(ctx, id, exec);
    return exec
      .select()
      .from(assetValuations)
      .where(and(eq(assetValuations.workspaceId, ctx.workspaceId), eq(assetValuations.assetId, id)))
      .orderBy(desc(assetValuations.date), desc(assetValuations.createdAt));
  }

  /** Every valuation of the workspace's assets, oldest first (for net worth history). */
  allValuations(ctx: WorkspaceContext, assetIds: string[], exec: Executor = db) {
    if (!assetIds.length) return Promise.resolve([] as AssetValuationRow[]);
    return exec
      .select()
      .from(assetValuations)
      .where(and(eq(assetValuations.workspaceId, ctx.workspaceId), inArray(assetValuations.assetId, assetIds)))
      .orderBy(asc(assetValuations.date), asc(assetValuations.createdAt));
  }

  /** Stores a valuation and makes the newest one the asset's current value. */
  private async recordValuation(tx: Executor, ctx: WorkspaceContext, asset: AssetRow, value: number, date: Day, note: string | null) {
    if (date > todayFor(ctx)) throw unprocessable("A valuation cannot be dated in the future", "future_valuation");
    const [row] = await tx.insert(assetValuations).values({ workspaceId: ctx.workspaceId, assetId: asset.id, value, date, note }).returning();
    await this.refreshCurrent(tx, asset.id);
    return row as AssetValuationRow;
  }

  private async refreshCurrent(tx: Executor, assetId: string) {
    const [latest] = await tx
      .select()
      .from(assetValuations)
      .where(eq(assetValuations.assetId, assetId))
      .orderBy(desc(assetValuations.date), desc(assetValuations.createdAt))
      .limit(1);
    if (latest) await tx.update(assets).set({ currentValue: latest.value, valuedAt: latest.date }).where(eq(assets.id, assetId));
    else await tx.update(assets).set({ valuedAt: null }).where(eq(assets.id, assetId));
  }

  async addValuation(ctx: WorkspaceContext, id: string, raw: z.input<typeof valuationInput>) {
    const input = valuationInput.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const valuation = await this.recordValuation(tx, ctx, before, input.value, input.date, input.note ?? null);
      const after = await this.get(ctx, id, tx);
      await this.audit.record(tx, ctx, { action: "asset.valued", entityType: "asset", entityId: id, before, after: { ...after, valuation } });
      return { valuation, asset: after };
    });
  }

  async removeValuation(ctx: WorkspaceContext, id: string, valuationId: string) {
    return db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      const [removed] = await tx
        .delete(assetValuations)
        .where(and(eq(assetValuations.id, valuationId), eq(assetValuations.assetId, id), eq(assetValuations.workspaceId, ctx.workspaceId)))
        .returning();
      assertFound(removed, "Valuation");
      await this.refreshCurrent(tx, id);
      const after = await this.get(ctx, id, tx);
      await this.audit.record(tx, ctx, {
        action: "asset.valuation_deleted",
        entityType: "asset",
        entityId: id,
        before: { ...before, valuation: removed },
        after,
      });
      return { deleted: true, asset: after };
    });
  }

  /**
   * Sells or disposes of an asset. Proceeds paid into an account are recorded
   * as an `adjustment` in, linked to the asset, with the purchase price as the
   * cost basis released: a sale converts a holding back into cash — it is not
   * income, and there is no asset-sale transaction type. Realised gain is the
   * sale amount over the purchase price.
   */
  async sell(ctx: WorkspaceContext, id: string, raw: AssetSellInput) {
    const input = assetSellInput.parse(raw);
    if (input.date > todayFor(ctx)) throw unprocessable("A sale cannot be dated in the future", "future_sale");
    if (input.status === "sold" && input.amount <= 0) throw unprocessable("Enter what it sold for", "missing_sale_amount");
    if (input.proceedsAccountId && input.amount <= 0) throw unprocessable("There are no proceeds to record", "missing_sale_amount");
    const result = await db.transaction(async (tx) => {
      const before = await this.get(ctx, id, tx);
      if (before.status !== "owned") throw conflict(`${before.name} is already ${before.status}`, "not_owned");
      await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [input.proceedsAccountId], "Account");
      const realizedGain = before.purchasePrice === null ? null : input.amount - before.purchasePrice;
      let proceedsTransactionId: string | null = null;
      if (input.proceedsAccountId && input.amount > 0) {
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "adjustment",
            direction: "in",
            accountId: input.proceedsAccountId,
            amount: input.amount,
            currency: before.currency,
            date: input.date,
            assetId: id,
            projectId: before.projectId,
            costBasis: before.purchasePrice,
            description: `Sale of ${before.name}`,
            notes: input.note ?? null,
          },
          { exec: tx, metadata: { assetId: id, assetSale: true, realizedGain } },
        );
        proceedsTransactionId = transaction.id;
      }
      await tx.update(assets).set({ status: input.status, soldOn: input.date, soldAmount: input.amount }).where(eq(assets.id, id));
      await this.recordValuation(tx, ctx, before, input.amount, input.date, input.status === "sold" ? "Sold" : "Disposed");
      const after = await this.get(ctx, id, tx);
      await this.audit.record(tx, ctx, {
        action: input.status === "sold" ? "asset.sold" : "asset.disposed",
        entityType: "asset",
        entityId: id,
        before,
        after: { ...after, proceedsTransactionId, realizedGain },
      });
      return { proceedsTransactionId, realizedGain };
    });
    return { asset: await this.detail(ctx, id), ...result };
  }
}
