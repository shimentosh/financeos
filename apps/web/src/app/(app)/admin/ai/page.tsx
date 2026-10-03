import type { AiConfigView } from "@financeos/core";
import { AdminPage } from "@/components/admin/admin-page";
import { AdminAiView } from "@/components/admin/admin-views";
import { AiProviderSettings } from "@/components/admin/ai-provider-settings";
import { api } from "@/lib/api/server";

export const metadata = { title: "AI · Admin" };

export default async function Page() {
  const [config, usage] = await Promise.all([
    api<AiConfigView>("/admin/ai-config"),
    api<Parameters<typeof AdminAiView>[0]["data"]>("/admin/ai-usage", { query: { days: 30 } }),
  ]);
  return (
    <AdminPage
      title="AI"
      description="The AI provider for the whole installation — DeepSeek, OpenAI, Gemini, Claude, a local model — and what every call costs."
    >
      <AiProviderSettings view={config} />
      <AdminAiView data={usage} />
    </AdminPage>
  );
}
