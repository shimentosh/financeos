import { NotificationSettings } from "@/components/settings/account-settings";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Notifications" };

export default function Page() {
  return (
    <SettingsPage title="Notifications" description="When and how FinanceOS reminds you.">
      <NotificationSettings />
    </SettingsPage>
  );
}
