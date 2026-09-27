import { PageShell } from "@/components/app/page-shell";
import { ForecastView } from "@/components/reports/forecast-view";
import type { Forecast } from "@/components/reports/types";
import { api } from "@/lib/api/server";

export const metadata = { title: "Forecasts" };

export default async function ForecastsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days } = await searchParams;
  const horizon = [30, 60, 90].includes(Number(days)) ? Number(days) : 90;
  const forecast = await api<Forecast>("/analytics/forecast", { query: { days: horizon } });
  return (
    <PageShell title="Cash forecast" width="wide">
      <ForecastView forecast={forecast} />
    </PageShell>
  );
}
