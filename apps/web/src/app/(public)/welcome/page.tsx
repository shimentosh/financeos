import {
  ArrowRight,
  BellRing,
  Bot,
  Briefcase,
  Camera,
  Check,
  Coins,
  FileDown,
  Landmark,
  Lock,
  type LucideIcon,
  PiggyBank,
  Plug,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SiteSection } from "@/components/marketing/site-chrome";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Expense Wise — personal and business money in one ledger",
  description:
    "Capture receipts and screenshots, connect bKash, banks and apps, and ask in English or বাংলা. One clean ledger for your household and your company; AI does the typing, you stay in control.",
};

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string; tone: string }> = [
  {
    icon: Camera,
    title: "Capture anything",
    body: "Snap a receipt, forward an SMS, drop a bKash screenshot or a bank PDF. AI reads it into a draft; you confirm with one tap.",
    tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  {
    icon: Bot,
    title: "A copilot that does the work",
    body: "Ask “how much on food last month?” or say “lunch 250 from bKash”. It answers from your ledger and prepares changes for you to confirm.",
    tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  {
    icon: BellRing,
    title: "Bills and subscriptions",
    body: "Rent, internet, Netflix, domains, loan installments: reminders before they're due, price changes spotted, paid in one tap.",
    tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    icon: PiggyBank,
    title: "Budgets and goals",
    body: "Monthly budgets that warn you in time, savings goals and dream purchases with the monthly amount that gets you there.",
    tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  {
    icon: Landmark,
    title: "Wealth and net worth",
    body: "Assets, investments, loans you owe and money owed to you, in one net worth that updates itself.",
    tone: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  },
  {
    icon: Briefcase,
    title: "Built for small businesses",
    body: "A separate company workspace with projects, payroll, revenue, invoices and receivables, and an accountant who can view without editing.",
    tone: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  {
    icon: Coins,
    title: "Taka first, every currency",
    body: "BDT by default with lakh grouping, plus dollars, euros and more at the rate you actually paid.",
    tone: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  },
  {
    icon: Plug,
    title: "Connect and automate",
    body: "Imports from CSV and Excel, connections to your apps, a REST API, webhooks, and MCP for AI agents like Claude.",
    tone: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  },
  {
    icon: Users,
    title: "Share with the right people",
    body: "Invite a partner, co-founder or accountant as admin, member or read-only viewer. Every change is in the audit log.",
    tone: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  },
];

const STEPS = [
  { title: "Capture", body: "Receipts, screenshots, SMS, voice notes, statements." },
  { title: "Connect", body: "Wallets, banks and the apps you sell through." },
  { title: "Understand", body: "Where money goes, what's due, what you're worth." },
  { title: "Act", body: "Pay on time, stay on budget, reach your goals." },
];

const TRUST: Array<{ icon: LucideIcon; title: string; body: string }> = [
  { icon: ShieldCheck, title: "You confirm, AI suggests", body: "Nothing AI reads or prepares reaches your books until you (or a rule you set) confirm it." },
  {
    icon: Lock,
    title: "Encrypted where it matters",
    body: "Connection credentials and keys are encrypted; receipts sit in private storage, opened only through your workspace.",
  },
  { icon: ScrollText, title: "A full audit trail", body: "Every change records who made it and what it was before." },
  { icon: FileDown, title: "Your data, always", body: "Export everything as JSON or CSV at any time, and delete your account whenever you like." },
];

const FAQ = [
  {
    q: "Is there a free plan?",
    a: "Yes. The Free plan covers a personal and a business workspace with unlimited transactions, receipts and a monthly allowance of AI credits. Upgrade only when you need more people, storage or AI.",
  },
  {
    q: "Do I have to connect my bank?",
    a: "No. Most people start by typing or capturing: a screenshot of a bKash message or a photo of a receipt is enough. Connections and imports are there when you want them.",
  },
  {
    q: "Can I write in Bangla?",
    a: "Yes. Capture and the copilot understand English, Bangla and Banglish: “gotokal bazar 1200 cash e” works.",
  },
  {
    q: "What does the AI see?",
    a: "Only what it needs for the task you asked for — a receipt you captured, or figures the copilot looks up for your question. You can turn AI off for a workspace at any time and keep using the app with its built-in parser and rules.",
  },
  {
    q: "Can my accountant see the books?",
    a: "Invite them to your company workspace as a viewer: they see everything and can export, but can't change anything.",
  },
];

function ProductPreview() {
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-br from-violet-500/15 via-sky-500/10 to-emerald-500/15 blur-2xl" />
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-lg/5">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-border p-3">
            <p className="text-[11px] text-muted-foreground">Cash on hand</p>
            <p className="font-semibold tabular-nums">৳1,24,850.00</p>
          </div>
          <div className="rounded-xl border border-border p-3">
            <p className="text-[11px] text-muted-foreground">Spent this month</p>
            <p className="font-semibold tabular-nums">৳38,410.00</p>
          </div>
        </div>
        <div className="space-y-2 rounded-xl bg-muted/40 p-3">
          <p className="ms-auto w-fit rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">office rent 15000 bkash e dilam</p>
          <div className="rounded-xl border border-violet-500/30 bg-card p-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <Sparkles className="size-3.5 text-violet-500" /> Record an expense
              <span className="rounded-full bg-violet-500/10 px-1.5 text-[10px] font-normal text-violet-700 dark:text-violet-300">Not saved yet</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">৳15,000.00 · Office Rent · from bKash · today</p>
            <div className="mt-2 flex gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[11px] text-primary-foreground">
                <Check className="size-3" /> Confirm
              </span>
              <span className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground">Discard</span>
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          {[
            ["Netflix renews in 3 days", "৳1,100.00"],
            ["Internet bill due Friday", "৳1,500.00"],
          ].map(([label, amount]) => (
            <div key={label} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5">
                <BellRing className="size-3.5 text-amber-500" /> {label}
              </span>
              <span className="tabular-nums text-muted-foreground">{amount}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <>
      <SiteSection className="grid items-center gap-12 py-16 md:py-24 lg:grid-cols-2">
        <div className="space-y-6">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-violet-500" aria-hidden /> Personal and business money, one ledger
          </p>
          <h1 className="font-semibold text-4xl tracking-tight md:text-5xl">Know where every taka goes.</h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Capture receipts, SMS and screenshots, connect bKash, banks and apps, and ask in English or বাংলা. Expense Wise keeps one clean ledger for your
            household and your company — AI does the typing, you stay in control.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" render={<Link href="/sign-up" />}>
              Start free <ArrowRight aria-hidden />
            </Button>
            <Button size="lg" variant="outline" render={<Link href="/pricing" />}>
              See pricing
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Free plan, no card needed. Export or delete your data any time.</p>
        </div>
        <ProductPreview />
      </SiteSection>

      <SiteSection className="py-10">
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground tabular-nums">0{index + 1}</p>
              <p className="mt-1 font-semibold">{step.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </SiteSection>

      <SiteSection id="features" className="py-16">
        <div className="mb-8 max-w-2xl space-y-2">
          <h2 className="font-semibold text-3xl tracking-tight">Everything your money touches</h2>
          <p className="text-muted-foreground">From a cup of tea paid by bKash to your company's payroll, in one place that stays accurate.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-xl border border-border bg-card p-5">
              <span className={`flex size-9 items-center justify-center rounded-lg ${feature.tone}`}>
                <feature.icon className="size-4.5" aria-hidden />
              </span>
              <h3 className="mt-3 font-semibold">{feature.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </SiteSection>

      <SiteSection className="py-16">
        <div className="rounded-2xl border border-border bg-sidebar p-6 md:p-10">
          <div className="mb-6 max-w-2xl space-y-2">
            <h2 className="font-semibold text-2xl tracking-tight">Your ledger is the source of truth</h2>
            <p className="text-muted-foreground">AI helps you keep it complete. It never quietly becomes the record.</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((item) => (
              <div key={item.title} className="space-y-1.5">
                <item.icon className="size-5 text-foreground/70" aria-hidden />
                <p className="font-medium">{item.title}</p>
                <p className="text-sm text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </SiteSection>

      <SiteSection className="py-16">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div className="space-y-2">
            <h2 className="font-semibold text-2xl tracking-tight">Questions</h2>
            <p className="text-muted-foreground">
              Something else?{" "}
              <Link href="/contact" className="underline underline-offset-4 hover:text-foreground">
                Write to us
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

      <SiteSection className="pb-20">
        <div className="flex flex-col items-start gap-4 rounded-2xl bg-primary p-8 text-primary-foreground md:flex-row md:items-center md:justify-between md:p-10">
          <div>
            <h2 className="font-semibold text-2xl tracking-tight">Start with the next thing you spend.</h2>
            <p className="mt-1 text-primary-foreground/75">It takes a minute to set up. The free plan stays free.</p>
          </div>
          <Button size="lg" variant="secondary" render={<Link href="/sign-up" />}>
            Create your account <ArrowRight aria-hidden />
          </Button>
        </div>
      </SiteSection>
    </>
  );
}
