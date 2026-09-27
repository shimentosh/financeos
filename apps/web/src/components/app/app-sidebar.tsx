"use client";

import { ChevronRight, LifeBuoy, Search, Settings, Shield } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { HelpDialog } from "@/components/app/help-dialog";
import { activeHref, navFor } from "@/components/app/nav";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/cn";

export function AppSidebar({ inboxCount }: { inboxCount: number }) {
  const { workspace, me } = useApp();
  const [helpOpen, setHelpOpen] = useState(false);
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = navFor(workspace.kind);
  const active = activeHref(pathname, groups);

  return (
    <Sidebar collapsible="offcanvas" variant="inset" className="border-none pt-1.5">
      <SidebarHeader className="pt-1 pb-1.5">
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent className="gap-0 py-1">
        <div className="px-2 pb-1">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("ew:command"))}
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background/60 px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Search className="size-3.5" />
            <span className="flex-1 text-left">Search or ask…</span>
            <Kbd>⌘K</Kbd>
          </button>
        </div>
        {groups.map((group) => (
          <Collapsible key={group.id} defaultOpen className="group/collapsible">
            <SidebarGroup className="gap-1 px-2 py-1.5">
              {group.id !== "home" && (
                <CollapsibleTrigger
                  className="data-panel-open:[&_svg]:rotate-90"
                  render={<SidebarGroupLabel className="h-7 cursor-pointer justify-between px-0 text-sidebar-accent-foreground" />}
                >
                  <span>{group.title}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-sidebar-foreground/60 transition-transform duration-200" />
                </CollapsibleTrigger>
              )}
              <CollapsiblePanel>
                <SidebarGroupContent>
                  <SidebarMenu className="gap-0.5">
                    {group.items.map((item) => {
                      const isActive = active === item.href;
                      const badge = item.badge === "inbox" && inboxCount > 0 ? inboxCount : null;
                      return (
                        <SidebarMenuItem key={`${group.id}:${item.href}`}>
                          <SidebarMenuButton
                            tooltip={item.title}
                            isActive={isActive}
                            className={cn(
                              "gap-2.5 ps-3 text-sm hover:bg-transparent hover:text-sidebar-accent-foreground active:bg-transparent [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-foreground/60 data-[active=true]:[&>svg]:text-sidebar-accent-foreground",
                              isMobile ? "h-11" : "h-8",
                            )}
                            render={<Link href={item.href} onClick={() => isMobile && setOpenMobile(false)} />}
                          >
                            <item.icon aria-hidden />
                            <span>{item.title}</span>
                            {badge !== null && (
                              <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-sm border border-sidebar-border/60 px-1 text-[11px] font-medium text-sidebar-foreground/80 tabular-nums">
                                {badge > 99 ? "99+" : badge}
                              </span>
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsiblePanel>
            </SidebarGroup>
          </Collapsible>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-0.5 px-2 pb-3">
        <SidebarMenu className="gap-0.5">
          {me.user.isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname.startsWith("/admin")}
                className="h-8 gap-2.5 ps-3 text-sm [&>svg]:size-4 [&>svg]:text-sidebar-foreground/60"
                render={<Link href="/admin" />}
              >
                <Shield aria-hidden />
                <span>Admin</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname.startsWith("/settings") || pathname.startsWith("/integrations")}
              className="h-8 gap-2.5 ps-3 text-sm [&>svg]:size-4 [&>svg]:text-sidebar-foreground/60"
              render={<Link href="/settings" />}
            >
              <Settings aria-hidden />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-8 gap-2.5 ps-3 text-sm [&>svg]:size-4 [&>svg]:text-sidebar-foreground/60"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                setHelpOpen(true);
              }}
            >
              <LifeBuoy aria-hidden />
              <span>Help &amp; support</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      </SidebarFooter>
    </Sidebar>
  );
}
