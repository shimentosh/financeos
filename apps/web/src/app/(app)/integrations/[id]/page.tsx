import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConnectionDetailView, type DetailTab } from "@/components/integrations/connection-detail";
import { api, apiOrNull } from "@/lib/api/server";
import { fromSearchParams } from "@/lib/api/shared";
import type { Account, CurrentWorkspace, Project } from "@/lib/api/types";
import type { CatalogEntry, ConnectionDetail } from "@/lib/api/types/integrations";

export const metadata: Metadata = { title: "Connection" };

const TABS: DetailTab[] = ["overview", "records", "runs", "events"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = fromSearchParams(await searchParams);
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const [detail, catalog, accounts, projects] = await Promise.all([
    apiOrNull<ConnectionDetail>(`/integrations/${id}`),
    api<CatalogEntry[]>("/integrations/catalog"),
    api<Account[]>("/accounts"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
  ]);
  if (!detail) notFound();
  const tab = TABS.includes(query.tab as DetailTab) ? (query.tab as DetailTab) : query.run ? "runs" : "overview";
  return (
    <ConnectionDetailView
      detail={detail}
      entry={catalog.find((entry) => entry.provider === detail.provider) ?? null}
      accounts={accounts}
      projects={projects}
      initialTab={tab}
      initialRun={query.run && UUID.test(query.run) ? query.run : null}
      initialStatus={query.status ?? null}
    />
  );
}
