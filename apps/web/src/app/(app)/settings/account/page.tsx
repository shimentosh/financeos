import { DataAccountSettings, type DeletionCheck } from "@/components/settings/data-account";
import { SettingsPage } from "@/components/settings/settings-page";
import { api } from "@/lib/api/server";

export const metadata = { title: "Data & account" };

export default async function Page() {
  const check = await api<DeletionCheck>("/account/deletion-check");
  return (
    <SettingsPage title="Data & account" description="Take a copy of your records, or delete your account.">
      <DataAccountSettings check={check} />
    </SettingsPage>
  );
}
