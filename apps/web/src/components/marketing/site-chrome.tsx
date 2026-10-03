import { Wallet } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2", className)} aria-label="FinanceOS home">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Wallet className="size-4.5" aria-hidden />
      </span>
      <span className="font-semibold tracking-tight">FinanceOS</span>
    </Link>
  );
}

const NAV = [
  { href: "/welcome#features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Contact" },
];

/** The public site's header: logo, a few links, sign in and sign up. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-lg">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-5 text-sm text-muted-foreground md:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="transition-colors hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" render={<Link href="/sign-in" />}>
            Sign in
          </Button>
          <Button size="sm" render={<Link href="/sign-up" />}>
            Start free
          </Button>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const groups: Array<{ title: string; links: Array<{ href: string; label: string }> }> = [
    {
      title: "Product",
      links: [
        { href: "/welcome#features", label: "Features" },
        { href: "/pricing", label: "Pricing" },
        { href: "/sign-up", label: "Create an account" },
      ],
    },
    { title: "Help", links: [{ href: "/contact", label: "Contact support" }] },
    {
      title: "Legal",
      links: [
        { href: "/terms", label: "Terms of Service" },
        { href: "/privacy", label: "Privacy Policy" },
      ],
    },
  ];
  return (
    <footer className="border-t border-border bg-sidebar">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="space-y-2">
          <Logo />
          <p className="max-w-xs text-sm text-muted-foreground">Personal and business money in one ledger. AI does the typing; you stay in control.</p>
        </div>
        {groups.map((group) => (
          <div key={group.title} className="space-y-2">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.title}</p>
            <ul className="space-y-1.5 text-sm">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-foreground/80 transition-colors hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/70">
        <p className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted-foreground">© {new Date().getFullYear()} FinanceOS. All rights reserved.</p>
      </div>
    </footer>
  );
}

/** A centred column for the public site's content pages. */
export function SiteSection({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={cn("mx-auto w-full max-w-6xl scroll-mt-20 px-4", className)}>
      {children}
    </section>
  );
}
