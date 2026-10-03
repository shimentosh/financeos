import type { WorkspaceKind } from "@financeos/core";
import {
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  Bot,
  Briefcase,
  CalendarClock,
  Car,
  ChartLine,
  ChartPie,
  FolderKanban,
  Gem,
  HandCoins,
  History,
  Inbox,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  type LucideIcon,
  PiggyBank,
  Plug,
  Receipt,
  Scale,
  Target,
  Upload,
  Wallet,
} from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Shown only in these workspace kinds. */
  kinds?: WorkspaceKind[];
  /** A live count from the shell (e.g. AI Inbox). */
  badge?: "inbox";
  /** Also active for these path prefixes. */
  match?: string[];
};

export type NavGroup = { id: string; title: string; items: NavItem[]; kinds?: WorkspaceKind[] };

// The sidebar holds only the parent pages. Their sub-pages are tabs (SECTIONS below), and
// set-up screens — integrations, AI, categories, rules — live in Settings.
export const NAV: NavGroup[] = [
  {
    id: "home",
    title: "Home",
    items: [
      { title: "Overview", href: "/", icon: LayoutDashboard },
      { title: "AI Inbox", href: "/ai/inbox", icon: Inbox, badge: "inbox" },
      { title: "Insights", href: "/ai/insights", icon: Lightbulb, match: ["/ai/copilot", "/ai/forecasts", "/reports"] },
    ],
  },
  {
    id: "money",
    title: "Money",
    items: [
      { title: "Transactions", href: "/transactions", icon: ArrowLeftRight, match: ["/income", "/expenses", "/transfers"] },
      { title: "Accounts", href: "/accounts", icon: Wallet },
      { title: "Planning", href: "/subscriptions", icon: CalendarClock, match: ["/subscriptions", "/commitments", "/budgets"] },
      { title: "Business", href: "/business/projects", icon: Briefcase, kinds: ["business"], match: ["/business"] },
    ],
  },
  {
    id: "grow",
    title: "Grow",
    items: [
      { title: "Wealth", href: "/wealth/net-worth", icon: Scale, match: ["/wealth"] },
      { title: "Goals", href: "/goals", icon: Target },
    ],
  },
];

export type SectionTab = { title: string; href: string; icon: LucideIcon; kinds?: WorkspaceKind[] };

/**
 * Parent pages and the tabs that switch between their sub-pages. A page whose path is
 * one of these tabs shows the tab bar; detail pages (/wealth/assets/[id]) do not.
 * `settings` sections render inside the Settings frame instead of under the header.
 */
export const SECTIONS: Array<{ id: string; title: string; tabs: SectionTab[]; settings?: boolean }> = [
  {
    id: "planning",
    title: "Planning",
    tabs: [
      { title: "Subscriptions", href: "/subscriptions", icon: Receipt },
      { title: "Commitments", href: "/commitments", icon: CalendarClock },
      { title: "Budgets", href: "/budgets", icon: PiggyBank },
    ],
  },
  {
    id: "business",
    title: "Business",
    tabs: [
      { title: "Projects", href: "/business/projects", icon: FolderKanban },
      { title: "Revenue", href: "/business/revenue", icon: BadgeDollarSign },
    ],
  },
  {
    id: "wealth",
    title: "Wealth",
    tabs: [
      { title: "Net worth", href: "/wealth/net-worth", icon: Scale },
      { title: "Assets", href: "/wealth/assets", icon: Car },
      { title: "Investments", href: "/wealth/investments", icon: ChartLine },
      { title: "Liabilities", href: "/wealth/liabilities", icon: Landmark },
      { title: "Receivables", href: "/wealth/receivables", icon: HandCoins },
    ],
  },
  {
    id: "goals",
    title: "Goals",
    tabs: [
      { title: "Goals", href: "/goals", icon: Target },
      { title: "Dream assets", href: "/goals/dream-assets", icon: Gem, kinds: ["personal"] },
      { title: "Savings plans", href: "/goals/savings-plans", icon: Banknote },
    ],
  },
  {
    id: "insights",
    title: "Insights",
    tabs: [
      { title: "Insights", href: "/ai/insights", icon: Lightbulb },
      { title: "Copilot", href: "/ai/copilot", icon: Bot },
      { title: "Forecast", href: "/ai/forecasts", icon: BarChart3 },
      { title: "Reports", href: "/reports", icon: ChartPie },
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    settings: true,
    tabs: [
      { title: "Connected apps", href: "/integrations", icon: Plug },
      { title: "Import", href: "/integrations/import", icon: Upload },
      { title: "Sync history", href: "/integrations/sync-history", icon: History },
      { title: "API & webhooks", href: "/integrations/api", icon: KeyRound },
    ],
  },
];

/** The section whose tab is exactly this path, with its tabs for this workspace kind. */
export function sectionFor(pathname: string, kind: WorkspaceKind) {
  const section = SECTIONS.find((s) => s.tabs.some((tab) => tab.href === pathname));
  if (!section) return null;
  return { ...section, tabs: section.tabs.filter((tab) => !tab.kinds || tab.kinds.includes(kind)) };
}

/** Every page worth jumping to (⌘K): the sidebar items and every tab. */
export function destinations(kind: WorkspaceKind): Array<{ title: string; href: string; icon: LucideIcon; group: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; href: string; icon: LucideIcon; group: string }> = [];
  const add = (item: { title: string; href: string; icon: LucideIcon }, group: string) => {
    if (seen.has(item.href)) return;
    seen.add(item.href);
    out.push({ ...item, group });
  };
  for (const group of navFor(kind)) for (const item of group.items) add(item, group.title);
  for (const section of SECTIONS) {
    if (section.id === "business" && kind !== "business") continue;
    for (const tab of section.tabs) if (!tab.kinds || tab.kinds.includes(kind)) add(tab, section.title);
  }
  return out;
}

export function navFor(kind: WorkspaceKind): NavGroup[] {
  return NAV.filter((group) => !group.kinds || group.kinds.includes(kind))
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.kinds || item.kinds.includes(kind)) }))
    .filter((group) => group.items.length > 0);
}

/** The most specific nav item for a path (for active state and titles). */
export function activeHref(pathname: string, groups: NavGroup[]): string | null {
  let best: string | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      const hit =
        item.href === "/"
          ? pathname === "/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`) || item.match?.some((prefix) => pathname.startsWith(prefix));
      if (hit && (!best || item.href.length > best.length)) best = item.href;
    }
  }
  return best;
}

export { Briefcase };
