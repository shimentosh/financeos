import { ProfileSettings } from "@/components/settings/account-settings";
import { SettingsPage } from "@/components/settings/settings-page";

export const metadata = { title: "Profile" };

export default function Page() {
  return (
    <SettingsPage title="Profile" description="How you sign in and appear to others.">
      <ProfileSettings />
    </SettingsPage>
  );
}
