"use client";

import { ChevronLeft, MoreVertical } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useApp } from "@/components/app/app-context";
import { GlobalActions } from "@/components/app/global-actions";
import { sectionFor } from "@/components/app/nav";
import { SectionTabs } from "@/components/app/section-tabs";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/cn";

type Crumb = { label: string; href?: string };

type PageShellProps = {
  title: string;
  /** Extra breadcrumb levels between the workspace and the title. */
  crumbs?: Crumb[];
  /** Page actions on the right of the desktop header: small labelled buttons. */
  actions?: ReactNode;
  /** At most two icon actions for the phone app bar. */
  mobileActions?: ReactNode;
  /** Items folded behind the phone app bar's kebab. */
  mobileMenu?: ReactNode;
  /** Shows a back chevron on phones (detail pages). */
  backHref?: string;
  children: ReactNode;
  /** `full` removes the max width for dense tables and boards. */
  width?: "default" | "wide" | "full";
  /** `settings` puts the page beside the Settings menu (settings and integration screens). */
  frame?: "settings";
  className?: string;
};

/**
 * The frame of every page: TeamOS's 40px header on desktop, an app bar on a
 * phone, and the centred content column.
 */
export function PageShell({ title, crumbs = [], actions, mobileActions, mobileMenu, backHref, children, width = "default", frame, className }: PageShellProps) {
  const { workspace } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  // A sub-page of a parent page (Wealth → Assets) shows the parent's tabs and crumb.
  const section = sectionFor(pathname, workspace.kind);
  const settingsFrame = frame === "settings";
  const trail: Crumb[] = settingsFrame
    ? [{ label: "Settings", href: "/settings" }, ...crumbs.filter((crumb) => crumb.label !== "Settings")]
    : section && section.title !== title && !crumbs.some((crumb) => crumb.label === section.title)
      ? [{ label: section.title, href: section.tabs[0]?.href }, ...crumbs]
      : crumbs;

  return (
    <>
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-card/95 pt-safe backdrop-blur-lg md:hidden" data-slot="mobile-app-bar">
        <div className="flex h-(--app-bar-height) items-center gap-1 px-bar">
          {backHref ? (
            <Button aria-label="Back" className="size-10 shrink-0" size="icon" variant="ghost" onClick={() => router.push(backHref)}>
              <ChevronLeft className="size-5" />
            </Button>
          ) : (
            <SidebarTrigger className="size-10" />
          )}
          <div className="min-w-0 flex-1">
            <span className="block truncate font-heading font-semibold text-[15px] leading-tight">{title}</span>
            <span className="block truncate text-[11px] text-muted-foreground leading-tight">{workspace.name}</span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {mobileActions}
            <GlobalActions compact />
            {mobileMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button aria-label="More" className="size-10" size="icon" variant="ghost" />}>
                  <MoreVertical className="size-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52" side="bottom">
                  {mobileMenu}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      <header className="sticky top-0 z-20 hidden h-10 shrink-0 items-center gap-2 border-border border-b bg-card p-2 md:flex">
        <div className="flex w-full min-w-0 items-center gap-1">
          <SidebarTrigger className="-ml-1 h-6 w-6" />
          <div className="mx-1.5 h-4 w-px shrink-0 bg-border/80" />
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
            <Link href="/" className="truncate text-card-foreground hover:text-foreground">
              {workspace.name}
            </Link>
            {trail.map((crumb) => (
              <span key={crumb.label} className="flex min-w-0 items-center gap-1.5">
                <span className="text-muted-foreground/60">/</span>
                {crumb.href ? (
                  <Link href={crumb.href} className="truncate text-card-foreground hover:text-foreground">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="truncate text-card-foreground">{crumb.label}</span>
                )}
              </span>
            ))}
            <span className="text-muted-foreground/60">/</span>
            <span className="truncate font-medium text-foreground">{title}</span>
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        <div className="mx-0.5 h-4 w-px shrink-0 bg-border/80" />
        <GlobalActions />
      </header>

      {section && !section.settings && !settingsFrame && <SectionTabs label={section.title} tabs={section.tabs} active={pathname} width={width} />}

      {settingsFrame ? (
        <main className={cn("mx-auto flex w-full max-w-[96rem] flex-col p-4 md:p-0", className)}>
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <SettingsNav />
            <div className="flex min-w-0 flex-1 flex-col gap-4 md:p-6">
              {section?.settings && <SectionTabs label={section.title} tabs={section.tabs} active={pathname} variant="inline" />}
              {children}
            </div>
          </div>
        </main>
      ) : (
        <main
          className={cn("mx-auto flex w-full flex-col gap-4 p-4 md:p-6", width === "default" && "max-w-7xl", width === "wide" && "max-w-[96rem]", className)}
        >
          {children}
        </main>
      )}
    </>
  );
}

/** Title block at the top of a page's content. */
export function PageHeading({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
