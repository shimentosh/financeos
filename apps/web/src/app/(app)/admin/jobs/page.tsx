import { AdminPage } from "@/components/admin/admin-page";
import { AdminJobsView } from "@/components/admin/admin-views";
import { api } from "@/lib/api/server";

export const metadata = { title: "Jobs · Admin" };

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const data = await api<Parameters<typeof AdminJobsView>[0]["data"]>("/admin/jobs", { query: { status } });
  return (
    <AdminPage title="Jobs & schedules" description="Background work: syncs, AI extraction, reminders, reports.">
      <AdminJobsView data={data} />
    </AdminPage>
  );
}
