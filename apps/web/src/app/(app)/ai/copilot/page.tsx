import { PageShell } from "@/components/app/page-shell";
import { CopilotView } from "@/components/copilot/copilot-view";
import type { CopilotThreadDetail, CopilotThreadList } from "@/components/copilot/types";
import { api, apiOrNull } from "@/lib/api/server";

export const metadata = { title: "Copilot" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CopilotPage({ searchParams }: { searchParams: Promise<{ thread?: string; q?: string }> }) {
  const { thread, q } = await searchParams;
  const [list, current] = await Promise.all([
    api<CopilotThreadList>("/copilot/threads"),
    thread && UUID.test(thread) ? apiOrNull<CopilotThreadDetail>(`/copilot/threads/${thread}`) : Promise.resolve(null),
  ]);
  return (
    <PageShell title="Copilot" width="wide">
      <CopilotView key={current?.thread.id ?? `new:${q ?? ""}`} list={list} current={current} initialQuestion={current ? undefined : q?.slice(0, 2000)} />
    </PageShell>
  );
}
