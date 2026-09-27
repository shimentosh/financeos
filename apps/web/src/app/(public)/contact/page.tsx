import { BookOpen, CreditCard, LifeBuoy, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SiteSection } from "@/components/marketing/site-chrome";
import { SupportForm } from "@/components/marketing/support-form";

export const metadata: Metadata = { title: "Contact", description: "Questions, problems, billing or privacy requests: write to the Expense Wise team." };

const TOPICS = [
  { icon: LifeBuoy, title: "Something isn't working", body: "Tell us what you did and what happened; a screenshot helps." },
  { icon: CreditCard, title: "Billing and invoices", body: "Plan changes, invoices, bKash or bank transfer payments." },
  { icon: ShieldAlert, title: "Security or privacy", body: "A suspected account problem, or a request about your data." },
  { icon: BookOpen, title: "How do I…?", body: "Getting started, imports, connections, the API and MCP." },
];

export default function ContactPage() {
  return (
    <SiteSection className="py-14 md:py-20">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.3fr]">
        <div className="space-y-6">
          <div className="space-y-2">
            <h1 className="font-semibold text-3xl tracking-tight">Contact us</h1>
            <p className="text-muted-foreground">A person reads every message. We usually reply within one working day.</p>
          </div>
          <ul className="space-y-4">
            {TOPICS.map((topic) => (
              <li key={topic.title} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70">
                  <topic.icon className="size-4.5" aria-hidden />
                </span>
                <div>
                  <p className="font-medium">{topic.title}</p>
                  <p className="text-sm text-muted-foreground">{topic.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/sign-in" className="underline underline-offset-4 hover:text-foreground">
              Sign in
            </Link>{" "}
            and use Help &amp; support in the app: your message arrives with your account attached.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <SupportForm />
        </div>
      </div>
    </SiteSection>
  );
}
