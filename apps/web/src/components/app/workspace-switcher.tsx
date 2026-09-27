"use client";

import { Briefcase, Check, ChevronDown, Loader2, Plus, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { type CSSProperties, useState } from "react";
import { useApp } from "@/components/app/app-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { toast } from "@/lib/toast";

/** A workspace reads as a mark before it reads as a name, as in TeamOS. */
export function WorkspaceMark({ workspace, className }: { workspace: { id: string; name: string }; className?: string }) {
  const hue = [...workspace.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return (
    <span
      aria-hidden
      className={cn(
        "ew-workspace-mark flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md font-semibold text-[10px] uppercase",
        className,
      )}
      style={{ "--mark-hue": hue } as CSSProperties}
    >
      {initials(workspace.name)}
    </span>
  );
}

export function WorkspaceSwitcher() {
  const { me, workspace } = useApp();
  const router = useRouter();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const switchTo = async (id: string) => {
    if (id === workspace.id || switchingTo) return;
    setSwitchingTo(id);
    try {
      await clientApi("/me/active-workspace", { method: "POST", body: { workspaceId: id } });
      router.push("/");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTimeout(() => setSwitchingTo(null), 300);
    }
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton className="group h-9 w-full gap-2 rounded-lg px-1.5 text-sidebar-foreground" />}>
            <WorkspaceMark workspace={workspace} />
            <span className="min-w-0 flex-1 truncate text-left">
              <span className="block truncate font-medium text-foreground text-sm leading-tight">{workspace.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground leading-tight">
                {workspace.kind === "business" ? "Business" : "Personal"} · {workspace.baseCurrency}
              </span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[max(16rem,var(--anchor-width))] p-1.5" align="start" side="bottom" sideOffset={6}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide">Workspaces</DropdownMenuLabel>
              {me.workspaces.map((ws) => {
                const current = ws.id === workspace.id;
                return (
                  <DropdownMenuItem
                    key={ws.id}
                    onClick={() => void switchTo(ws.id)}
                    className={cn("gap-2.5 rounded-md px-2 py-1.5 text-sm", current && "bg-sidebar-accent/50")}
                  >
                    <WorkspaceMark workspace={ws} />
                    <span className="min-w-0 flex-1 truncate font-medium">{ws.name}</span>
                    <span className="text-muted-foreground">{ws.kind === "business" ? <Briefcase className="size-3.5" /> : <User className="size-3.5" />}</span>
                    {switchingTo === ws.id ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : current ? (
                      <Check className="size-3.5 text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="mx-1" />
            <DropdownMenuItem onClick={() => router.push("/settings/workspace?new=1")} className="gap-2.5 rounded-md px-2 py-1.5 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border border-dashed text-muted-foreground">
                <Plus className="size-3.5" />
              </span>
              <span className="truncate">Add workspace</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
