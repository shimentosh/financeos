import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app/page-shell";
import { presetFrom } from "@/components/business/presets";
import { ProjectProfileView, type ProjectTab } from "@/components/business/project-profile";
import { api, apiOrNull } from "@/lib/api/server";
import type { Project } from "@/lib/api/types";
import type { EmployeeList, ProjectProfile } from "@/lib/api/types/business";

const TABS: ProjectTab[] = ["overview", "revenue", "cost", "payroll"];

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ preset?: string; tab?: string }>;
}) {
  const [{ id }, { preset: raw, tab: rawTab }] = await Promise.all([params, searchParams]);
  const preset = presetFrom(raw, "all_time");
  const tab: ProjectTab = TABS.find((t) => t === rawTab) ?? "overview";
  const [profile, projects, employees] = await Promise.all([
    apiOrNull<ProjectProfile>(`/projects/${id}/finance`, { query: { preset } }),
    api<Project[]>("/projects", { query: { includeArchived: true } }),
    tab === "payroll" ? apiOrNull<EmployeeList>("/payroll/employees", { query: { projectId: id } }) : null,
  ]);
  if (!profile) notFound();
  return (
    <PageShell
      title={profile.project.name}
      crumbs={[{ label: "Business" }, { label: "Projects", href: "/business/projects" }]}
      backHref="/business/projects"
      width="wide"
    >
      <ProjectProfileView profile={profile} project={projects.find((p) => p.id === id) ?? null} preset={preset} tab={tab} employees={employees} />
    </PageShell>
  );
}
