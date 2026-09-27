import { CurrencySettings } from "@/components/settings/misc-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { api } from "@/lib/api/server";
import type { ExchangeRate } from "@/lib/api/types";

export const metadata = { title: "Currency" };

export default async function Page() {
  const rates = await api<ExchangeRate[]>("/exchange-rates");
  return (
    <SettingsPage title="Currency" description="Exchange rates used to convert foreign amounts into your reporting currency.">
      <CurrencySettings rates={rates} />
    </SettingsPage>
  );
}
