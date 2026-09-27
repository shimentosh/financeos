import type { Metadata } from "next";
import { PageShell } from "@/components/app/page-shell";
import { ApiView } from "@/components/integrations/api-view";
import { api } from "@/lib/api/server";
import type { CurrentWorkspace } from "@/lib/api/types";
import type { ApiKey, Connection } from "@/lib/api/types/integrations";

export const metadata: Metadata = { title: "API & webhooks" };

export default async function ApiPage() {
  const workspace = await api<CurrentWorkspace>("/workspaces/current");
  const manage = workspace.role === "owner" || workspace.role === "admin";
  const [keys, connections] = await Promise.all([manage ? api<ApiKey[]>("/api-keys") : Promise.resolve(null), api<Connection[]>("/integrations")]);
  return (
    <PageShell frame="settings" title="API & webhooks" crumbs={[{ label: "Integrations", href: "/integrations" }]} width="wide">
      <ApiView keys={keys} customWebhooks={connections.filter((c) => c.provider === "generic_webhook" && c.status !== "disconnected")} />
    </PageShell>
  );
}
