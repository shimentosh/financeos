import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { ConnectionsView } from "@/components/integrations/connections-view";
import { api } from "@/lib/api/server";
import type { Account, CurrentWorkspace, Project } from "@/lib/api/types";
import type { CatalogEntry, Connection } from "@/lib/api/types/integrations";

export const metadata: Metadata = { title: "Connected apps" };

export default async function IntegrationsPage() {
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const [connections, catalog, accounts, projects] = await Promise.all([
    api<Connection[]>("/integrations"),
    api<CatalogEntry[]>("/integrations/catalog"),
    api<Account[]>("/accounts"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
  ]);
  return (
    <PageShell frame="settings" title="Connected apps">
      <ConnectionsView connections={connections} catalog={catalog} accounts={accounts} projects={projects} />
    </PageShell>
  );
}
