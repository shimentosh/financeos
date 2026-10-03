import { AdminPage } from "@/components/admin/admin-page";
import { type AdminOverview, AdminOverviewView } from "@/components/admin/admin-views";
import { type AdminSystem, SystemStatus } from "@/components/admin/system-status";
import { api } from "@/lib/api/server";

export const metadata = { title: "Admin" };

export default async function Page() {
  const [data, system] = await Promise.all([api<AdminOverview>("/admin/overview"), api<AdminSystem>("/admin/system").catch(() => null)]);
  return (
    <AdminPage title="Platform" description="This FinanceOS instance as a whole. No workspace's financial records are shown here.">
      {system && <SystemStatus data={system} />}
      <AdminOverviewView data={data} />
    </AdminPage>
  );
}
