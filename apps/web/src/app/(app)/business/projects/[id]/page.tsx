import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { presetFrom } from "@/components/business/presets";
import { ProjectProfileView } from "@/components/business/project-profile";
import { api, apiOrNull } from "@/lib/api/server";
import type { Project } from "@/lib/api/types";
import type { ProjectProfile } from "@/lib/api/types/business";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preset?: string }> }) {
  const [{ id }, { preset: raw }] = await Promise.all([params, searchParams]);
  const preset = presetFrom(raw, "all_time");
  const [profile, projects] = await Promise.all([
    apiOrNull<ProjectProfile>(`/projects/${id}/finance`, { query: { preset } }),
    api<Project[]>("/projects", { query: { includeArchived: true } }),
  ]);
  if (!profile) notFound();
  return (
    <PageShell
      title={profile.project.name}
      crumbs={[{ label: "Business" }, { label: "Projects", href: "/business/projects" }]}
      backHref="/business/projects"
      width="wide"
    >
      <ProjectProfileView profile={profile} project={projects.find((p) => p.id === id) ?? null} preset={preset} />
    </PageShell>
  );
}
