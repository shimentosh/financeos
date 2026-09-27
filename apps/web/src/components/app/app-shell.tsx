"use client";

import type { CSSProperties, ReactNode } from "react";
import { AppProvider } from "@/components/app/app-context";
import { AppSidebar } from "@/components/app/app-sidebar";
import { CommandPalette } from "@/components/app/command-palette";
import { MobileTabBar } from "@/components/app/mobile-tab-bar";
import { GlobalTransactionForm } from "@/components/app/transaction-form";
import { PlanLimitDialog } from "@/components/billing/plan-limit-dialog";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CurrentWorkspace, Me } from "@/lib/api/types";

/**
 * TeamOS's frame: an inset sidebar beside a rounded content card on desktop,
 * edge-to-edge with a bottom tab bar on a phone.
 */
export function AppShell({ me, workspace, inboxCount, children }: { me: Me; workspace: CurrentWorkspace; inboxCount: number; children: ReactNode }) {
  return (
    <AppProvider me={me} workspace={workspace}>
      <TooltipProvider>
        <div className="app-height flex w-full overflow-hidden bg-background md:h-auto md:overflow-visible">
          <SidebarProvider
            className="min-h-0 md:min-h-svh"
            defaultOpen={!me.preferences.sidebarCollapsed}
            style={{ "--sidebar-width": "calc(var(--spacing) * 60)" } as CSSProperties}
          >
            <AppSidebar inboxCount={inboxCount} />
            <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-auto pb-tab-bar md:m-2 md:rounded-xl md:border md:border-border/80 md:pb-0 md:shadow-sm/5">
              {children}
            </SidebarInset>
            <MobileTabBar inboxCount={inboxCount} />
            <CommandPalette />
            <GlobalTransactionForm />
            <PlanLimitDialog />
          </SidebarProvider>
        </div>
      </TooltipProvider>
    </AppProvider>
  );
}
