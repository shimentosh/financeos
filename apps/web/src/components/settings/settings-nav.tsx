"use client";

import {
  Bell,
  Bot,
  Building2,
  Coins,
  CreditCard,
  Database,
  History,
  type LucideIcon,
  Plug,
  Shield,
  SlidersHorizontal,
  Tags,
  User,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const SECTIONS: Array<{ title: string; items: Array<{ href: string; label: string; icon: LucideIcon; match?: string }> }> = [
  {
    title: "Account",
    items: [
      { href: "/settings/profile", label: "Profile", icon: User },
      { href: "/settings/preferences", label: "Preferences", icon: SlidersHorizontal },
      { href: "/settings/notifications", label: "Notifications", icon: Bell },
      { href: "/settings/security", label: "Security", icon: Shield },
      { href: "/settings/billing", label: "Plan & billing", icon: CreditCard },
      { href: "/settings/account", label: "Data & account", icon: Database },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/settings/workspace", label: "Workspace & members", icon: Building2 },
      { href: "/settings/categories", label: "Categories", icon: Tags },
      { href: "/settings/rules", label: "Rules", icon: Workflow },
      { href: "/settings/currency", label: "Currency", icon: Coins },
      { href: "/settings/audit", label: "Audit log", icon: History },
    ],
  },
  {
    title: "AI & integrations",
    items: [
      { href: "/settings/ai", label: "AI", icon: Bot },
      // Connected apps, imports, sync history and API keys: every /integrations screen.
      { href: "/integrations", label: "Integrations", icon: Plug, match: "/integrations" },
    ],
  },
];

/** The settings sidebar: a column on desktop, a scrolling strip on a phone. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="-mx-4 -mt-4 mb-4 shrink-0 border-border border-b md:mx-0 md:mt-0 md:mb-0 md:w-56 md:border-e md:border-b-0">
      <div className="no-scrollbar flex gap-1 overflow-x-auto p-2 md:sticky md:top-0 md:flex-col md:gap-4 md:p-4">
        {SECTIONS.map((section) => (
          <div key={section.title} className="flex gap-1 md:flex-col">
            <p className="hidden px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:block">{section.title}</p>
            {section.items.map((item) => {
              const active = pathname === item.href || (item.match !== undefined && pathname.startsWith(item.match));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                    active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
