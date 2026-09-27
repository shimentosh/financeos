import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaptureReview } from "@/components/ai/capture-review";
import { PageShell } from "@/components/app/page-shell";
import { api, apiOrNull } from "@/lib/api/server";
import type { Account, Category, CurrentWorkspace, Project } from "@/lib/api/types";
import type { CaptureView } from "@/lib/api/types/ai";

export const metadata: Metadata = { title: "Review capture" };

export default async function CaptureReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [view, workspace] = await Promise.all([apiOrNull<CaptureView>(`/captures/${id}`), api<CurrentWorkspace>("/workspaces/current")]);
  if (!view) notFound();
  const [accounts, categories, projects] = await Promise.all([
    api<Account[]>("/accounts"),
    api<Category[]>("/categories"),
    workspace.kind === "business" ? api<Project[]>("/projects") : Promise.resolve([] as Project[]),
  ]);
  const back = from === "inbox" ? { label: "AI Inbox", href: "/ai/inbox" } : { label: "Capture", href: "/capture" };
  return (
    <PageShell title="Review" crumbs={[back]} backHref={back.href} width="wide">
      <CaptureReview initial={view} accounts={accounts} categories={categories} projects={projects} from={from ?? null} />
    </PageShell>
  );
}
