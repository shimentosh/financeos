import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { presetFrom } from "@/components/business/presets";
import { NewProjectButton, ProjectsView } from "@/components/business/projects";
import { api } from "@/lib/api/server";
import type { ProjectOverview } from "@/lib/api/types/business";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ preset?: string }> }) {
  const { preset: raw } = await searchParams;
  const preset = presetFrom(raw, "all_time");
  const overview = await api<ProjectOverview>("/projects/finance", {
    query: { preset },
  });
  return (
    <PageShell title="Projects" crumbs={[{ label: "Business" }]} actions={<NewProjectButton />} width="wide">
      <ProjectsView overview={overview} preset={preset} />
    </PageShell>
  );
}
