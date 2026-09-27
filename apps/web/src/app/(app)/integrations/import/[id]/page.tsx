import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { ImportWizard } from "@/components/integrations/import-wizard";
import { api, apiOrNull } from "@/lib/api/server";
import type { Account, Category, CurrentWorkspace, Project } from "@/lib/api/types";
import type { ImportDetail } from "@/lib/api/types/integrations";

export const metadata: Metadata = { title: "Import" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const [detail, accounts, categories, projects] = await Promise.all([
    apiOrNull<ImportDetail>(`/imports/${id}`),
    api<Account[]>("/accounts"),
    api<Category[]>("/categories"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
  ]);
  if (!detail) notFound();
  return (
    <PageShell
      frame="settings"
      title={detail.batch.filename}
      crumbs={[
        { label: "Integrations", href: "/integrations" },
        { label: "Import", href: "/integrations/import" },
      ]}
      backHref="/integrations/import"
      width="wide"
    >
      <ImportWizard key={detail.batch.id} initial={detail} accounts={accounts} categories={categories} projects={projects} />
    </PageShell>
  );
}
