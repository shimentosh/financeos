import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { api } from "@/lib/api/server";
import type { CurrentWorkspace, Me } from "@/lib/api/types";

export const metadata = { title: "Set up your books" };

export default async function Page() {
  const [me, current] = await Promise.all([api<Me>("/me"), api<CurrentWorkspace>("/workspaces/current")]);
  // Setup is only for new accounts that have not finished it.
  if ((me.preferences as { onboarded?: boolean }).onboarded !== false) redirect("/");
  const personal = me.workspaces.find((w) => w.kind === "personal" && w.role === "owner");
  const business = me.workspaces.find((w) => w.kind === "business" && w.role === "owner");
  return (
    <OnboardingForm
      name={me.user.name}
      defaultCurrency={personal?.baseCurrency ?? current.baseCurrency}
      defaultTimezone={current.timezone}
      businessName={business?.name ?? null}
    />
  );
}
