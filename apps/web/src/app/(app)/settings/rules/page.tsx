import { RuleSettings } from "@/components/settings/catalog-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { api } from "@/lib/api/server";
import type { Account, Category, CurrentWorkspace, Project, Rule } from "@/lib/api/types";

export const metadata = { title: "Rules" };

export default async function Page() {
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const [rules, categories, accounts, projects] = await Promise.all([
    api<Rule[]>("/rules"),
    api<Category[]>("/categories"),
    api<Account[]>("/accounts"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
  ]);
  return (
    <SettingsPage title="Rules" description="Categorise, route and flag transactions automatically — before any AI is involved.">
      <RuleSettings rules={rules} categories={categories} projects={projects} accounts={accounts} />
    </SettingsPage>
  );
}
