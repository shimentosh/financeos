import { type CreditPack, DEFAULT_CREDITS_PER_USD, DEFAULT_PLANS, PLAN_IDS, type PublicPlan } from "@financeos/core";
import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PricingTable } from "@/components/marketing/pricing-table";
import { SiteSection } from "@/components/marketing/site-chrome";
import { publicApi } from "@/lib/api/public";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Free for your own money. Pro and Business when you need more people, storage and AI.",
};

type PlansResponse = { enabled: boolean; plans: PublicPlan[]; creditPacks: CreditPack[]; creditsPerUsd?: number };

const FAQ = [
  {
    q: "What is an AI credit?",
    a: `AI reads your receipts and screenshots and answers the copilot. Each use costs credits in line with what the AI model costs — one credit is about one US cent of model time (${DEFAULT_CREDITS_PER_USD} credits a dollar), and a typical receipt or question uses one to three. Your plan includes credits every month; packs top you up.`,
  },
  {
    q: "What happens when I run out of credits?",
    a: "Nothing breaks. Capture falls back to the built-in parser and rules, and the copilot answers the common questions without AI, until your credits refresh or you buy a pack.",
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Any time, from Settings → Plan & billing. Cancelling keeps the plan until the end of the period you paid for, then you move to Free with your data intact.",
  },
  {
    q: "How can I pay?",
    a: "By card, or in Bangladesh with bKash, Nagad, Rocket and local cards. Yearly plans cost less. Need an invoice or bank transfer? Contact us.",
  },
  { q: "Is my data safe if I stop paying?", a: "Yes. Nothing is deleted when a plan ends. You can export everything as JSON or CSV at any time." },
];

export default async function PricingPage() {
  const data = await publicApi<PlansResponse>("/billing/plans");
  const billed = Boolean(data?.enabled && data.plans?.some((plan) => plan.prices.length > 0));
  const plans: PublicPlan[] = data?.plans?.length ? data.plans : PLAN_IDS.map((id) => ({ ...DEFAULT_PLANS[id], prices: [] }));
  return (
    <>
      <SiteSection className="py-14 text-center md:py-20">
        <h1 className="font-semibold text-4xl tracking-tight">Simple pricing</h1>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Free for your own money. Pro and Business when you need more people, more storage and more AI. Every plan has unlimited transactions.
        </p>
        {!billed && (
          <p className="mx-auto mt-5 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-sm text-emerald-700 dark:text-emerald-400">
            <Sparkles className="size-4" aria-hidden /> Early access: every plan is free right now.
          </p>
        )}
      </SiteSection>
      <SiteSection className="pb-16">
        <PricingTable plans={plans} packs={data?.creditPacks ?? []} billed={billed} />
      </SiteSection>
      <SiteSection className="pb-20">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="space-y-2">
            <h2 className="font-semibold text-2xl tracking-tight">Pricing questions</h2>
            <p className="text-muted-foreground">
              Something else?{" "}
              <Link href="/contact" className="underline underline-offset-4 hover:text-foreground">
                Ask us
              </Link>
              .
            </p>
          </div>
          <dl className="divide-y divide-border rounded-xl border border-border bg-card">
            {FAQ.map((item) => (
              <div key={item.q} className="p-4">
                <dt className="font-medium">{item.q}</dt>
                <dd className="mt-1 text-sm text-muted-foreground">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </SiteSection>
    </>
  );
}
