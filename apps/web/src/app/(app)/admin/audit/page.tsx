import { AdminPage } from "@/components/admin/admin-page";
import { AdminAuditView } from "@/components/admin/admin-views";
import { type PlatformAuditRow, PlatformAuditSection } from "@/components/admin/platform-audit";
import { api } from "@/lib/api/server";

export const metadata = { title: "Audit · Admin" };

export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string; action?: string }> }) {
  const { page, action } = await searchParams;
  const [data, platform] = await Promise.all([
    api<Parameters<typeof AdminAuditView>[0]["data"]>("/admin/audit", { query: { page: page ?? 1, pageSize: 100, action } }),
    api<{ items: PlatformAuditRow[] }>("/admin/platform-audit", { query: { page: 1, pageSize: 50 } }),
  ]);
  return (
    <AdminPage
      title="Audit"
      description="Actions on the installation, then recent changes inside workspaces (action names only; details stay in each workspace)."
    >
      <PlatformAuditSection items={platform.items} />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Workspace changes</h2>
        <AdminAuditView data={data} />
      </section>
    </AdminPage>
  );
}
