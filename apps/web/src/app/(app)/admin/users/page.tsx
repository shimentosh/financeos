import { AdminPage } from "@/components/admin/admin-page";
import { AdminUsersView } from "@/components/admin/admin-views";
import { api } from "@/lib/api/server";
import type { Me } from "@/lib/api/types";

export const metadata = { title: "Users · Admin" };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { q, page } = await searchParams;
  const [me, data] = await Promise.all([
    api<Me>("/me"),
    api<Parameters<typeof AdminUsersView>[0]["page"]>("/admin/users", { query: { q, page: page ?? 1, pageSize: 50 } }),
  ]);
  return (
    <AdminPage title="Users" description="Suspend, restore, change roles and sign users out. Every change is audited.">
      <AdminUsersView page={data} currentUserId={me.user.id} />
    </AdminPage>
  );
}
