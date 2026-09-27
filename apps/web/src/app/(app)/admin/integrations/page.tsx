import { AdminPage } from "@/components/admin/admin-page";
import { AdminIntegrationsView } from "@/components/admin/admin-views";
import { api } from "@/lib/api/server";

export const metadata = { title: "Integrations · Admin" };

export default async function Page() {
  const data = await api<Parameters<typeof AdminIntegrationsView>[0]["data"]>("/admin/integrations");
  return (
    <AdminPage title="Integrations" description="Health of every connected source across workspaces.">
      <AdminIntegrationsView data={data} />
    </AdminPage>
  );
}
