"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import type { SectionTab } from "./nav";

/**
 * The tabs of a parent page (Wealth: Net worth · Assets · …). Each tab is its own route,
 * so links, the back button and deep links keep working; only the sidebar gets shorter.
 */
export function SectionTabs({
  label,
  tabs,
  active,
  variant = "bar",
  width = "default",
}: {
  label: string;
  tabs: SectionTab[];
  active: string;
  /** `bar` spans the page under the header; `inline` sits inside a content column. */
  variant?: "bar" | "inline";
  width?: "default" | "wide" | "full";
}) {
  const list = (
    <div className="no-scrollbar -mx-2.5 flex gap-0.5 overflow-x-auto">
      {tabs.map((tab) => {
        const current = tab.href === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "group relative flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
              "after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors",
              current ? "font-medium text-foreground after:bg-foreground" : "text-muted-foreground after:bg-transparent hover:text-foreground",
            )}
          >
            <tab.icon
              className={cn("size-4 shrink-0 transition-colors", current ? "text-foreground" : "text-muted-foreground/80 group-hover:text-foreground")}
              aria-hidden
            />
            {tab.title}
          </Link>
        );
      })}
    </div>
  );

  if (variant === "inline") {
    return (
      <nav aria-label={label} className="border-border border-b">
        {list}
      </nav>
    );
  }
  return (
    <nav aria-label={label} className="shrink-0 border-border border-b bg-card/95 backdrop-blur-lg md:sticky md:top-10 md:z-20">
      <div className={cn("mx-auto w-full px-4 md:px-6", width === "default" && "max-w-7xl", width === "wide" && "max-w-[96rem]")}>{list}</div>
    </nav>
  );
}
