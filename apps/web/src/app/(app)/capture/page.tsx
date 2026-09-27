import type { Metadata } from "next";
import { type CaptureMode, CaptureView } from "@/components/ai/capture-view";
import { PageShell } from "@/components/app/page-shell";
import { api } from "@/lib/api/server";
import type { AiStatusView, CapturePage } from "@/lib/api/types/ai";

export const metadata: Metadata = { title: "Capture" };

const MODES: CaptureMode[] = ["screenshot", "receipt", "text", "voice"];

export default async function CapturePageRoute({ searchParams }: { searchParams: Promise<{ mode?: string; text?: string }> }) {
  const params = await searchParams;
  const mode = MODES.includes(params.mode as CaptureMode) ? (params.mode as CaptureMode) : params.text ? "text" : "screenshot";
  const [status, recent] = await Promise.all([
    api<AiStatusView>("/ai/status").catch(() => null),
    api<CapturePage>("/captures", { query: { pageSize: 10 } }).catch(() => null),
  ]);
  return (
    <PageShell title="Capture" className="max-w-3xl">
      <CaptureView initialMode={mode} initialText={params.text?.slice(0, 4000) ?? null} status={status} recent={recent?.items ?? []} />
    </PageShell>
  );
}
