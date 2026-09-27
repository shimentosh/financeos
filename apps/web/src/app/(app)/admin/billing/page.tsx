import { AdminPage } from "@/components/admin/admin-page";
import { AdminBillingPeople, AdminBillingSummaryCards } from "@/components/billing/admin-billing-people";
import { AdminBillingSettings } from "@/components/billing/admin-billing-settings";
import { api } from "@/lib/api/server";
import type { AdminBillingPayment, AdminBillingSummary, AdminBillingUser, BillingConfigView } from "@/lib/api/types/billing";

export const metadata = { title: "Billing · Admin" };

export default async function Page() {
  const [view, summary, users, payments] = await Promise.all([
    api<BillingConfigView>("/admin/billing"),
    api<AdminBillingSummary>("/admin/billing/summary"),
    api<AdminBillingUser[]>("/admin/billing/users"),
    api<AdminBillingPayment[]>("/admin/billing/payments", { query: { limit: 50 } }),
  ]);
  return (
    <AdminPage
      title="Billing"
      description="Plans, prices and AI credits for the hosted service, the payment providers, and the people paying. Off by default: a self-hosted install isn't billed."
    >
      <AdminBillingSummaryCards summary={summary} />
      <AdminBillingSettings view={view} />
      <AdminBillingPeople users={users} payments={payments} enabled={view.enabled} />
    </AdminPage>
  );
}
