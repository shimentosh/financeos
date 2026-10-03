import { type CopilotFact, type CopilotSource, type Day, isDay, type Range, TRANSACTION_TYPES } from "@financeos/core";
import { z } from "zod";
import type { WorkspaceContext } from "../../common/context.js";
import type { ToolDefinition } from "../ai/gateway/types.js";
import type { CopilotQueries, QueryResult } from "./copilot.queries.js";

const day = z.string().describe("A date as YYYY-MM-DD");
const period = { from: day, to: day };

/** What the tools produced during one answer: the figures and links to show beside it. */
export class Evidence {
  readonly facts: CopilotFact[] = [];
  readonly sources: CopilotSource[] = [];

  add(result: QueryResult) {
    for (const fact of result.facts) if (this.facts.length < 8) this.facts.push(fact);
    for (const source of result.sources) {
      if (this.sources.length < 8 && !this.sources.some((s) => s.href === source.href)) this.sources.push(source);
    }
  }
}

/** Keeps each tool's input typed by its own schema inside the shared list. */
const defineTool = <S extends z.ZodObject>(tool: ToolDefinition<S>) => tool as unknown as ToolDefinition;

function range(input: { from: string; to: string }): Range {
  if (!isDay(input.from) || !isDay(input.to)) throw new Error("from and to must be dates as YYYY-MM-DD");
  return input.from <= input.to ? { from: input.from as Day, to: input.to as Day } : { from: input.to as Day, to: input.from as Day };
}

/**
 * The model's tools: each wraps one read-only query, validates its input
 * with Zod (the gateway rejects anything else before `run`), and records the
 * figures and links it returned so the answer can cite them. Money inputs
 * are in major units ("5000" taka), which is how people and models speak.
 */
export function copilotTools(queries: CopilotQueries, ctx: WorkspaceContext, evidence: Evidence): ToolDefinition[] {
  const run = async (promise: Promise<QueryResult>) => {
    const result = await promise;
    evidence.add(result);
    return result.data;
  };
  const category = async (name: string | null | undefined, kind: "expense" | "income" = "expense") => {
    if (!name) return null;
    const found = await queries.findCategory(ctx, name, name, kind);
    if (!found) throw new Error(`No ${kind} category called "${name}". Call get_category_breakdown to see the category names.`);
    return found;
  };
  const project = async (name: string | null | undefined) => {
    if (!name) return null;
    const found = await queries.findProject(ctx, name);
    if (!found) throw new Error(`No project called "${name}".`);
    return found;
  };
  const payee = async (name: string | null | undefined) => {
    if (!name) return null;
    return (await queries.findCounterparty(ctx, name)) ?? { id: undefined, name };
  };
  const toMinor = (major: number | null | undefined) => (major === null || major === undefined ? undefined : Math.round(major * 100));

  const tools: ToolDefinition[] = [
    defineTool({
      name: "get_summary",
      description:
        "Income, spending and net for a period (optionally one project). Transfers, loans, debt payments, investments, asset purchases and equity are excluded by definition.",
      inputSchema: z.object({ ...period, project: z.string().nullish().describe("Project name, business workspaces only") }),
      run: async (input) => {
        const p = await project(input.project);
        return run(queries.summary(ctx, range(input), { projectId: p?.id, projectName: p?.name }));
      },
    }),
    defineTool({
      name: "get_spending",
      description:
        "Total spending (expenses less refunds) or income for a period, optionally narrowed to one category (subcategories included), one payee/merchant or one project; with the largest transactions.",
      inputSchema: z.object({
        ...period,
        kind: z.enum(["expense", "income"]).nullish(),
        category: z.string().nullish().describe("Category name, e.g. Groceries"),
        payee: z.string().nullish().describe("Merchant, payee or customer name"),
        project: z.string().nullish(),
      }),
      run: async (input) => {
        const kind = input.kind ?? "expense";
        const [c, p, who] = await Promise.all([category(input.category, kind), project(input.project), payee(input.payee)]);
        if (who && !who.id) {
          return run(
            queries.searchTransactions(ctx, {
              ...range(input),
              q: who.name,
              types: kind === "expense" ? ["expense", "refund"] : ["income", "refund"],
              categoryId: c?.id,
              projectId: p?.id,
            }),
          );
        }
        return run(
          queries.spending(ctx, range(input), {
            kind,
            categoryId: c?.id,
            categoryName: c?.name,
            counterpartyId: who?.id,
            counterpartyName: who?.name,
            projectId: p?.id,
            projectName: p?.name,
          }),
        );
      },
    }),
    defineTool({
      name: "get_category_breakdown",
      description: "Spending (or income) by top-level category for a period, largest first, with each category's share.",
      inputSchema: z.object({ ...period, kind: z.enum(["expense", "income"]).nullish() }),
      run: (input) => run(queries.categoryBreakdown(ctx, range(input), input.kind ?? "expense")),
    }),
    defineTool({
      name: "get_top_payees",
      description: "The merchants/payees paid the most (or customers who paid the most, kind=income) in a period.",
      inputSchema: z.object({ ...period, kind: z.enum(["expense", "income"]).nullish() }),
      run: (input) => run(queries.merchantBreakdown(ctx, range(input), input.kind ?? "expense")),
    }),
    defineTool({
      name: "compare_periods",
      description: "Income, spending and net for a period against another period (by default the equally long period just before).",
      inputSchema: z.object({ ...period, previousFrom: day.nullish(), previousTo: day.nullish() }),
      run: (input) =>
        run(queries.compare(ctx, range(input), input.previousFrom && input.previousTo ? range({ from: input.previousFrom, to: input.previousTo }) : undefined)),
    }),
    defineTool({
      name: "get_balances",
      description: "Today's balance of every account and the total cash on hand across bank, cash and wallet accounts.",
      inputSchema: z.object({}),
      run: () => run(queries.balances(ctx)),
    }),
    defineTool({
      name: "get_net_worth",
      description: "Net worth today (accounts, assets, investments, receivables minus liabilities), change since last month, and any completeness warnings.",
      inputSchema: z.object({}),
      run: () => run(queries.netWorth(ctx)),
    }),
    defineTool({
      name: "get_upcoming_payments",
      description: "Bills, subscription renewals, rent, installments and expected income due in the next N days, including overdue payments not yet recorded.",
      inputSchema: z.object({ days: z.number().int().describe("1 to 366") }),
      run: (input) => run(queries.upcoming(ctx, input.days)),
    }),
    defineTool({
      name: "get_subscriptions",
      description: "Active subscriptions with monthly and yearly cost, next renewal and auto-renew.",
      inputSchema: z.object({}),
      run: () => run(queries.subscriptions(ctx)),
    }),
    defineTool({
      name: "get_budgets",
      description: "Budgets in effect with spent, remaining, percent used, status and projected end-of-period spending.",
      inputSchema: z.object({}),
      run: () => run(queries.budgets(ctx)),
    }),
    defineTool({
      name: "get_cash_forecast",
      description: "Projected cash balance for the next N days from scheduled payments and typical spending. Always an estimate.",
      inputSchema: z.object({ days: z.number().int().describe("7 to 180") }),
      run: (input) => run(queries.forecast(ctx, input.days)),
    }),
    defineTool({
      name: "get_receivables",
      description: "Money owed to the user (loans given, unpaid invoices), with overdue items.",
      inputSchema: z.object({}),
      run: () => run(queries.receivables(ctx)),
    }),
    defineTool({
      name: "get_liabilities",
      description: "Money the user owes (loans, cards, payables, personal debts), by kind, with due dates.",
      inputSchema: z.object({}),
      run: () => run(queries.liabilities(ctx)),
    }),
    defineTool({
      name: "get_goals",
      description: "Active savings goals and dream purchases: target, saved, progress, monthly amount needed, on-track status.",
      inputSchema: z.object({}),
      run: () => run(queries.goals(ctx)),
    }),
    defineTool({
      name: "search_transactions",
      description:
        "Find individual transactions by text (merchant, description, reference), type, category, project or amount (major units). Defaults to the last 90 days.",
      inputSchema: z.object({
        from: day.nullish(),
        to: day.nullish(),
        text: z.string().nullish(),
        types: z.array(z.enum(TRANSACTION_TYPES)).nullish(),
        category: z.string().nullish(),
        project: z.string().nullish(),
        minAmount: z.number().nullish().describe("Major units, e.g. 5000 for ৳5,000"),
        maxAmount: z.number().nullish(),
        sort: z.enum(["date_desc", "amount_desc"]).nullish(),
        limit: z.number().int().nullish().describe("At most 25"),
      }),
      run: async (input) => {
        const [c, p] = await Promise.all([category(input.category), project(input.project)]);
        const from = input.from && isDay(input.from) ? (input.from as Day) : undefined;
        const to = input.to && isDay(input.to) ? (input.to as Day) : undefined;
        return run(
          queries.searchTransactions(ctx, {
            from,
            to,
            q: input.text ?? undefined,
            types: input.types ?? undefined,
            categoryId: c?.id,
            projectId: p?.id,
            minAmount: toMinor(input.minAmount),
            maxAmount: toMinor(input.maxAmount),
            sort: input.sort ?? undefined,
            limit: input.limit ?? undefined,
          }),
        );
      },
    }),
  ];

  if (ctx.workspaceKind === "business") {
    tools.push(
      defineTool({
        name: "get_projects",
        description: "Per-project revenue, cost, net contribution, margin, monthly burn, budget use and runway (estimate) for a period.",
        inputSchema: z.object({ ...period, project: z.string().nullish() }),
        run: async (input) => {
          const p = await project(input.project);
          return run(queries.projectsOverview(ctx, range(input), p?.id));
        },
      }),
    );
  }
  return tools;
}
