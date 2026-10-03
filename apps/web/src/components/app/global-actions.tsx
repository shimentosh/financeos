"use client";

import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  BellOff,
  CalendarClock,
  CalendarX,
  Camera,
  Car,
  ChartLine,
  CheckCheck,
  ChevronRight,
  ClipboardPaste,
  FileUp,
  Gauge,
  HandCoins,
  Hourglass,
  Landmark,
  LogOut,
  type LucideIcon,
  Mic,
  Monitor,
  Moon,
  PlugZap,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Sparkles,
  Sun,
  Trophy,
  User,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { TONE, type Tone } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clientApi } from "@/lib/api/client";
import type { Notification } from "@/lib/api/types";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { initials, timeAgo } from "@/lib/format";

export type AddKind = "expense" | "income" | "transfer";

/** Opens the global transaction form from anywhere. */
export function openAddTransaction(type: AddKind = "expense") {
  window.dispatchEvent(new CustomEvent("ew:add-transaction", { detail: { type } }));
}

export function openCommand(query?: string) {
  window.dispatchEvent(new CustomEvent("ew:command", { detail: { query } }));
}

export function AddMenu({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { canWrite } = useApp();
  if (!canWrite) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          compact ? (
            <Button size="icon" className="size-9" aria-label="Add" />
          ) : (
            <Button size="xs" className="gap-1">
              <Plus className="size-3.5" />
              Add
            </Button>
          )
        }
      >
        {compact ? <Plus className="size-5" /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 p-1.5" sideOffset={6}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide">Capture</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => router.push("/capture?mode=screenshot")}>
            <Camera className="size-4" /> Scan screenshot
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/capture?mode=receipt")}>
            <FileUp className="size-4" /> Upload receipt
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/capture?mode=text")}>
            <ClipboardPaste className="size-4" /> Paste text
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/capture?mode=voice")}>
            <Mic className="size-4" /> Voice
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide">Record</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => openAddTransaction("expense")}>
            <ArrowUpRight className="size-4" /> Expense
            <DropdownMenuShortcut>E</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openAddTransaction("income")}>
            <ArrowDownLeft className="size-4" /> Income
            <DropdownMenuShortcut>I</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openAddTransaction("transfer")}>
            <ArrowLeftRight className="size-4" /> Transfer
            <DropdownMenuShortcut>T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/wealth/assets?new=1")}>
            <Car className="size-4" /> Asset
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/wealth/investments?new=1")}>
            <ChartLine className="size-4" /> Investment
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/wealth/liabilities?new=1")}>
            <Landmark className="size-4" /> Debt
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/wealth/receivables?new=1")}>
            <HandCoins className="size-4" /> Receivable
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AskAiButton({ compact }: { compact?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "icon" : "icon-sm"}
            className={compact ? "size-10" : undefined}
            aria-label="Ask AI"
            onClick={() => openCommand()}
          />
        }
      >
        <Sparkles className={compact ? "size-5" : "h-4 w-4"} />
      </TooltipTrigger>
      <TooltipContent>Ask AI · ⌘K</TooltipContent>
    </Tooltip>
  );
}

const NOTIFICATION_ICONS: Record<string, LucideIcon> = {
  budget_warning: Gauge,
  receivable_overdue: HandCoins,
  renewal: RefreshCw,
  payment_due: CalendarClock,
  cancellation_deadline: CalendarX,
  expiry: Hourglass,
  goal_achieved: Trophy,
  integration_error: PlugZap,
};

const SEVERITY_TONE: Record<Notification["severity"], Tone> = { critical: "danger", warning: "warn", success: "good", info: "info" };

const SEVERITY_BAR: Record<Notification["severity"], string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  info: "bg-sky-500",
};

function isToday(iso: string) {
  return new Date(iso).toDateString() === new Date().toDateString();
}

function NotificationRow({ item, onOpen }: { item: Notification; onOpen: (item: Notification) => void }) {
  const Icon = NOTIFICATION_ICONS[item.kind] ?? Bell;
  const unread = !item.readAt;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className={cn("group relative flex w-full gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-accent/60", unread && "bg-accent/30")}
      >
        {unread && <span className={cn("absolute inset-y-2.5 left-0 w-0.5 rounded-full", SEVERITY_BAR[item.severity])} />}
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE[SEVERITY_TONE[item.severity]], !unread && "opacity-60")}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className={cn("line-clamp-2 flex-1 text-[13px] leading-snug", unread ? "font-semibold" : "font-medium text-foreground/80")}>
              {item.title}
            </span>
            <span className="mt-px shrink-0 text-[11px] text-muted-foreground tabular-nums">{timeAgo(item.createdAt)}</span>
          </span>
          {item.body && <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.body}</span>}
        </span>
        {item.link && (
          <ChevronRight className="mt-2 size-3.5 shrink-0 text-muted-foreground/0 transition-all group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
        )}
      </button>
    </li>
  );
}

function Notifications({ compact }: { compact?: boolean }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const data = await clientApi<{ items: Notification[]; unread: number }>("/notifications");
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      // The bell is not worth an error toast; it tries again shortly.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const markAll = async () => {
    await clientApi("/notifications/read", { method: "POST", body: { ids: "all" } });
    void load();
  };

  const openItem = async (item: Notification) => {
    if (!item.readAt) await clientApi("/notifications/read", { method: "POST", body: { ids: [item.id] } }).catch(() => undefined);
    if (item.link) {
      setOpen(false);
      router.push(item.link);
    }
    void load();
  };

  const shown = filter === "unread" ? items.filter((item) => !item.readAt) : items;
  const groups = [
    { label: "Today", items: shown.filter((item) => isToday(item.createdAt)) },
    { label: "Earlier", items: shown.filter((item) => !isToday(item.createdAt)) },
  ].filter((group) => group.items.length);
  const urgent = items.some((item) => !item.readAt && item.severity === "critical");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "icon" : "icon-sm"}
            className={cn("relative", compact && "size-10")}
            aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
          />
        }
      >
        <Bell className={compact ? "size-5" : "h-4 w-4"} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex">
            {urgent && <span className="absolute inset-0 animate-ping rounded-full bg-destructive/60 motion-reduce:hidden" />}
            <span className="relative flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white tabular-nums ring-2 ring-background">
              {unread > 99 ? "99+" : unread}
            </span>
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden p-0">
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[11px] font-semibold text-destructive tabular-nums">{unread} new</span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {unread > 0 && (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Mark all read" onClick={() => void markAll()} />}>
                  <CheckCheck className="size-4" />
                </TooltipTrigger>
                <TooltipContent>Mark all read</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Notification settings"
                    render={<Link href="/settings/notifications" onClick={() => setOpen(false)} />}
                  />
                }
              >
                <Settings className="size-4" />
              </TooltipTrigger>
              <TooltipContent>Notification settings</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="flex gap-1 border-b border-border px-3.5 pb-2">
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors",
                filter === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value}
              {value === "unread" && unread > 0 && <span className="ml-1 text-muted-foreground tabular-nums">{unread}</span>}
            </button>
          ))}
        </div>
        <div className="max-h-112 overflow-y-auto overscroll-contain px-1.5 py-1.5">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <span className={cn("mb-3 flex size-10 items-center justify-center rounded-xl", TONE[filter === "unread" ? "good" : "default"])}>
                {filter === "unread" ? <CheckCheck className="size-5" /> : <BellOff className="size-5" />}
              </span>
              <p className="text-sm font-medium">{filter === "unread" ? "You're all caught up" : "Nothing yet"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Renewal reminders, budget warnings and overdue payments will show up here.</p>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.label}>
                <h3 className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.label}</h3>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <NotificationRow key={item.id} item={item} onOpen={(n) => void openItem(n)} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function setTheme(theme: "light" | "dark" | "system") {
  try {
    localStorage.setItem("ew-theme", theme);
  } catch {}
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  void clientApi("/me/preferences", { method: "PATCH", body: { theme } }).catch(() => undefined);
}

function UserMenu() {
  const { me } = useApp();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Account" />}>
        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          {initials(me.user.name)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 p-1.5">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{me.user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings/profile" />}>
          <User className="size-4" /> Profile
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link href="/settings" />}>
          <Settings className="size-4" /> Settings
        </DropdownMenuItem>
        {me.user.isAdmin && (
          <DropdownMenuItem render={<Link href="/admin" />}>
            <Shield className="size-4" /> Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-wide">Theme</DropdownMenuLabel>
          <div className="flex gap-1 px-1.5 pb-1.5">
            {(
              [
                ["light", Sun],
                ["dark", Moon],
                ["system", Monitor],
              ] as const
            ).map(([theme, Icon]) => (
              <Button key={theme} variant="outline" size="xs" className="flex-1 capitalize" onClick={() => setTheme(theme)}>
                <Icon className="size-3.5" /> {theme}
              </Button>
            ))}
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async () => {
            await signOut();
            router.push("/sign-in");
            router.refresh();
          }}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Top-right of every page: add, ask, alerts, account. */
export function GlobalActions({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <>
        <AskAiButton compact />
        <Notifications compact />
      </>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1 self-center">
      <AddMenu />
      <AskAiButton />
      <Notifications />
      <UserMenu />
    </div>
  );
}
