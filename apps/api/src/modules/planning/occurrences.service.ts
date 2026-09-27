import {
  addDays,
  type Day,
  deriveSubscriptionStatus,
  detectPriceChange,
  diffDays,
  followingDueDate,
  formatMoney,
  type PriceChange,
  skipOccurrenceInput,
  type TransactionInput,
} from "@expensewise/core";
import {
  type MarkPaidRequest,
  markPaidRequest,
  type PaymentMatchQuery,
  paymentMatchQuery,
  type UndoPaymentInput,
  undoPaymentInput,
} from "@expensewise/core/contracts/planning-extra";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { commitmentOccurrences, commitments, counterparties, financialAccounts, subscriptions, transactionAttachments } from "../../db/schema/index.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { type TransactionRow, TransactionsService } from "../ledger/transactions.service.js";
import { AuditService } from "../system/audit.service.js";
import { type DomainEvent, EventsService } from "../system/events.service.js";
import { InboxService } from "../system/notify.service.js";
import { CommitmentsService, PAYMENT_ORIGIN } from "./commitments.service.js";
import { type CommitmentRow, links, type OccurrenceRow, type SubscriptionRow, scheduleOf, systemContext } from "./planning.shared.js";

/** Subscription states a recorded renewal payment moves to "renewed". */
const RENEWABLE = new Set<SubscriptionRow["status"]>(["trial", "active", "renewal_due", "renewed", "expired"]);

export type PaymentCandidate = {
  id: string;
  date: Day;
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

export type MarkPaidResult = {
  occurrence: OccurrenceRow;
  transaction: TransactionRow;
  /** True when a new transaction was created; false when an existing one was linked. */
  created: boolean;
  commitment: CommitmentRow;
  nextOccurrence: OccurrenceRow | null;
  subscription: SubscriptionRow | null;
  priceChange: PriceChange | null;
  /** The AI Inbox item raised for a price change. */
  inboxItemId: string | null;
  /** Whether the commitment's amount was changed to the paid amount. */
  amountUpdated: boolean;
};

/** Keeps a date the same distance before the due date as the schedule moves by one cycle. */
function shiftWithCycle(date: Day, fromDue: Day, toDue: Day): Day | null {
  const lead = diffDays(date, fromDue);
  const cycle = Math.abs(diffDays(fromDue, toDue));
  return lead >= 0 && lead < cycle ? addDays(toDue, -lead) : null;
}

export const unconfirmedKey = (occurrenceId: string) => `renewal:${occurrenceId}:unconfirmed`;
export const priceChangeKey = (occurrenceId: string) => `price_change:${occurrenceId}`;

/**
 * Occurrences: one due instance of a commitment. Recording a payment links
 * (or creates) exactly one transaction, advances the schedule, keeps the
 * renewal history and flags price changes. Undoing it, or voiding its
 * transaction, puts the occurrence back to scheduled.
 */
@Injectable()
export class OccurrencesService implements OnModuleInit {
  private readonly logger = new Logger("Occurrences");

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  onModuleInit() {
    this.events.on("transaction.voided", (event) => this.onTransactionVoided(event));
  }

  async get(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<OccurrenceRow> {
    const [row] = await exec
      .select()
      .from(commitmentOccurrences)
      .where(and(eq(commitmentOccurrences.id, id), eq(commitmentOccurrences.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Occurrence");
  }

  private async lock(tx: Executor, ctx: WorkspaceContext, id: string): Promise<OccurrenceRow> {
    const [row] = await tx
      .select()
      .from(commitmentOccurrences)
      .where(and(eq(commitmentOccurrences.id, id), eq(commitmentOccurrences.workspaceId, ctx.workspaceId)))
      .limit(1)
      .for("update");
    return assertFound(row, "Occurrence");
  }

  private async subscriptionFor(exec: Executor, commitmentId: string): Promise<SubscriptionRow | null> {
    const [row] = await exec.select().from(subscriptions).where(eq(subscriptions.commitmentId, commitmentId)).limit(1);
    return row ?? null;
  }

  private async merchantFor(exec: Executor, commitment: CommitmentRow): Promise<string> {
    if (commitment.payee) return commitment.payee;
    if (commitment.counterpartyId) {
      const [row] = await exec.select({ name: counterparties.name }).from(counterparties).where(eq(counterparties.id, commitment.counterpartyId));
      if (row) return row.name;
    }
    return commitment.name;
  }

  /** Money in the occurrence's currency, converting when paid in another. */
  private async inOccurrenceCurrency(tx: Executor, ctx: WorkspaceContext, occurrence: OccurrenceRow, amount: number, currency: string, date: Day) {
    if (currency === occurrence.currency) return amount;
    return this.fx.tryConvert(amount, currency, occurrence.currency, date, ctx.workspaceId, tx);
  }

  /**
   * Existing transactions that are probably this payment: same amount and
   * currency within three days, scored by merchant and account, moving money
   * the same way, and not already settling another occurrence.
   */
  private async findCandidates(
    tx: Executor,
    ctx: WorkspaceContext,
    commitment: CommitmentRow,
    occurrenceId: string,
    subject: { date: Day; amount: number; currency: string; accountId: string | null },
  ): Promise<PaymentCandidate[]> {
    const merchant = await this.merchantFor(tx, commitment);
    const matches = (await this.transactions.findDuplicates(ctx, { ...subject, merchant }, tx)).filter(
      (match) => match.transaction.direction === commitment.direction && match.transaction.type !== "transfer",
    );
    if (!matches.length) return [];
    const linked = await tx
      .select({ transactionId: commitmentOccurrences.transactionId })
      .from(commitmentOccurrences)
      .where(
        and(
          inArray(
            commitmentOccurrences.transactionId,
            matches.map((m) => m.id),
          ),
          ne(commitmentOccurrences.id, occurrenceId),
        ),
      );
    const taken = new Set(linked.map((row) => row.transactionId));
    const free = matches.filter((match) => !taken.has(match.id));
    const accountIds = [...new Set(free.map((m) => m.transaction.accountId).filter((id): id is string => Boolean(id)))];
    const accounts = accountIds.length
      ? await tx.select({ id: financialAccounts.id, name: financialAccounts.name }).from(financialAccounts).where(inArray(financialAccounts.id, accountIds))
      : [];
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    return free.map((match) => ({
      id: match.id,
      date: match.transaction.date,
      amount: match.transaction.amount,
      currency: match.transaction.currency,
      baseAmount: match.transaction.baseAmount,
      type: match.transaction.type,
      status: match.transaction.status,
      merchant: match.transaction.merchant,
      description: match.transaction.description,
      accountId: match.transaction.accountId,
      accountName: match.transaction.accountId ? (names.get(match.transaction.accountId) ?? null) : null,
      score: match.score,
      exact: match.exact,
      reasons: match.reasons,
      href: links.transaction(match.id),
    }));
  }

  /** What "Link existing" would offer before recording a payment. */
  async candidates(ctx: WorkspaceContext, id: string, raw: PaymentMatchQuery = {}) {
    const query = paymentMatchQuery.parse(raw);
    const occurrence = await this.get(ctx, id);
    const commitment = await this.commitments.get(ctx, occurrence.commitmentId);
    const currency = query.currency ?? occurrence.currency;
    return {
      occurrenceId: id,
      candidates: await this.findCandidates(db, ctx, commitment, id, {
        date: query.paidOn ?? occurrence.dueDate,
        amount: query.amount ?? occurrence.amount,
        currency,
        accountId: query.accountId ?? commitment.accountId,
      }),
    };
  }

  /** Pays the commitment's next unsettled occurrence. */
  async payNext(ctx: WorkspaceContext, commitmentId: string, raw: MarkPaidRequest): Promise<MarkPaidResult> {
    const next = await db.transaction(async (tx) => {
      const commitment = await this.commitments.syncNext(tx, ctx, (await this.commitments.get(ctx, commitmentId, tx)).id);
      return this.commitments.nextScheduled(tx, commitment.id);
    });
    if (!next) throw conflict("Nothing is scheduled for this commitment", "nothing_scheduled");
    return this.markPaid(ctx, next.id, raw);
  }

  async markPaid(ctx: WorkspaceContext, id: string, raw: MarkPaidRequest): Promise<MarkPaidResult> {
    const input = markPaidRequest.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.lock(tx, ctx, id);
      if (before.status === "paid") throw conflict("This payment is already recorded", "already_paid", { transactionId: before.transactionId });
      if (before.status === "cancelled") throw conflict("This payment was cancelled", "occurrence_cancelled");
      const commitment = await this.commitments.get(ctx, before.commitmentId, tx);
      const subscription = await this.subscriptionFor(tx, commitment.id);

      let transaction: TransactionRow;
      let created = false;
      if (input.existingTransactionId) {
        transaction = await this.transactions.get(ctx, input.existingTransactionId, tx);
        if (transaction.status === "void") throw conflict("That transaction was voided", "transaction_void");
        const [linked] = await tx
          .select({ id: commitmentOccurrences.id, commitmentId: commitmentOccurrences.commitmentId })
          .from(commitmentOccurrences)
          .where(and(eq(commitmentOccurrences.transactionId, transaction.id), ne(commitmentOccurrences.id, id)))
          .limit(1);
        if (linked) {
          throw conflict("That transaction already settles another payment", "transaction_already_linked", {
            occurrenceId: linked.id,
            commitmentId: linked.commitmentId,
          });
        }
        // A receipt chosen before linking joins the transaction's own attachments.
        if (input.attachmentFileIds?.length) {
          const existing = await tx
            .select({ fileId: transactionAttachments.fileId })
            .from(transactionAttachments)
            .where(eq(transactionAttachments.transactionId, transaction.id));
          const ids = [...new Set([...existing.map((row) => row.fileId), ...input.attachmentFileIds])].slice(0, 10);
          transaction = await this.transactions.update(ctx, transaction.id, { attachmentFileIds: ids }, { exec: tx });
        }
      } else {
        const currency = input.currency ?? before.currency;
        const amount = input.amount ?? (currency === before.currency ? before.amount : null);
        if (amount === null) throw unprocessable(`Enter the amount paid in ${currency}`, "amount_required");
        const accountId = input.accountId ?? commitment.accountId;
        await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [accountId], "Account");
        if (!accountId) throw unprocessable("Choose the account this was paid from", "missing_account");

        if (!input.force) {
          const candidates = await this.findCandidates(tx, ctx, commitment, id, { date: input.paidOn, amount, currency, accountId });
          if (candidates.length) {
            throw conflict("A matching transaction is already recorded. Link it to this payment, or record a new one anyway.", "possible_duplicate", {
              candidates,
            });
          }
        }

        const type = commitment.kind === "loan_payment" ? "debt_payment" : commitment.direction === "in" ? "income" : "expense";
        const payment: TransactionInput = {
          type,
          direction: commitment.direction,
          accountId,
          amount,
          currency,
          date: input.paidOn,
          merchant: await this.merchantFor(tx, commitment),
          counterpartyId: commitment.counterpartyId,
          categoryId: type === "debt_payment" ? null : commitment.categoryId,
          projectId: commitment.projectId,
          liabilityId: type === "debt_payment" ? commitment.liabilityId : null,
          description: commitment.name,
          notes: input.note ?? null,
          attachmentFileIds: input.attachmentFileIds,
        };
        const result = await this.transactions.create(ctx, payment, {
          exec: tx,
          source: "recurring",
          metadata: {
            origin: PAYMENT_ORIGIN,
            commitmentId: commitment.id,
            occurrenceId: id,
            subscriptionId: subscription?.id ?? null,
            dueDate: before.dueDate,
          },
        });
        transaction = result.transaction;
        created = true;
      }

      // A linked transaction is the record of when it was paid.
      const paidOn = created ? input.paidOn : transaction.date;
      const paidAmount = await this.inOccurrenceCurrency(tx, ctx, before, transaction.amount, transaction.currency, transaction.date);

      const [previous] = await tx
        .select()
        .from(commitmentOccurrences)
        .where(
          and(
            eq(commitmentOccurrences.commitmentId, commitment.id),
            eq(commitmentOccurrences.status, "paid"),
            lt(commitmentOccurrences.dueDate, before.dueDate),
          ),
        )
        .orderBy(desc(commitmentOccurrences.dueDate))
        .limit(1);
      const previousAmount = previous && previous.paidAmount !== null && previous.currency === before.currency ? previous.paidAmount : before.amount;
      const priceChange = paidAmount === null ? null : detectPriceChange(previousAmount, paidAmount);

      const [occurrence] = await tx
        .update(commitmentOccurrences)
        .set({ status: "paid", paidOn, paidAmount, transactionId: transaction.id, note: input.note ?? before.note })
        .where(eq(commitmentOccurrences.id, id))
        .returning();

      let amountUpdated = false;
      if (input.updateFutureAmount && paidAmount !== null && paidAmount !== commitment.amount) {
        await this.commitments.applyUpdate(tx, ctx, commitment, { amount: paidAmount, currency: before.currency });
        amountUpdated = true;
      }

      let inboxItemId: string | null = null;
      if (priceChange) {
        const label = (value: number) => formatMoney(value, before.currency);
        const percent = priceChange.percent === null ? "" : ` ${Math.abs(priceChange.percent)}%`;
        inboxItemId = await this.inbox.upsert(
          {
            workspaceId: ctx.workspaceId,
            kind: "price_change",
            severity: priceChange.direction === "increase" ? "warning" : "info",
            title: `${commitment.name} ${priceChange.direction === "increase" ? "went up" : "went down"}${percent}`,
            body:
              `Paid ${label(priceChange.current)} on ${paidOn}; the previous payment was ${label(priceChange.previous)}. ` +
              (amountUpdated
                ? "Future payments now use the new amount."
                : `Future payments still expect ${label(commitment.amount)} until you update the amount.`),
            data: {
              commitmentId: commitment.id,
              subscriptionId: subscription?.id,
              occurrenceId: id,
              previousAmount: priceChange.previous,
              newAmount: priceChange.current,
              percentChange: priceChange.percent ?? undefined,
              currency: before.currency,
              transactionIds: [previous?.transactionId, transaction.id].filter((value): value is string => Boolean(value)),
              previousTransactionId: previous?.transactionId ?? null,
              transactionId: transaction.id,
              amountUpdated,
              href: subscription ? links.subscription(subscription.id) : links.commitment(commitment.id),
            },
            entityType: "commitment",
            entityId: commitment.id,
            dedupeKey: priceChangeKey(id),
          },
          tx,
        );
      }

      await this.inbox.resolveByKey(ctx.workspaceId, unconfirmedKey(id), ctx.userId, tx);
      const advanced = await this.commitments.syncNext(tx, ctx, commitment.id);
      const nextOccurrence = advanced.status === "active" ? await this.commitments.nextScheduled(tx, commitment.id) : null;

      let updatedSubscription: SubscriptionRow | null = subscription;
      if (subscription) {
        const following = followingDueDate(scheduleOf(advanced), before.dueDate);
        const patch: Partial<SubscriptionRow> = {};
        if (RENEWABLE.has(subscription.status)) patch.status = "renewed";
        if (following && subscription.expiryDate && subscription.expiryDate <= before.dueDate) {
          patch.expiryDate = shiftWithCycle(subscription.expiryDate, before.dueDate, following) ?? following;
        }
        if (following && subscription.cancellationDeadline && subscription.cancellationDeadline <= before.dueDate) {
          const shifted = shiftWithCycle(subscription.cancellationDeadline, before.dueDate, following);
          if (shifted) patch.cancellationDeadline = shifted;
        }
        if (Object.keys(patch).length) {
          const [row] = await tx.update(subscriptions).set(patch).where(eq(subscriptions.id, subscription.id)).returning();
          updatedSubscription = row ?? subscription;
        }
      }

      await this.audit.record(tx, ctx, {
        action: "commitment.paid",
        entityType: "commitment_occurrence",
        entityId: id,
        before,
        after: { ...occurrence, created, priceChange, amountUpdated },
      });
      await this.events.publish(tx, ctx, "commitment.paid", {
        commitmentId: commitment.id,
        occurrenceId: id,
        transactionId: transaction.id,
        amount: paidAmount,
        currency: before.currency,
        created,
        nextDueDate: advanced.nextDueDate,
      });
      if (subscription) {
        await this.events.publish(tx, ctx, "subscription.renewed", {
          subscriptionId: subscription.id,
          commitmentId: commitment.id,
          occurrenceId: id,
          transactionId: transaction.id,
          nextRenewalDate: advanced.nextDueDate,
          expiryDate: updatedSubscription?.expiryDate ?? null,
        });
      }

      return {
        occurrence: occurrence as OccurrenceRow,
        transaction,
        created,
        commitment: advanced,
        nextOccurrence,
        subscription: updatedSubscription ?? null,
        priceChange,
        inboxItemId,
        amountUpdated,
      };
    });
  }

  async skip(ctx: WorkspaceContext, id: string, raw: z.input<typeof skipOccurrenceInput> = {}) {
    const input = skipOccurrenceInput.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.lock(tx, ctx, id);
      if (before.status !== "scheduled") throw conflict("Only a scheduled payment can be skipped", "not_scheduled");
      const [occurrence] = await tx
        .update(commitmentOccurrences)
        .set({ status: "skipped", note: input.note ?? before.note })
        .where(eq(commitmentOccurrences.id, id))
        .returning();
      await this.inbox.resolveByKey(ctx.workspaceId, unconfirmedKey(id), ctx.userId, tx);
      const commitment = await this.commitments.syncNext(tx, ctx, before.commitmentId);
      const nextOccurrence = commitment.status === "active" ? await this.commitments.nextScheduled(tx, commitment.id) : null;
      await this.audit.record(tx, ctx, { action: "commitment.skipped", entityType: "commitment_occurrence", entityId: id, before, after: occurrence });
      return { occurrence: occurrence as OccurrenceRow, commitment, nextOccurrence };
    });
  }

  /**
   * Puts a paid (or skipped) occurrence back to scheduled. A transaction this
   * payment created is voided; one that was linked is only unlinked.
   */
  async undo(ctx: WorkspaceContext, id: string, raw: UndoPaymentInput = {}) {
    const input = undoPaymentInput.parse(raw);
    return db.transaction(async (tx) => {
      const before = await this.lock(tx, ctx, id);
      if (before.status !== "paid" && before.status !== "skipped") throw conflict("Only a paid or skipped payment can be undone", "not_settled");
      let voidedTransactionId: string | null = null;
      let unlinkedTransactionId: string | null = null;
      let createdByPayment = false;
      if (before.transactionId) {
        const transaction = await this.transactions.get(ctx, before.transactionId, tx);
        createdByPayment = transaction.metadata?.origin === PAYMENT_ORIGIN && transaction.metadata?.occurrenceId === id;
      }
      const result = await this.revert(tx, ctx, before);
      if (before.transactionId) {
        if (createdByPayment) {
          await this.transactions.void(ctx, before.transactionId, input.reason ?? "Payment undone", { exec: tx });
          voidedTransactionId = before.transactionId;
        } else {
          unlinkedTransactionId = before.transactionId;
        }
      }
      await this.audit.record(tx, ctx, {
        action: "commitment.payment_undone",
        entityType: "commitment_occurrence",
        entityId: id,
        before,
        after: { ...result.occurrence, voidedTransactionId, unlinkedTransactionId, reason: input.reason ?? null },
      });
      return { ...result, voidedTransactionId, unlinkedTransactionId };
    });
  }

  /**
   * Back to scheduled: clears the payment, resolves its price-change item,
   * restores the subscription's expiry and deadline when this renewal moved
   * them, and re-points the commitment at its earliest unsettled occurrence.
   */
  private async revert(tx: Executor, ctx: WorkspaceContext, before: OccurrenceRow) {
    const [occurrence] = await tx
      .update(commitmentOccurrences)
      .set({ status: "scheduled", paidOn: null, paidAmount: null, transactionId: null })
      .where(eq(commitmentOccurrences.id, before.id))
      .returning();
    await this.inbox.resolveByKey(ctx.workspaceId, priceChangeKey(before.id), ctx.userId, tx);

    let commitment = await this.commitments.get(ctx, before.commitmentId, tx);
    if (commitment.status === "ended" && before.status === "paid") {
      // A paid one-off (or final payment) ended the schedule; it is owed again.
      const [reopened] = await tx
        .update(commitments)
        .set({ status: "active", nextDueDate: before.dueDate })
        .where(eq(commitments.id, commitment.id))
        .returning();
      commitment = reopened as CommitmentRow;
    }
    commitment = await this.commitments.syncNext(tx, ctx, commitment.id);

    const subscription = await this.subscriptionFor(tx, commitment.id);
    let updatedSubscription = subscription;
    if (subscription && before.status === "paid") {
      const [laterPaid] = await tx
        .select({ id: commitmentOccurrences.id })
        .from(commitmentOccurrences)
        .where(
          and(
            eq(commitmentOccurrences.commitmentId, commitment.id),
            eq(commitmentOccurrences.status, "paid"),
            gt(commitmentOccurrences.dueDate, before.dueDate),
          ),
        )
        .limit(1);
      const following = followingDueDate(scheduleOf(commitment), before.dueDate);
      const patch: Partial<SubscriptionRow> = {};
      if (!laterPaid && following) {
        if (subscription.expiryDate && subscription.expiryDate > before.dueDate && subscription.expiryDate <= following) {
          patch.expiryDate = addDays(before.dueDate, -diffDays(subscription.expiryDate, following));
        }
        if (subscription.cancellationDeadline && subscription.cancellationDeadline > before.dueDate && subscription.cancellationDeadline <= following) {
          patch.cancellationDeadline = addDays(before.dueDate, -diffDays(subscription.cancellationDeadline, following));
        }
      }
      if (subscription.status === "renewed") {
        patch.status = deriveSubscriptionStatus(
          {
            name: commitment.name,
            status: "active",
            autoRenew: subscription.autoRenew,
            nextRenewalDate: commitment.status === "active" ? commitment.nextDueDate : null,
            expiryDate: patch.expiryDate ?? subscription.expiryDate,
            cancellationDeadline: patch.cancellationDeadline ?? subscription.cancellationDeadline,
            trialEndsOn: subscription.trialEndsOn,
          },
          todayFor(ctx),
        );
      }
      if (Object.keys(patch).length) {
        const [row] = await tx.update(subscriptions).set(patch).where(eq(subscriptions.id, subscription.id)).returning();
        updatedSubscription = row ?? subscription;
      }
    }
    return { occurrence: occurrence as OccurrenceRow, commitment, subscription: updatedSubscription ?? null };
  }

  /** A voided payment no longer settles its occurrence. */
  private async onTransactionVoided(event: DomainEvent) {
    const transactionId = typeof event.payload.transactionId === "string" ? event.payload.transactionId : null;
    if (!transactionId || !event.workspaceId) return;
    const [linked] = await db
      .select()
      .from(commitmentOccurrences)
      .where(and(eq(commitmentOccurrences.workspaceId, event.workspaceId), eq(commitmentOccurrences.transactionId, transactionId)))
      .limit(1);
    if (linked?.status !== "paid") return;
    const ctx = await systemContext(event.workspaceId);
    if (!ctx) return;
    await db.transaction(async (tx) => {
      const current = await this.lock(tx, ctx, linked.id);
      if (current.status !== "paid" || current.transactionId !== transactionId) return;
      const result = await this.revert(tx, ctx, current);
      await this.audit.record(tx, ctx, {
        action: "commitment.payment_reverted",
        entityType: "commitment_occurrence",
        entityId: current.id,
        before: current,
        after: { ...result.occurrence, voidedTransactionId: transactionId },
      });
    });
    this.logger.log(`Occurrence ${linked.id} reverted: transaction ${transactionId} was voided`);
  }
}
