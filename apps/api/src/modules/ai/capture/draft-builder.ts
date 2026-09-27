import { type Day, formatMoney, type RuleOutcome, type TransactionInput, type TransactionSource, TYPE_RULES } from "@expensewise/core";
import type { CaptureDraftView, ConfidenceField, DuplicateCandidateView, SuggestedRef } from "@expensewise/core/contracts/ai-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, ne } from "drizzle-orm";
import type { WorkspaceContext } from "../../../common/context.js";
import { db } from "../../../db/index.js";
import { financialAccounts, workspaceMembers, workspaces } from "../../../db/schema/index.js";
import type { AiConfidence } from "../../../db/schema/types.js";
import {
  CategoriesService,
  type CategoryRow,
  CounterpartiesService,
  type CounterpartyRow,
  type ProjectRow,
  ProjectsService,
  RulesService,
} from "../../ledger/catalog.service.js";
import { TransactionsService } from "../../ledger/transactions.service.js";
import type { PaymentMethod } from "../gateway/schemas.js";
import { type Candidate, occurredAtFor } from "./normalize.js";

type AccountRow = typeof financialAccounts.$inferSelect;

/** What the workspace looks like, loaded once per capture. */
export type WorkspaceSnapshot = {
  accounts: AccountRow[];
  categories: CategoryRow[];
  projects: ProjectRow[];
  /** The user's other workspaces, for "this looks like a business expense". */
  otherWorkspaces: Array<{
    id: string;
    name: string;
    kind: "personal" | "business";
  }>;
};

export type ResolvedDraft = {
  candidate: Candidate;
  /** A rule says to skip records like this one. */
  ignoredBy: string[] | null;
  input: TransactionInput;
  confidence: AiConfidence;
  missing: ConfidenceField[];
  lowConfidence: ConfidenceField[];
  suggestions: CaptureDraftView["suggestions"];
  duplicates: DuplicateCandidateView[];
  suggestedWorkspace: CaptureDraftView["suggestedWorkspace"];
  ruleIds: string[];
  requireReview: boolean;
  reviewReason: string;
};

/** Below this a field is shown for confirmation. */
export const REVIEW_THRESHOLD = 0.8;
/** Auto-posting (when the workspace allows it) needs every required field at or above this. */
export const AUTO_POST_THRESHOLD = 0.95;
const REQUIRED: ConfidenceField[] = ["amount", "currency", "date", "type", "account"];

const WALLET_METHODS = new Set<PaymentMethod>(["bkash", "nagad", "rocket", "upay"]);
const PROVIDER_METHODS = new Set<PaymentMethod>(["paypal", "payoneer", "wise", "stripe"]);

const METHOD_LABELS: Partial<Record<PaymentMethod, string>> = {
  bkash: "bKash",
  nagad: "Nagad",
  rocket: "Rocket",
  upay: "Upay",
  card: "card",
  bank: "bank",
  cash: "cash",
  paypal: "PayPal",
  payoneer: "Payoneer",
  wise: "Wise",
  stripe: "Stripe",
};

const round = (value: number) => Math.round(value * 100) / 100;

/** The accounts a payment method points at, narrowed by the card/account's last digits when printed. */
export function accountsForMethod(accounts: AccountRow[], method: PaymentMethod | null, last4: string | null): { matches: AccountRow[]; exact: boolean } {
  const provider = (a: AccountRow) => (a.provider ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const name = (a: AccountRow) => a.name.toLowerCase();
  if (last4) {
    const byMask = accounts.filter((a) => a.mask?.replace(/\D/g, "").endsWith(last4));
    if (byMask.length === 1) return { matches: byMask, exact: true };
  }
  if (!method || method === "other" || method === "unknown") return { matches: [], exact: false };
  let matches: AccountRow[] = [];
  let exact = false;
  if (WALLET_METHODS.has(method) || PROVIDER_METHODS.has(method)) {
    const byProvider = accounts.filter((a) => provider(a) === method);
    exact = byProvider.length > 0;
    matches = byProvider.length ? byProvider : accounts.filter((a) => name(a).includes(method));
  } else if (method === "card") {
    matches = accounts.filter((a) => a.kind === "card");
  } else if (method === "bank") {
    matches = accounts.filter((a) => a.kind === "bank" || a.kind === "savings");
  } else if (method === "cash") {
    matches = accounts.filter((a) => a.kind === "cash");
  }
  return { matches, exact };
}

function categoryKindFor(type: TransactionInput["type"], direction: "in" | "out"): "expense" | "income" | null {
  if (type === "expense") return "expense";
  if (type === "income") return "income";
  if (type === "refund") return direction === "in" ? "expense" : "income";
  return null;
}

/**
 * Turns one normalised candidate into a draft transaction for this
 * workspace. Each field is decided by the most trustworthy layer that has an
 * answer — a rule, then merchant memory, then the model or the parser — and
 * carries that layer's confidence, so the review screen can say why.
 */
@Injectable()
export class DraftBuilder {
  constructor(
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(CounterpartiesService)
    private readonly counterparties: CounterpartiesService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(RulesService) private readonly rules: RulesService,
  ) {}

  async snapshot(ctx: WorkspaceContext): Promise<WorkspaceSnapshot> {
    const [accounts, categories, projects, others] = await Promise.all([
      db
        .select()
        .from(financialAccounts)
        .where(and(eq(financialAccounts.workspaceId, ctx.workspaceId), eq(financialAccounts.status, "active")))
        .orderBy(asc(financialAccounts.sortOrder), asc(financialAccounts.createdAt)),
      this.categories.list(ctx),
      this.projects.list(ctx),
      ctx.userId
        ? db
            .select({
              id: workspaces.id,
              name: workspaces.name,
              kind: workspaces.kind,
            })
            .from(workspaceMembers)
            .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
            .where(and(eq(workspaceMembers.userId, ctx.userId), ne(workspaces.id, ctx.workspaceId), ne(workspaceMembers.role, "viewer")))
            .orderBy(asc(workspaces.createdAt))
        : Promise.resolve([]),
    ]);
    return { accounts, categories, projects, otherWorkspaces: others };
  }

  async resolve(
    ctx: WorkspaceContext,
    candidate: Candidate,
    snapshot: WorkspaceSnapshot,
    options: {
      source: TransactionSource;
      captureId: string;
      fileId: string | null;
      today: Day;
      methodLabel: string;
    },
  ): Promise<ResolvedDraft> {
    const fields: AiConfidence["fields"] = {};
    const sources: NonNullable<AiConfidence["sources"]> = {};
    const layer = (field: keyof typeof candidate.confidence) => candidate.sources[field] ?? (options.methodLabel === "parser" ? "parser" : "ai");
    const set = (field: ConfidenceField, confidence: number, source: NonNullable<AiConfidence["sources"]>[ConfidenceField]) => {
      fields[field] = round(confidence);
      sources[field] = source;
    };

    // Type and direction: the ledger needs one; unknown is shown as a question.
    let type: TransactionInput["type"] = candidate.type ?? "expense";
    let direction: "in" | "out" = candidate.direction ?? TYPE_RULES[type].defaultDirection;
    set("type", candidate.type ? candidate.confidence.type : 0.3, layer("type"));
    let merchant = candidate.merchant;
    if (merchant) set("merchant", candidate.confidence.merchant, layer("merchant"));
    set("amount", candidate.confidence.amount, layer("amount"));
    set("currency", candidate.confidence.currency, layer("currency"));
    let date = candidate.date;
    set("date", date ? candidate.confidence.date : 0, layer("date"));
    if (candidate.time) set("time", candidate.confidence.time, layer("time"));
    if (candidate.reference) set("reference", candidate.confidence.reference, layer("reference"));

    let counterparty: CounterpartyRow | null = merchant ? await this.counterparties.match(db, ctx.workspaceId, merchant) : null;

    // Account: the payment method, then the merchant's usual account, then the only account there is.
    let accountId: string | null = null;
    let accountSource: SuggestedRef["source"] = "ai";
    let accountConfidence = 0;
    let accountCandidates: AccountRow[] = [];
    const methodMatch = accountsForMethod(snapshot.accounts, candidate.paymentMethod, candidate.cardLast4);
    const methodKnown = candidate.paymentMethod !== null && candidate.paymentMethod !== "other" && candidate.paymentMethod !== "unknown";
    if (methodMatch.matches.length === 1) {
      accountId = methodMatch.matches[0]?.id ?? null;
      accountSource = layer("paymentMethod");
      accountConfidence = Math.min(methodMatch.exact ? 0.95 : 0.85, Math.max(candidate.confidence.paymentMethod, 0.5) + 0.1);
    } else if (methodMatch.matches.length > 1) {
      const preferred = methodMatch.matches.find((a) => a.id === counterparty?.defaultAccountId);
      if (preferred) {
        accountId = preferred.id;
        accountSource = "merchant";
        accountConfidence = 0.8;
      } else {
        accountCandidates = methodMatch.matches;
      }
    } else if (!methodKnown && counterparty?.defaultAccountId && snapshot.accounts.some((a) => a.id === counterparty?.defaultAccountId)) {
      accountId = counterparty.defaultAccountId;
      accountSource = "merchant";
      accountConfidence = counterparty.confirmations >= 2 ? 0.85 : 0.7;
    } else if (!methodKnown && snapshot.accounts.length === 1) {
      accountId = snapshot.accounts[0]?.id ?? null;
      accountSource = "parser";
      accountConfidence = 0.85;
    }
    const notes = [...candidate.notes];
    if (methodKnown && !methodMatch.matches.length && candidate.paymentMethod) {
      notes.push(`Paid with ${METHOD_LABELS[candidate.paymentMethod] ?? candidate.paymentMethod}, but no matching account exists in this workspace.`);
    }

    // Rules run on what is known so far and outrank everything else.
    const outcome: RuleOutcome = await this.rules.evaluate(ctx, {
      merchant,
      description: candidate.description,
      amount: candidate.amount,
      currency: candidate.currency,
      accountId,
      source: options.source,
      type,
      reference: candidate.reference,
    });
    const actions = outcome.actions;
    if (actions.type) {
      type = actions.type;
      direction = candidate.direction && TYPE_RULES[type].directions.includes(candidate.direction) ? candidate.direction : TYPE_RULES[type].defaultDirection;
      set("type", 1, "rule");
    }
    if (actions.merchant) {
      merchant = actions.merchant;
      set("merchant", 1, "rule");
      counterparty = await this.counterparties.match(db, ctx.workspaceId, merchant);
    }
    if (actions.accountId && snapshot.accounts.some((a) => a.id === actions.accountId)) {
      accountId = actions.accountId;
      accountSource = "rule";
      accountConfidence = 1;
      accountCandidates = [];
    }
    if (accountId) set("account", accountConfidence, accountSource);

    // Category: rule, merchant memory, then the model's or parser's name.
    const kind = categoryKindFor(type, direction);
    const categoryById = new Map(snapshot.categories.map((c) => [c.id, c]));
    let category: SuggestedRef | null = null;
    let unmatchedCategoryName: string | null = null;
    if (kind) {
      const ruleCategory = actions.categoryId ? categoryById.get(actions.categoryId) : undefined;
      const memory = counterparty?.defaultCategoryId ? categoryById.get(counterparty.defaultCategoryId) : undefined;
      if (ruleCategory && ruleCategory.kind === kind) {
        category = {
          id: ruleCategory.id,
          name: ruleCategory.name,
          source: "rule",
          confidence: 1,
        };
      } else if (memory && memory.kind === kind) {
        const confirmations = counterparty?.confirmations ?? 0;
        category = {
          id: memory.id,
          name: memory.name,
          source: "merchant",
          confidence: confirmations >= 2 ? 0.95 : confirmations === 1 ? 0.8 : 0.6,
        };
      } else if (candidate.categoryName) {
        const match = await this.categories.resolveName(ctx, candidate.categoryName, kind);
        if (match)
          category = {
            id: match.id,
            name: match.name,
            source: layer("category"),
            confidence: round(Math.min(0.85, candidate.confidence.category || 0.6)),
          };
        else unmatchedCategoryName = candidate.categoryName;
      }
    }
    if (category) set("category", category.confidence, category.source);

    // Project: rule, merchant memory, then a named project.
    const projectById = new Map(snapshot.projects.map((p) => [p.id, p]));
    let project: SuggestedRef | null = null;
    let unmatchedProjectName: string | null = null;
    const ruleProject = actions.projectId ? projectById.get(actions.projectId) : undefined;
    const memoryProject = counterparty?.defaultProjectId ? projectById.get(counterparty.defaultProjectId) : undefined;
    if (ruleProject)
      project = {
        id: ruleProject.id,
        name: ruleProject.name,
        source: "rule",
        confidence: 1,
      };
    else if (memoryProject)
      project = {
        id: memoryProject.id,
        name: memoryProject.name,
        source: "merchant",
        confidence: (counterparty?.confirmations ?? 0) >= 2 ? 0.9 : 0.6,
      };
    else if (candidate.projectName) {
      const match = await this.projects.resolveName(ctx, candidate.projectName);
      if (match)
        project = {
          id: match.id,
          name: match.name,
          source: layer("project"),
          confidence: round(Math.min(0.85, candidate.confidence.project || 0.6)),
        };
      else unmatchedProjectName = candidate.projectName;
    }
    if (project) set("project", project.confidence, project.source);

    // A business expense captured in the personal workspace stays here, flagged.
    let suggestedWorkspace: ResolvedDraft["suggestedWorkspace"] = null;
    if (candidate.workspaceHint && candidate.workspaceHint !== ctx.workspaceKind && candidate.confidence.workspace >= 0.5) {
      const target = snapshot.otherWorkspaces.find((w) => w.kind === candidate.workspaceHint);
      suggestedWorkspace = {
        kind: candidate.workspaceHint,
        confidence: round(candidate.confidence.workspace),
        workspaceId: target?.id ?? null,
        workspaceName: target?.name ?? null,
      };
      set("workspace", 1 - candidate.confidence.workspace, layer("workspace"));
    } else if (candidate.workspaceHint) {
      set("workspace", candidate.confidence.workspace, layer("workspace"));
    }

    // Same money already in the books? An identical TrxID settles it.
    let duplicates: DuplicateCandidateView[] = [];
    if (candidate.amount !== null && date) {
      const matches = await this.transactions.findDuplicates(ctx, {
        date,
        amount: candidate.amount,
        currency: candidate.currency,
        merchant,
        accountId,
        reference: candidate.reference,
      });
      duplicates = matches
        .filter((match) => match.transaction.sourceRef !== options.captureId)
        .slice(0, 5)
        .map((match) => ({
          transactionId: match.id,
          score: match.score,
          exact: match.exact,
          reasons: match.reasons,
          transaction: {
            id: match.transaction.id,
            status: match.transaction.status,
            type: match.transaction.type,
            date: match.transaction.date,
            amount: match.transaction.amount,
            currency: match.transaction.currency,
            merchant: match.transaction.merchant,
            reference: match.transaction.reference,
            accountId: match.transaction.accountId,
            source: match.transaction.source,
          },
        }));
    }

    const missing: ConfidenceField[] = [];
    if (candidate.amount === null) missing.push("amount");
    if (!date) missing.push("date");
    if (!candidate.type && !actions.type) missing.push("type");
    if (!accountId) missing.push("account");
    const lowConfidence = (Object.entries(fields) as Array<[ConfidenceField, number]>)
      .filter(([field, value]) => value < REVIEW_THRESHOLD && !missing.includes(field) && field !== "workspace" && field !== "time")
      .map(([field]) => field);
    const overall = round(Math.min(...REQUIRED.map((field) => (missing.includes(field) ? 0 : (fields[field] ?? 0)))));
    const requireReview = actions.requireReview === true;

    // A placeholder date keeps the draft storable; it is flagged, never trusted.
    if (!date) date = options.today;

    const reasons: string[] = [];
    const exact = duplicates.find((d) => d.exact);
    if (exact) reasons.push(`Possible duplicate: same transaction ID as a transaction on ${exact.transaction.date}`);
    else if (duplicates[0]) {
      reasons.push(
        `Possible duplicate of ${formatMoney(duplicates[0].transaction.amount, duplicates[0].transaction.currency)} on ${duplicates[0].transaction.date}`,
      );
    }
    if (missing.length) reasons.push(`Needs ${missing.join(", ")}`);
    if (lowConfidence.length) reasons.push(`Check ${lowConfidence.join(", ")}`);
    if (requireReview) reasons.push("A rule asks for review");
    if (suggestedWorkspace) reasons.push(`Looks like a ${suggestedWorkspace.kind} transaction`);
    if (!reasons.length) reasons.push("Read from a capture; confirm to post");

    return {
      candidate: { ...candidate, notes },
      ignoredBy: actions.ignore ? outcome.matchedRuleIds : null,
      input: {
        type,
        direction,
        status: "draft",
        accountId,
        amount: candidate.amount ?? 1,
        currency: candidate.currency,
        date,
        occurredAt: occurredAtFor(candidate.date, candidate.time, ctx.timezone),
        merchant,
        counterpartyId: type === "transfer" ? null : (counterparty?.id ?? null),
        categoryId: category?.id ?? null,
        projectId: project?.id ?? null,
        description: candidate.description,
        reference: candidate.reference,
        attachmentFileIds: options.fileId ? [options.fileId] : undefined,
      },
      confidence: { overall, fields, sources, model: undefined },
      missing,
      lowConfidence,
      suggestions: {
        category,
        project,
        account: accountId
          ? {
              id: accountId,
              name: snapshot.accounts.find((a) => a.id === accountId)?.name ?? "",
              source: accountSource,
              confidence: round(accountConfidence),
            }
          : null,
        accountCandidates: accountCandidates.map((a) => ({
          id: a.id,
          name: a.name,
        })),
        unmatchedCategoryName,
        unmatchedProjectName,
      },
      duplicates,
      suggestedWorkspace,
      ruleIds: outcome.matchedRuleIds,
      requireReview,
      reviewReason: reasons.join(" · "),
    };
  }

  /** Every required field is certain enough, nothing looks duplicated, nothing asks for a person. */
  static autoPostable(draft: ResolvedDraft): boolean {
    if (draft.missing.length || draft.duplicates.length || draft.requireReview || draft.suggestedWorkspace) return false;
    if (draft.input.type === "transfer") return false;
    return REQUIRED.every((field) => (draft.confidence.fields[field] ?? 0) >= AUTO_POST_THRESHOLD);
  }
}
