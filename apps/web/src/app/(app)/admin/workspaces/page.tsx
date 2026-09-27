import { AdminPage } from "@/components/admin/admin-page";
import { AdminWorkspacesView } from "@/components/admin/admin-views";
import { api } from "@/lib/api/server";

export const metadata = { title: "Workspaces · Admin" };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { q, page } = await searchParams;
  const data = await api<Parameters<typeof AdminWorkspacesView>[0]["page"]>("/admin/workspaces", { query: { q, page: page ?? 1, pageSize: 50 } });
  return (
    <AdminPage title="Workspaces" description="Sizes and usage per workspace.">
      <AdminWorkspacesView page={data} />
    </AdminPage>
  );
}
