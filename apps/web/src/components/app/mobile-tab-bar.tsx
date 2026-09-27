"use client";

import { ArrowLeftRight, Camera, ClipboardPaste, Inbox, LayoutDashboard, Menu, Mic, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { openAddTransaction } from "@/components/app/global-actions";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/transactions", label: "Activity", icon: ArrowLeftRight },
  { href: "/ai/inbox", label: "Inbox", icon: Inbox, badge: true },
];

/**
 * The phone's navigation. The middle button is the product's core loop:
 * open → + → screenshot → confirm → done.
 */
export function MobileTabBar({ inboxCount }: { inboxCount: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const [captureOpen, setCaptureOpen] = useState(false);

  const tab = (item: (typeof TABS)[number]) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 pt-1.5 pb-1 transition-colors",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="relative flex h-6 w-full items-center justify-center">
          <item.icon aria-hidden className={cn("size-[22px]", active && "stroke-[2.25]")} />
          {item.badge && inboxCount > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 start-1/2 ms-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-medium text-[10px] text-white tabular-nums"
            >
              {inboxCount > 99 ? "99+" : inboxCount}
            </span>
          )}
        </span>
        <span className={cn("max-w-full truncate px-0.5 text-[10px] leading-tight", active && "font-medium")}>{item.label}</span>
      </Link>
    );
  };

  const choose = (action: () => void) => {
    setCaptureOpen(false);
    action();
  };

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-safe backdrop-blur-lg in-data-keyboard-open:hidden md:hidden"
      >
        <div className="flex h-(--tab-bar-height) items-stretch px-safe">
          {tab(TABS[0] as (typeof TABS)[number])}
          {tab(TABS[1] as (typeof TABS)[number])}
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              aria-label="Add or capture"
              onClick={() => setCaptureOpen(true)}
              className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-95"
            >
              <Plus className="size-6" />
            </button>
          </div>
          {tab(TABS[2] as (typeof TABS)[number])}
          <button
            type="button"
            onClick={() => setOpenMobile(true)}
            className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 pt-1.5 pb-1 text-muted-foreground"
          >
            <span className="flex h-6 items-center">
              <Menu className="size-[22px]" />
            </span>
            <span className="text-[10px] leading-tight">More</span>
          </button>
        </div>
      </nav>

      <Sheet open={captureOpen} onOpenChange={setCaptureOpen}>
        <SheetPopup side="bottom" className="pb-safe">
          <SheetHeader>
            <SheetTitle>Add</SheetTitle>
          </SheetHeader>
          <SheetPanel className="grid grid-cols-2 gap-2 pb-6">
            <button
              type="button"
              onClick={() => choose(() => router.push("/capture?mode=screenshot"))}
              className="col-span-2 flex items-center gap-3 rounded-xl border border-border bg-primary px-4 py-4 text-left text-primary-foreground"
            >
              <Camera className="size-6" />
              <span>
                <span className="block font-medium">Scan screenshot</span>
                <span className="block text-xs opacity-80">bKash, bank, receipt — AI fills it in</span>
              </span>
            </button>
            {[
              { label: "Paste text", icon: ClipboardPaste, run: () => router.push("/capture?mode=text") },
              { label: "Voice", icon: Mic, run: () => router.push("/capture?mode=voice") },
              { label: "Expense", icon: Wallet, run: () => openAddTransaction("expense") },
              { label: "Income", icon: Plus, run: () => openAddTransaction("income") },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => choose(option.run)}
                className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-3 text-left text-sm font-medium"
              >
                <option.icon className="size-5 text-muted-foreground" />
                {option.label}
              </button>
            ))}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </>
  );
}
