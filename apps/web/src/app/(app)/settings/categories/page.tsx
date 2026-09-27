import { CategorySettings } from "@/components/settings/catalog-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { api } from "@/lib/api/server";
import type { Category } from "@/lib/api/types";

export const metadata = { title: "Categories" };

export default async function Page() {
  const categories = await api<Category[]>("/categories", { query: { includeArchived: true } });
  return (
    <SettingsPage title="Categories" description="Subcategories roll up into their parent in every report and budget.">
      <CategorySettings categories={categories} />
    </SettingsPage>
  );
}
