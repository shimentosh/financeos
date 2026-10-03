import {
  ACCOUNT_KINDS,
  accountInput,
  budgetInput,
  COMMITMENT_KINDS,
  type CopilotAction,
  type CopilotActionKind,
  categoryInput,
  commitmentInput,
  currencyDecimals,
  type Day,
  formatDay,
  formatMoney,
  GOAL_KINDS,
  goalInput,
  isDay,
  LIABILITY_KINDS,
  liabilityInput,
  normalizeName,
  projectInput,
  receivableInput,
  ruleInput,
  startOfMonth,
  subscriptionInput,
  TRANSACTION_TYPES,
  type TransactionType,
  TYPE_LABELS,
  TYPE_RULES,
  transactionInput,
  transactionUpdate,
  uuidv7,
} from "@expensewise/core";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import type { ToolDefinition } from "../ai/gateway/types.js";
import { AccountsService } from "../ledger/accounts.service.js";
import { CategoriesService, ProjectsService, RulesService } from "../ledger/catalog.service.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { BudgetsService } from "../planning/budgets.service.js";
import { CommitmentsService } from "../planning/commitments.service.js";
import { GoalsService } from "../planning/goals.service.js";
import { SubscriptionsService } from "../planning/subscriptions.service.js";
import { LiabilitiesService } from "../wealth/liabilities.service.js";
import { ReceivablesService } from "../wealth/receivables.service.js";
import { AgentMemoryService } from "./agent-memory.service.js";

type Detail = { label: string; value: string };
/** A value that becomes a real id once the action it names is applied (a category created in the same answer). */
type Ref = { $ref: string };
type Id = string | Ref;
export type Prepared = {
  title: string;
  summary: string;
  details: Detail[];
  warnings: string[];
  dependsOn: string[];
  payload: Record<string, unknown>;
};
export type Applied = { id: string; label: string; href: string | null };
type ApplyMeta = { actionId: string; via: "chat" | "mcp" };

const isRef = (value: unknown): value is Ref => typeof value === "object" && value !== null && "$ref" in value;
// Stands in for a not-yet-created id when checking a payload against its contract.
const PLACEHOLDER = "00000000-0000-7000-8000-000000000000";

/** Replaces every reference with the id its action produced. */
function resolveRefs<T>(value: T, ids: (actionId: string) => string): T {
  if (isRef(value)) return ids(value.$ref) as T;
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, ids)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveRefs(item, ids)])) as T;
  }
  return value;
}

const refsIn = (value: unknown): string[] =>
  isRef(value)
    ? [value.$ref]
    : Array.isArray(value)
      ? value.flatMap(refsIn)
      : value && typeof value === "object"
        ? Object.values(value as Record<string, unknown>).flatMap(refsIn)
        : [];

/** "500" taka → 50000 minor units, using the currency's own decimals. */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyDecimals(currency));
}

/**
 * The actions proposed during one answer, so a later call can use what an
 * earlier one creates ("create Office Rent, then record rent in it"). Tool
 * calls may arrive in parallel; proposals run one at a time, in call order.
 */
export class ProposalBook {
  readonly actions: CopilotAction[] = [];
  readonly remembered: Array<{ id: string; text: string }> = [];
  private queue: Promise<unknown> = Promise.resolve();

  serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  find(kind: CopilotActionKind, name: string, extra?: (action: CopilotAction) => boolean): CopilotAction | undefined {
    const wanted = normalizeName(name);
    return this.actions.find(
      (action) =>
        action.kind === kind && action.status === "proposed" && normalizeName(String(action.payload.name ?? "")) === wanted && (!extra || extra(action)),
    );
  }
}

const day = z.string().describe("A date as YYYY-MM-DD");
const money = z.number().positive().describe("In major units, as people say it: 500 for ৳500, 12.99 for $12.99");
const currency = z.string().trim().length(3).nullish().describe("ISO code such as BDT or USD; defaults to the account's (or workspace's) currency");

type Spec = {
  kind: CopilotActionKind;
  description: string;
  inputSchema: z.ZodObject;
  /** The service's own request contract, checked when preparing so a confirmed card never fails validation. */
  contract: z.ZodType;
  /** Where the contract applies inside the payload (update_transaction keeps its changes under `changes`). */
  contractPath?: string;
  /** Business workspaces only. */
  business?: boolean;
  prepare: (ctx: WorkspaceContext, input: never, book: ProposalBook) => Promise<Prepared>;
  apply: (ctx: WorkspaceContext, payload: never, meta: ApplyMeta) => Promise<Applied>;
};

/**
 * The copilot's write side. Every action validates and resolves names to ids
 * without changing anything (`prepare`), then writes through the domain
 * services (`apply`) — the same code paths, checks and audit trail as the
 * app's own forms. The chat keeps prepared actions as proposals for the user
 * to confirm; MCP applies them straight away.
 */
@Injectable()
export class CopilotActions {
  private readonly specs: Spec[];

  constructor(
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(GoalsService) private readonly goals: GoalsService,
    @Inject(ReceivablesService) private readonly receivables: ReceivablesService,
    @Inject(LiabilitiesService) private readonly liabilities: LiabilitiesService,
    @Inject(AgentMemoryService) private readonly memory: AgentMemoryService,
  ) {
    this.specs = this.build();
  }

  spec(kind: CopilotActionKind): Spec {
    const found = this.specs.find((s) => s.kind === kind);
    if (!found) throw new Error(`Unknown action ${kind}`);
    return found;
  }

  available(ctx: WorkspaceContext): Spec[] {
    return this.specs.filter((s) => !s.business || ctx.workspaceKind === "business");
  }

  /** Validates an input and describes the change, without making it. */
  async prepare(ctx: WorkspaceContext, kind: CopilotActionKind, input: unknown, book = new ProposalBook()): Promise<Prepared> {
    const spec = this.spec(kind);
    const parsed = spec.inputSchema.parse(input);
    const prepared = await spec.prepare(ctx, parsed as never, book);
    const concrete = resolveRefs(prepared.payload, () => PLACEHOLDER);
    const checked = spec.contract.safeParse(spec.contractPath ? concrete[spec.contractPath] : concrete);
    if (!checked.success) {
      throw new Error(`Can't prepare that: ${checked.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`);
    }
    return { ...prepared, dependsOn: [...new Set(refsIn(prepared.payload))] };
  }

  /** Makes a prepared change. `ids` gives the id each referenced action produced. */
  apply(ctx: WorkspaceContext, kind: CopilotActionKind, payload: Record<string, unknown>, meta: ApplyMeta, ids: (actionId: string) => string = missingRef) {
    return this.spec(kind).apply(ctx, resolveRefs(payload, ids) as never, meta);
  }

  /** Chat tools: each prepares an action and adds it to the book as a proposal. */
  proposalTools(ctx: WorkspaceContext, book: ProposalBook): ToolDefinition[] {
    return this.available(ctx).map((spec) => ({
      name: spec.kind,
      description: `${spec.description} Shown to the user as a card to confirm; nothing is saved until they do.`,
      inputSchema: spec.inputSchema,
      run: (input: unknown) =>
        book.serial(async () => {
          const prepared = await this.prepare(ctx, spec.kind, input, book);
          const action: CopilotAction = { id: uuidv7(), kind: spec.kind, ...prepared, status: "proposed", result: null, error: null, updatedAt: null };
          book.actions.push(action);
          return {
            status: "proposed — waiting for the user to confirm",
            actionId: action.id,
            summary: `${action.title}: ${action.summary}`,
            warnings: action.warnings,
          };
        }),
    }));
  }

  /** MCP tools: prepare and apply at once (the key's write scope and the client's own approval are the confirmation). */
  directTools(ctx: WorkspaceContext): ToolDefinition[] {
    return this.available(ctx).map((spec) => ({
      name: spec.kind,
      description: spec.description,
      inputSchema: spec.inputSchema,
      run: async (input: unknown) => {
        const prepared = await this.prepare(ctx, spec.kind, input);
        const applied = await this.apply(ctx, spec.kind, prepared.payload, { actionId: uuidv7(), via: "mcp" });
        return { done: `${prepared.title}: ${prepared.summary}`, id: applied.id, link: applied.href, warnings: prepared.warnings };
      },
    }));
  }

  /**
   * The names the model needs to get right (accounts, categories, projects)
   * and the memory; plus `remember`/`forget` when the caller may write.
   */
  contextTools(ctx: WorkspaceContext, options: { write: boolean; book?: ProposalBook }): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "get_setup",
        description:
          "The workspace's accounts (name, kind, currency), categories by kind, projects, base currency, today's date and the notes the user saved. Call it before recording or creating anything whose names you aren't sure of.",
        inputSchema: z.object({}),
        run: async () => {
          const [accounts, categories, projects, memory] = await Promise.all([
            this.accounts.list(ctx),
            this.categories.list(ctx),
            ctx.workspaceKind === "business" ? this.projects.list(ctx) : Promise.resolve([]),
            this.memory.list(ctx),
          ]);
          const live = categories.filter((c) => !c.archived);
          const tree = (kind: "expense" | "income") =>
            live
              .filter((c) => c.kind === kind && !c.parentId)
              .map((parent) => {
                const children = live.filter((c) => c.parentId === parent.id).map((c) => c.name);
                return children.length ? `${parent.name} (${children.join(", ")})` : parent.name;
              });
          return {
            today: todayFor(ctx),
            workspace: { name: ctx.workspaceName, kind: ctx.workspaceKind, baseCurrency: ctx.baseCurrency, timezone: ctx.timezone },
            accounts: accounts.map((a) => ({
              name: a.name,
              kind: a.kind,
              currency: a.currency,
              provider: a.provider,
              balance: formatMoney(a.balance, a.currency),
            })),
            categories: { expense: tree("expense"), income: tree("income") },
            projects: projects.filter((p) => p.status !== "archived").map((p) => p.name),
            notes: memory.map((item) => item.text),
          };
        },
      },
    ];
    if (options.write) {
      tools.push(
        {
          name: "remember",
          description:
            "Save one short fact the user wants you to keep for later conversations (their salary day, which account pays which bill, what a merchant is). Saved at once and visible in Settings → AI.",
          inputSchema: z.object({ text: z.string().trim().min(2).max(300).describe("One sentence in the user's own terms") }),
          run: async (input: { text: string }) => {
            const { item, duplicate } = await this.memory.add(ctx, input);
            if (!duplicate) options.book?.remembered.push({ id: item.id, text: item.text });
            return duplicate ? { saved: false, note: "Already remembered" } : { saved: true };
          },
        } as unknown as ToolDefinition,
        {
          name: "forget",
          description: "Remove a saved note the user no longer wants kept. Pass words from the note; get_setup lists them.",
          inputSchema: z.object({ text: z.string().trim().min(2).max(300) }),
          run: async (input: { text: string }) => {
            const items = await this.memory.list(ctx);
            const wanted = normalizeName(input.text);
            const match = items.find((item) => normalizeName(item.text) === wanted) ?? items.find((item) => normalizeName(item.text).includes(wanted));
            if (!match) throw new Error(`No saved note matches "${input.text}". Saved notes: ${items.map((item) => item.text).join(" | ") || "none"}`);
            await this.memory.remove(ctx, match.id);
            return { removed: match.text };
          },
        } as unknown as ToolDefinition,
      );
    }
    return tools;
  }

  // ----------------------------------------------------------- name lookups

  private async account(ctx: WorkspaceContext, name: string | null | undefined, book: ProposalBook, label = "account") {
    const all = await this.accounts.list(ctx);
    const names = all.map((a) => a.name).join(", ") || "none yet";
    if (!name) {
      if (all.length === 1 && all[0]) return { id: all[0].id as Id, name: all[0].name, currency: all[0].currency };
      throw new Error(`Which ${label}? The accounts are: ${names}. Ask the user if it isn't clear.`);
    }
    const wanted = normalizeName(name);
    const pending = book.find("create_account", name);
    if (pending) return { id: { $ref: pending.id } as Id, name: String(pending.payload.name), currency: String(pending.payload.currency) };
    const exact = all.filter((a) => normalizeName(a.name) === wanted || (a.provider && normalizeName(a.provider) === wanted));
    const loose = exact.length ? exact : all.filter((a) => normalizeName(a.name).includes(wanted) || wanted.includes(normalizeName(a.name)));
    if (loose.length === 1 && loose[0]) return { id: loose[0].id as Id, name: loose[0].name, currency: loose[0].currency };
    if (loose.length > 1) throw new Error(`"${name}" matches several accounts (${loose.map((a) => a.name).join(", ")}). Ask which one.`);
    throw new Error(`No account called "${name}". The accounts are: ${names}. Propose create_account if the user wants a new one.`);
  }

  private async category(ctx: WorkspaceContext, name: string | null | undefined, kind: "expense" | "income", book: ProposalBook) {
    if (!name) return null;
    const pending = book.find("create_category", name, (action) => action.payload.kind === kind);
    if (pending) return { id: { $ref: pending.id } as Id, name: String(pending.payload.name) };
    const found = await this.categories.resolveName(ctx, name, kind);
    if (found) return { id: found.id as Id, name: found.name };
    const all = (await this.categories.list(ctx)).filter((c) => c.kind === kind && !c.archived).map((c) => c.name);
    throw new Error(
      `No ${kind} category called "${name}". Existing ones: ${all.join(", ") || "none"}. Use one of those, or propose create_category first and then use its name.`,
    );
  }

  private async project(ctx: WorkspaceContext, name: string | null | undefined, book: ProposalBook) {
    if (!name) return null;
    if (ctx.workspaceKind !== "business") throw new Error("Projects exist only in business workspaces.");
    const pending = book.find("create_project", name);
    if (pending) return { id: { $ref: pending.id } as Id, name: String(pending.payload.name) };
    const found = await this.projects.resolveName(ctx, name);
    if (found) return { id: found.id as Id, name: found.name };
    const all = (await this.projects.list(ctx)).map((p) => p.name);
    throw new Error(`No project called "${name}". Projects: ${all.join(", ") || "none"}.`);
  }

  private date(ctx: WorkspaceContext, value: string | null | undefined, label = "date"): Day {
    if (!value) return todayFor(ctx);
    if (!isDay(value)) throw new Error(`The ${label} must be a date as YYYY-MM-DD`);
    return value as Day;
  }

  private currencyFor(ctx: WorkspaceContext, value: string | null | undefined, fallback?: string) {
    return (value ?? fallback ?? ctx.baseCurrency).toUpperCase();
  }

  // ----------------------------------------------------------------- specs

  private build(): Spec[] {
    const detail = (label: string, value: string | null | undefined): Detail[] => (value ? [{ label, value }] : []);
    const dayText = (value: string) => formatDay(value as Day, "medium");
    const specs: Spec[] = [];
    const add = <S extends z.ZodObject, P extends Record<string, unknown>>(spec: {
      kind: CopilotActionKind;
      description: string;
      inputSchema: S;
      contract: z.ZodType;
      contractPath?: string;
      business?: boolean;
      prepare: (ctx: WorkspaceContext, input: z.output<S>, book: ProposalBook) => Promise<Omit<Prepared, "dependsOn" | "payload"> & { payload: P }>;
      apply: (ctx: WorkspaceContext, payload: P, meta: ApplyMeta) => Promise<Applied>;
    }) => specs.push(spec as unknown as Spec);

    add({
      kind: "record_transaction",
      contract: transactionInput,
      description:
        "Record money that moved: an expense, income, a transfer between the user's own accounts, a refund, a loan given or taken, a debt payment, an investment, an asset purchase or owner equity.",
      inputSchema: z.object({
        type: z.enum(TRANSACTION_TYPES).describe("expense, income, transfer, refund, adjustment, investment, asset_purchase, debt_payment, loan or equity"),
        amount: money,
        currency,
        account: z.string().nullish().describe("The account the money left or arrived in (bKash, Cash, BRAC Bank…); for transfers, the one it left"),
        toAccount: z.string().nullish().describe("Transfers only: the account it went to"),
        direction: z.enum(["in", "out"]).nullish().describe("For refund, adjustment, investment, debt_payment, loan and equity: in = money arrived"),
        date: day.nullish().describe("Defaults to today"),
        merchant: z.string().max(120).nullish().describe("Shop, payee, customer or employer"),
        category: z.string().nullish().describe("An existing category name, for expense, income and refund"),
        project: z.string().nullish().describe("Business workspaces: project name"),
        description: z.string().max(200).nullish(),
        notes: z.string().max(2000).nullish(),
        reference: z.string().max(120).nullish().describe("bKash TrxID, invoice number…"),
      }),
      prepare: async (ctx, input, book) => {
        const type = input.type as TransactionType;
        const rules = TYPE_RULES[type];
        const direction =
          type === "transfer"
            ? "out"
            : rules.directions.includes(input.direction ?? rules.defaultDirection)
              ? (input.direction ?? rules.defaultDirection)
              : rules.defaultDirection;
        const from = await this.account(ctx, input.account, book, type === "transfer" ? "account it left" : "account");
        const to = type === "transfer" ? await this.account(ctx, input.toAccount, book, "account it went to") : null;
        if (to && JSON.stringify(to.id) === JSON.stringify(from.id)) throw new Error("A transfer needs two different accounts");
        const code = this.currencyFor(ctx, input.currency, from.currency);
        const amount = toMinor(input.amount, code);
        const date = this.date(ctx, input.date);
        const usesCategory = type === "expense" || type === "income" || type === "refund";
        const categoryKind = type === "income" || (type === "refund" && direction === "out") ? "income" : "expense";
        const category = usesCategory ? await this.category(ctx, input.category, categoryKind, book) : null;
        const project = await this.project(ctx, input.project, book);
        const warnings: string[] = [];
        if (date > todayFor(ctx)) warnings.push(`Dated in the future (${dayText(date)})`);
        if (code !== from.currency) warnings.push(`In ${code}; the ${from.currency} amount charged to ${from.name} is converted at your saved rate`);
        if (usesCategory && !category) warnings.push("No category: it will be uncategorized");
        if (typeof from.id === "string") {
          const duplicates = await this.transactions.findDuplicates(ctx, {
            date,
            amount,
            currency: code,
            merchant: input.merchant ?? null,
            accountId: from.id,
            reference: input.reference ?? null,
          });
          const best = duplicates[0];
          if (best && best.score >= 0.6) {
            warnings.push(
              `Possibly already recorded: ${best.transaction.merchant ?? best.transaction.description ?? "a transaction"} ${formatMoney(best.transaction.amount, best.transaction.currency)} on ${dayText(best.transaction.date)}`,
            );
          }
        }
        const label = TYPE_LABELS[type];
        const where = type === "transfer" ? `${from.name} → ${to?.name}` : `${direction === "in" ? "into" : "from"} ${from.name}`;
        return {
          title: `Record ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label.toLowerCase()}`,
          summary: `${formatMoney(amount, code)}${input.merchant ? ` · ${input.merchant}` : ""} · ${where} · ${dayText(date)}`,
          details: [
            { label: "Amount", value: formatMoney(amount, code) },
            { label: type === "transfer" ? "From" : "Account", value: from.name },
            ...detail("To", to?.name),
            { label: "Date", value: dayText(date) },
            ...detail(type === "income" ? "From" : "Merchant", input.merchant),
            ...detail("Category", category?.name),
            ...detail("Project", project?.name),
            ...detail("Description", input.description),
            ...detail("Reference", input.reference),
            ...detail("Notes", input.notes),
          ],
          warnings,
          payload: {
            type,
            direction,
            status: "posted",
            accountId: from.id,
            toAccountId: to?.id ?? null,
            amount,
            currency: code,
            date,
            merchant: input.merchant ?? null,
            categoryId: category?.id ?? null,
            projectId: project?.id ?? null,
            description: input.description ?? null,
            notes: input.notes ?? null,
            reference: input.reference ?? null,
          },
        };
      },
      apply: async (ctx, payload, meta) => {
        const result = await this.transactions.create(ctx, payload as never, {
          // Chat entries are typed notes; MCP is the API. The action id makes a double confirm a no-op.
          source: meta.via === "mcp" ? "api" : "text",
          externalId: meta.via === "chat" ? meta.actionId : null,
          metadata: { origin: meta.via === "mcp" ? "mcp" : "copilot", actionId: meta.actionId },
        });
        const t = result.transaction;
        return { id: t.id, label: `${TYPE_LABELS[t.type]} ${formatMoney(t.amount, t.currency)}`, href: `/transactions?ids=${t.id}&open=${t.id}` };
      },
    });

    add({
      kind: "update_transaction",
      contract: transactionUpdate,
      contractPath: "changes",
      description:
        "Change an existing transaction: its category, merchant, notes, description, reference, project, date, amount or account. Find it first with search_transactions and pass its id.",
      inputSchema: z.object({
        transactionId: z.uuid().describe("The id from search_transactions"),
        amount: money.nullish(),
        currency,
        account: z.string().nullish(),
        date: day.nullish(),
        merchant: z.string().max(120).nullish(),
        category: z.string().nullish(),
        project: z.string().nullish(),
        description: z.string().max(200).nullish(),
        notes: z.string().max(2000).nullish(),
        reference: z.string().max(120).nullish(),
        reason: z.string().max(200).nullish().describe("Why it changed, kept in the history"),
      }),
      prepare: async (ctx, input, book) => {
        const before = await this.transactions.get(ctx, input.transactionId);
        if (before.status === "void") throw new Error("That transaction was voided and can't be changed");
        const changes: Record<string, unknown> = {};
        const details: Detail[] = [];
        const change = (label: string, from: string | null, to: string) => details.push({ label, value: `${from ?? "—"} → ${to}` });
        if (input.amount !== undefined && input.amount !== null) {
          const code = this.currencyFor(ctx, input.currency, before.currency);
          changes.amount = toMinor(input.amount, code);
          changes.currency = code;
          change("Amount", formatMoney(before.amount, before.currency), formatMoney(changes.amount as number, code));
        }
        if (input.account) {
          const account = await this.account(ctx, input.account, book);
          changes.accountId = account.id;
          change("Account", null, account.name);
        }
        if (input.date) {
          changes.date = this.date(ctx, input.date);
          change("Date", dayText(before.date), dayText(changes.date as string));
        }
        if (input.merchant !== undefined && input.merchant !== null) {
          changes.merchant = input.merchant;
          change("Merchant", before.merchant, input.merchant);
        }
        if (input.category) {
          const kind = before.type === "income" || (before.type === "refund" && before.direction === "out") ? "income" : "expense";
          const category = await this.category(ctx, input.category, kind, book);
          changes.categoryId = category?.id ?? null;
          change("Category", null, category?.name ?? "Uncategorized");
        }
        if (input.project) {
          const project = await this.project(ctx, input.project, book);
          changes.projectId = project?.id ?? null;
          change("Project", null, project?.name ?? "None");
        }
        for (const key of ["description", "notes", "reference"] as const) {
          const value = input[key];
          if (value !== undefined && value !== null) {
            changes[key] = value;
            change(key.charAt(0).toUpperCase() + key.slice(1), before[key], value);
          }
        }
        if (!details.length) throw new Error("Say what to change");
        if (input.reason) changes.reason = input.reason;
        return {
          title: "Change a transaction",
          summary: `${before.merchant ?? before.description ?? TYPE_LABELS[before.type]} ${formatMoney(before.amount, before.currency)} on ${dayText(before.date)}`,
          details,
          warnings: changes.amount !== undefined && before.status === "posted" ? ["Changes a posted amount: balances move"] : [],
          payload: { transactionId: before.id, changes },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.transactions.update(ctx, payload.transactionId as string, payload.changes as never);
        return { id: row.id, label: `${TYPE_LABELS[row.type]} ${formatMoney(row.amount, row.currency)}`, href: `/transactions?ids=${row.id}&open=${row.id}` };
      },
    });

    add({
      kind: "create_category",
      contract: categoryInput,
      description: "Create an expense or income category, optionally under a parent category.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(60),
        kind: z.enum(["expense", "income"]).nullish().describe("Defaults to expense"),
        parent: z.string().nullish().describe("An existing top-level category to nest it under"),
      }),
      prepare: async (ctx, input, book) => {
        const kind = input.kind ?? "expense";
        const existing = (await this.categories.list(ctx)).find((c) => c.kind === kind && normalizeName(c.name) === normalizeName(input.name));
        if (existing) throw new Error(`The ${kind} category "${existing.name}" already exists; use it.`);
        const parent = input.parent ? await this.category(ctx, input.parent, kind, book) : null;
        return {
          title: "Create a category",
          summary: `${parent ? `${parent.name} › ` : ""}${input.name} (${kind})`,
          details: [
            { label: "Name", value: input.name },
            { label: "Kind", value: kind === "income" ? "Income" : "Expense" },
            ...detail("Inside", parent?.name),
          ],
          warnings: [],
          payload: { name: input.name, kind, parentId: parent?.id ?? null },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.categories.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: "/settings/categories" };
      },
    });

    add({
      kind: "create_account",
      contract: accountInput,
      description: "Add a money account: a bank account, cash, a mobile wallet (bKash, Nagad, Rocket), a card, savings or a loan account.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80),
        kind: z
          .enum(ACCOUNT_KINDS)
          .describe("bank, cash, mobile_wallet, card, digital_wallet, payment_processor, savings, loan, other or crypto_wallet (digital currency)"),
        currency,
        openingBalance: z.number().nullish().describe("Major units; negative for money owed on a card or loan. Defaults to 0"),
        openingDate: day.nullish().describe("Defaults to today"),
        provider: z.string().max(60).nullish().describe("bkash, nagad, rocket, brac, city, stripe…"),
        institution: z.string().max(120).nullish(),
      }),
      prepare: async (ctx, input) => {
        const existing = (await this.accounts.list(ctx, { includeArchived: true })).find((a) => normalizeName(a.name) === normalizeName(input.name));
        if (existing) throw new Error(`An account called "${existing.name}" already exists.`);
        const code = this.currencyFor(ctx, input.currency);
        const opening = toMinor(input.openingBalance ?? 0, code);
        const openingDate = this.date(ctx, input.openingDate, "opening date");
        return {
          title: "Add an account",
          summary: `${input.name} · ${input.kind.replace(/_/g, " ")} · ${formatMoney(opening, code)} on ${dayText(openingDate)}`,
          details: [
            { label: "Name", value: input.name },
            { label: "Kind", value: input.kind.replace(/_/g, " ") },
            { label: "Opening balance", value: formatMoney(opening, code) },
            { label: "As of", value: dayText(openingDate) },
            ...detail("Provider", input.provider),
            ...detail("Institution", input.institution),
          ],
          warnings: [],
          payload: {
            name: input.name,
            kind: input.kind,
            currency: code,
            openingBalance: opening,
            openingDate,
            provider: input.provider ?? null,
            institution: input.institution ?? null,
          },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.accounts.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: `/accounts/${row.id}` };
      },
    });

    add({
      kind: "create_project",
      contract: projectInput,
      business: true,
      description: "Create a project (business workspaces) to track its revenue and costs.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80),
        code: z.string().trim().max(16).nullish(),
        description: z.string().max(2000).nullish(),
        budget: money.nullish().describe("Optional budget in the workspace currency"),
      }),
      prepare: async (ctx, input) => {
        const existing = (await this.projects.list(ctx, { includeArchived: true })).find((p) => normalizeName(p.name) === normalizeName(input.name));
        if (existing) throw new Error(`A project called "${existing.name}" already exists.`);
        const budget = input.budget ? toMinor(input.budget, ctx.baseCurrency) : null;
        return {
          title: "Create a project",
          summary: input.name,
          details: [
            { label: "Name", value: input.name },
            ...detail("Code", input.code),
            ...detail("Budget", budget ? formatMoney(budget, ctx.baseCurrency) : null),
          ],
          warnings: [],
          payload: { name: input.name, code: input.code ?? null, description: input.description ?? null, budgetAmount: budget },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.projects.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: `/business/projects/${row.id}` };
      },
    });

    add({
      kind: "create_subscription",
      contract: subscriptionInput,
      description: "Track a subscription (Netflix, ChatGPT, a domain, hosting…): its price, billing cycle and next renewal.",
      inputSchema: z.object({
        provider: z.string().trim().min(1).max(120).describe("Netflix, ChatGPT, Google One…"),
        planName: z.string().max(120).nullish(),
        amount: money,
        currency,
        billingCycle: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]),
        nextRenewalDate: day,
        startDate: day.nullish().describe("Defaults to today"),
        account: z.string().nullish().describe("The account it is paid from"),
        category: z.string().nullish(),
        autoRenew: z.boolean().nullish(),
        notes: z.string().max(2000).nullish(),
      }),
      prepare: async (ctx, input, book) => {
        const account = input.account ? await this.account(ctx, input.account, book) : null;
        const code = this.currencyFor(ctx, input.currency, account?.currency);
        const amount = toMinor(input.amount, code);
        const nextRenewalDate = this.date(ctx, input.nextRenewalDate, "next renewal date");
        const startDate = this.date(ctx, input.startDate, "start date");
        const category = await this.category(ctx, input.category, "expense", book);
        const cycle = { monthly: "month", quarterly: "quarter", half_yearly: "6 months", yearly: "year" }[input.billingCycle];
        return {
          title: "Track a subscription",
          summary: `${input.provider}${input.planName ? ` ${input.planName}` : ""} · ${formatMoney(amount, code)} a ${cycle} · renews ${dayText(nextRenewalDate)}`,
          details: [
            { label: "Provider", value: input.provider },
            ...detail("Plan", input.planName),
            { label: "Price", value: `${formatMoney(amount, code)} / ${cycle}` },
            { label: "Next renewal", value: dayText(nextRenewalDate) },
            ...detail("Paid from", account?.name),
            ...detail("Category", category?.name),
            { label: "Auto-renews", value: input.autoRenew === false ? "No" : "Yes" },
          ],
          warnings: [],
          payload: {
            provider: input.provider,
            planName: input.planName ?? null,
            amount,
            currency: code,
            billingCycle: input.billingCycle,
            intervalCount: 1,
            startDate,
            nextRenewalDate,
            autoRenew: input.autoRenew ?? true,
            accountId: account?.id ?? null,
            categoryId: category?.id ?? null,
            notes: input.notes ?? null,
          },
        };
      },
      apply: async (ctx, payload) => {
        const { subscription } = await this.subscriptions.create(ctx, payload as never);
        return { id: subscription.id, label: subscription.provider, href: `/subscriptions/${subscription.id}` };
      },
    });

    add({
      kind: "create_recurring",
      contract: commitmentInput,
      description: "Schedule a recurring bill or income that isn't a subscription: rent, utilities, internet, salary, tuition, insurance, an installment.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
        kind: z
          .enum(COMMITMENT_KINDS)
          .describe("rent, utility, salary, income, loan_payment, insurance, tax, education, software, hosting, domain, contractor, payroll or custom"),
        amount: money,
        currency,
        frequency: z.enum(["weekly", "monthly", "quarterly", "half_yearly", "yearly", "once"]),
        nextDueDate: day.describe("The next date it is due"),
        payee: z.string().max(120).nullish(),
        account: z.string().nullish(),
        category: z.string().nullish(),
        autoPay: z.boolean().nullish().describe("Paid automatically (standing order, auto-debit)"),
      }),
      prepare: async (ctx, input, book) => {
        const direction = input.kind === "salary" || input.kind === "income" ? "in" : "out";
        const account = input.account ? await this.account(ctx, input.account, book) : null;
        const code = this.currencyFor(ctx, input.currency, account?.currency);
        const amount = toMinor(input.amount, code);
        const due = this.date(ctx, input.nextDueDate, "next due date");
        const category = await this.category(ctx, input.category, direction === "in" ? "income" : "expense", book);
        return {
          title: direction === "in" ? "Schedule expected income" : "Schedule a recurring bill",
          summary: `${input.name} · ${formatMoney(amount, code)} ${input.frequency.replace("_", "-")} · next ${dayText(due)}`,
          details: [
            { label: "Name", value: input.name },
            { label: "Amount", value: formatMoney(amount, code) },
            { label: "Repeats", value: input.frequency.replace("_", "-") },
            { label: "Next due", value: dayText(due) },
            ...detail(direction === "in" ? "From" : "Payee", input.payee),
            ...detail(direction === "in" ? "Into" : "Paid from", account?.name),
            ...detail("Category", category?.name),
          ],
          warnings: [],
          payload: {
            kind: input.kind,
            direction,
            name: input.name,
            payee: input.payee ?? null,
            amount,
            currency: code,
            frequency: input.frequency,
            startDate: due,
            nextDueDate: due,
            accountId: account?.id ?? null,
            categoryId: category?.id ?? null,
            autoPay: input.autoPay ?? false,
          },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.commitments.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: `/commitments?focus=${row.id}` };
      },
    });

    add({
      kind: "create_budget",
      contract: budgetInput,
      description: "Set a spending budget for a category (or everything) per month, quarter or year.",
      inputSchema: z.object({
        amount: money,
        category: z.string().nullish().describe("Leave out for a budget on all spending"),
        project: z.string().nullish(),
        period: z.enum(["monthly", "quarterly", "yearly", "total"]).nullish().describe("Defaults to monthly"),
        name: z.string().max(80).nullish(),
        startDate: day.nullish().describe("Defaults to the first of this month"),
        alertAtPercent: z.number().int().min(1).max(200).nullish(),
      }),
      prepare: async (ctx, input, book) => {
        const category = await this.category(ctx, input.category, "expense", book);
        const project = await this.project(ctx, input.project, book);
        const amount = toMinor(input.amount, ctx.baseCurrency);
        const period = input.period ?? "monthly";
        const startDate = input.startDate ? this.date(ctx, input.startDate, "start date") : startOfMonth(todayFor(ctx));
        const name = input.name ?? `${category?.name ?? project?.name ?? "All spending"}`;
        return {
          title: "Set a budget",
          summary: `${name} · ${formatMoney(amount, ctx.baseCurrency)} ${period === "total" ? "in total" : period}`,
          details: [
            { label: "Name", value: name },
            { label: "Limit", value: formatMoney(amount, ctx.baseCurrency) },
            { label: "Period", value: period },
            ...detail("Category", category?.name),
            ...detail("Project", project?.name),
            { label: "Starts", value: dayText(startDate) },
          ],
          warnings: [],
          payload: {
            name,
            period,
            amount,
            categoryId: category?.id ?? null,
            projectId: project?.id ?? null,
            startDate,
            alertThreshold: input.alertAtPercent ?? 80,
          },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.budgets.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: `/budgets/${row.id}` };
      },
    });

    add({
      kind: "create_goal",
      contract: goalInput,
      description: "Set a savings goal or a dream purchase: target amount, optional date and monthly plan.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
        kind: z
          .enum(GOAL_KINDS)
          .nullish()
          .describe("savings, emergency_fund, asset_purchase, business_capital, travel, investment, education, dream_asset or custom"),
        targetAmount: money,
        currency,
        targetDate: day.nullish(),
        monthlyPlan: money.nullish(),
        alreadySaved: z.number().min(0).nullish(),
        linkedAccount: z.string().nullish().describe("A savings account whose balance is the progress"),
      }),
      prepare: async (ctx, input, book) => {
        const code = this.currencyFor(ctx, input.currency);
        const linked = input.linkedAccount ? await this.account(ctx, input.linkedAccount, book) : null;
        const target = toMinor(input.targetAmount, code);
        const targetDate = input.targetDate ? this.date(ctx, input.targetDate, "target date") : null;
        return {
          title: "Set a goal",
          summary: `${input.name} · ${formatMoney(target, code)}${targetDate ? ` by ${dayText(targetDate)}` : ""}`,
          details: [
            { label: "Goal", value: input.name },
            { label: "Target", value: formatMoney(target, code) },
            ...detail("By", targetDate ? dayText(targetDate) : null),
            ...detail("Monthly plan", input.monthlyPlan ? formatMoney(toMinor(input.monthlyPlan, code), code) : null),
            ...detail("Already saved", input.alreadySaved ? formatMoney(toMinor(input.alreadySaved, code), code) : null),
            ...detail("Tracks", linked?.name),
          ],
          warnings: [],
          payload: {
            kind: input.kind ?? "savings",
            name: input.name,
            targetAmount: target,
            currency: code,
            targetDate,
            monthlyPlan: input.monthlyPlan ? toMinor(input.monthlyPlan, code) : null,
            startingAmount: input.alreadySaved ? toMinor(input.alreadySaved, code) : 0,
            linkedAccountId: linked?.id ?? null,
          },
        };
      },
      apply: async (ctx, payload) => {
        const goal = await this.goals.create(ctx, payload as never);
        return { id: goal.id, label: goal.name, href: `/goals/${goal.id}` };
      },
    });

    add({
      kind: "create_rule",
      contract: ruleInput,
      description:
        "Teach the app a rule for future transactions: when the merchant or description matches, set the category (and/or project, account or type). Use when the user says what a merchant always is.",
      inputSchema: z.object({
        when: z
          .array(
            z.object({
              field: z.enum(["merchant", "description", "reference"]),
              operator: z.enum(["contains", "equals", "starts_with"]).nullish().describe("Defaults to contains"),
              value: z.string().trim().min(1).max(200),
            }),
          )
          .min(1)
          .max(5),
        category: z.string().nullish(),
        categoryKind: z.enum(["expense", "income"]).nullish(),
        project: z.string().nullish(),
        account: z.string().nullish(),
        type: z.enum(["expense", "income", "transfer", "refund", "investment", "asset_purchase", "debt_payment"]).nullish(),
        name: z.string().max(80).nullish(),
      }),
      prepare: async (ctx, input, book) => {
        const category = await this.category(ctx, input.category, input.categoryKind ?? (input.type === "income" ? "income" : "expense"), book);
        const project = await this.project(ctx, input.project, book);
        const account = input.account ? await this.account(ctx, input.account, book) : null;
        if (!category && !project && !account && !input.type) throw new Error("Say what the rule should set: a category, project, account or type");
        const conditions = input.when.map((c) => ({ field: c.field, operator: c.operator ?? "contains", value: c.value }));
        const when = conditions.map((c) => `${c.field} ${c.operator.replace("_", " ")} "${c.value}"`).join(" and ");
        const then = [
          category && `category ${category.name}`,
          project && `project ${project.name}`,
          account && `account ${account.name}`,
          input.type && `type ${input.type}`,
        ]
          .filter(Boolean)
          .join(", ");
        const name = input.name ?? `${conditions[0]?.value} → ${category?.name ?? project?.name ?? account?.name ?? input.type}`;
        return {
          title: "Add a rule",
          summary: `When ${when}, set ${then}`,
          details: [
            { label: "When", value: when },
            { label: "Set", value: then },
          ],
          warnings: ["Applies to transactions recorded from now on"],
          payload: {
            name: name.slice(0, 80),
            match: "all",
            conditions,
            actions: {
              ...(category ? { categoryId: category.id } : {}),
              ...(project ? { projectId: project.id } : {}),
              ...(account ? { accountId: account.id } : {}),
              ...(input.type ? { type: input.type } : {}),
            },
          },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.rules.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: "/settings/rules" };
      },
    });

    add({
      kind: "create_receivable",
      contract: receivableInput,
      description: "Record money someone owes the user: a loan given to a person, or an unpaid invoice to a customer.",
      inputSchema: z.object({
        who: z.string().trim().min(1).max(120).describe("The person or customer who owes it"),
        amount: money,
        currency,
        kind: z.enum(["loan", "invoice", "other"]).nullish().describe("loan (money lent), invoice or other. Defaults to loan"),
        title: z.string().max(160).nullish(),
        issueDate: day.nullish().describe("Defaults to today"),
        dueDate: day.nullish(),
        lentFrom: z.string().nullish().describe("Loans: the account the money left, to record it leaving"),
        reference: z.string().max(120).nullish(),
        notes: z.string().max(2000).nullish(),
      }),
      prepare: async (ctx, input, book) => {
        const kind = input.kind ?? "loan";
        const from = input.lentFrom && kind === "loan" ? await this.account(ctx, input.lentFrom, book) : null;
        const code = this.currencyFor(ctx, input.currency, from?.currency);
        const amount = toMinor(input.amount, code);
        const issueDate = this.date(ctx, input.issueDate, "issue date");
        const dueDate = input.dueDate ? this.date(ctx, input.dueDate, "due date") : null;
        const title = input.title ?? (kind === "loan" ? `Loan to ${input.who}` : `Invoice to ${input.who}`);
        return {
          title: kind === "invoice" ? "Record an unpaid invoice" : "Record money owed to you",
          summary: `${input.who} owes ${formatMoney(amount, code)}${dueDate ? ` · due ${dayText(dueDate)}` : ""}`,
          details: [
            { label: "Who", value: input.who },
            { label: "Amount", value: formatMoney(amount, code) },
            { label: "Since", value: dayText(issueDate) },
            ...detail("Due", dueDate ? dayText(dueDate) : null),
            ...detail("Lent from", from?.name),
            ...detail("Reference", input.reference),
          ],
          warnings: from ? [] : kind === "loan" ? ["The money leaving an account isn't recorded; say which account to include it"] : [],
          payload: {
            kind,
            counterpartyName: input.who,
            title,
            reference: input.reference ?? null,
            amount,
            currency: code,
            issueDate,
            dueDate,
            notes: input.notes ?? null,
            lentFromAccountId: from?.id ?? null,
          },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.receivables.create(ctx, payload as never);
        return { id: row.id, label: row.title, href: `/wealth/receivables/${row.id}` };
      },
    });

    add({
      kind: "create_liability",
      contract: liabilityInput,
      description: "Record money the user owes: a personal debt, a bank loan, a credit balance or an unpaid bill.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120).describe("Loan from Karim, BRAC car loan…"),
        lender: z.string().max(120).nullish().describe("Who is owed"),
        kind: z.enum(LIABILITY_KINDS).nullish().describe("personal_debt, loan, credit, business_debt, payable, mortgage or other. Defaults to personal_debt"),
        principal: money.describe("The amount borrowed"),
        outstanding: z.number().min(0).nullish().describe("Still owed now; defaults to the principal"),
        currency,
        interestRatePercent: z.number().min(0).max(100).nullish(),
        startDate: day.nullish(),
        dueDate: day.nullish(),
        receivedInto: z.string().nullish().describe("The account the borrowed money arrived in, to record it"),
      }),
      prepare: async (ctx, input, book) => {
        const into = input.receivedInto ? await this.account(ctx, input.receivedInto, book) : null;
        const code = this.currencyFor(ctx, input.currency, into?.currency);
        const principal = toMinor(input.principal, code);
        const outstanding = input.outstanding !== undefined && input.outstanding !== null ? toMinor(input.outstanding, code) : principal;
        const dueDate = input.dueDate ? this.date(ctx, input.dueDate, "due date") : null;
        return {
          title: "Record money you owe",
          summary: `${input.name} · ${formatMoney(outstanding, code)} owed${dueDate ? ` · due ${dayText(dueDate)}` : ""}`,
          details: [
            { label: "Name", value: input.name },
            ...detail("Owed to", input.lender),
            { label: "Borrowed", value: formatMoney(principal, code) },
            { label: "Still owed", value: formatMoney(outstanding, code) },
            ...detail("Interest", input.interestRatePercent ? `${input.interestRatePercent}%` : null),
            ...detail("Due", dueDate ? dayText(dueDate) : null),
            ...detail("Received into", into?.name),
          ],
          warnings: [],
          payload: {
            kind: input.kind ?? "personal_debt",
            name: input.name,
            counterpartyName: input.lender ?? null,
            principal,
            currency: code,
            openingOutstanding: outstanding,
            interestRate: input.interestRatePercent !== undefined && input.interestRatePercent !== null ? String(input.interestRatePercent) : null,
            startDate: input.startDate ? this.date(ctx, input.startDate, "start date") : null,
            dueDate,
            receivedIntoAccountId: into?.id ?? null,
          },
        };
      },
      apply: async (ctx, payload) => {
        const row = await this.liabilities.create(ctx, payload as never);
        return { id: row.id, label: row.name, href: `/wealth/liabilities/${row.id}` };
      },
    });

    return specs;
  }
}

function missingRef(actionId: string): string {
  throw new Error(`This needs another suggestion (${actionId}) to be confirmed first`);
}
