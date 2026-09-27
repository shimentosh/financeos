import type { SupportStatus } from "@expensewise/core";
import { AdminPage } from "@/components/admin/admin-page";
import { type SupportList, SupportRequests } from "@/components/admin/support-requests";
import { api } from "@/lib/api/server";

export const metadata = { title: "Support · Admin" };

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string; focus?: string }> }) {
  const { status: raw, focus } = await searchParams;
  const status: SupportStatus | null = raw === "all" ? null : raw === "closed" ? "closed" : "open";
  const data = await api<SupportList>("/admin/support", { query: { status: status ?? undefined, pageSize: 100 } });
  return (
    <AdminPage title="Support" description="Messages from the public contact page and the in-app Help & support form.">
      <SupportRequests data={data} status={status} focus={focus ?? null} />
    </AdminPage>
  );
}
