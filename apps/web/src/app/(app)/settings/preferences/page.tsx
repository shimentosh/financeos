import { PreferencesSettings } from "@/components/settings/account-settings";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Preferences" };

export default function Page() {
  return (
    <SettingsPage title="Preferences" description="Theme, number format and calendar.">
      <PreferencesSettings />
    </SettingsPage>
  );
}
