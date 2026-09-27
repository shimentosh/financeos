import { Suspense } from "react";
import { AuditLog } from "@/components/settings/misc-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { api } from "@/lib/api/server";

export const metadata = { title: "Audit log" };

export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  const data = await api<Parameters<typeof AuditLog>[0]["page"]>("/workspaces/current/audit", { query: { page: page ?? 1, pageSize: 50 } });
  return (
    <SettingsPage title="Audit log" description="Who changed what, when, and from where.">
      <Suspense>
        <AuditLog page={data} />
      </Suspense>
    </SettingsPage>
  );
}
