import "server-only";
import { today } from "@financeos/core";
import { api } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { Account, Category, CurrentWorkspace, Project, TransactionPage } from "@/lib/api/types";
import { apiQuery, rangeFor, readFilters, type TypeTab } from "./filters";

export async function loadTransactions(searchParams: Promise<Record<string, string | string[] | undefined>>, preset?: { tab?: TypeTab; types?: string }) {
  const params = fromSearchParams(await searchParams);
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const filters = readFilters(params, { tab: preset?.tab });
  if (preset?.tab) filters.tab = preset.tab;
  const range = rangeFor(filters, today(workspace.timezone), workspace.fiscalYearStartMonth);
  const [page, accounts, categories, projects] = await Promise.all([
    api<TransactionPage>("/transactions", { query: apiQuery(filters, range, preset?.types ?? params.type) }),
    api<Account[]>("/accounts"),
    api<Category[]>("/categories"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
  ]);
  return { page, filters, range, accounts, categories, projects, workspace };
}
