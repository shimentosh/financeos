"use client";

import { Activity, Bot, Building2, CreditCard, HardDrive, History, LayoutDashboard, LifeBuoy, type LucideIcon, Plug, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageShell } from "@/components/app/page-shell";
import { cn } from "@/lib/cn";

const NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/workspaces", label: "Workspaces", icon: Building2 },
  { href: "/admin/jobs", label: "Jobs & schedules", icon: Activity },
  { href: "/admin/ai", label: "AI", icon: Bot },
  { href: "/admin/storage", label: "Storage", icon: HardDrive },
  { href: "/admin/billing", label: "Billing", icon: CreditCard },
  { href: "/admin/support", label: "Support", icon: LifeBuoy },
  { href: "/admin/integrations", label: "Integrations", icon: Plug },
  { href: "/admin/audit", label: "Audit", icon: History },
];

/** Platform admin frame: the app shell with an admin tab strip. */
export function AdminPage({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <PageShell title={title} crumbs={[{ label: "Admin", href: "/admin" }]} width="wide">
      <nav aria-label="Admin" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 pb-2 md:mx-0 md:px-0">
        {NAV.map((item) => {
          const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
                active ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className="size-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </PageShell>
  );
}

/** A plain admin table in the TeamOS table style. */
export function AdminTable({
  headers,
  children,
  empty,
}: {
  headers: Array<string | { label: string; align?: "right" }>;
  children: ReactNode;
  empty?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            {headers.map((header) => {
              const h = typeof header === "string" ? { label: header } : header;
              return (
                <th key={h.label} className={cn(h.align === "right" && "text-right!")}>
                  {h.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border [&>tr>td]:px-3 [&>tr>td]:py-2">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
