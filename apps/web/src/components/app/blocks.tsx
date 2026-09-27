"use client";

import {
  AppWindow,
  ArrowDownRight,
  ArrowUpRight,
  BadgeDollarSign,
  Briefcase,
  Building,
  Building2,
  Calculator,
  Car,
  ChevronRight,
  CircleDashed,
  Clapperboard,
  Code,
  CreditCard,
  Droplet,
  Flame,
  FlaskConical,
  Fuel,
  Gift,
  GraduationCap,
  HandHeart,
  Handshake,
  HardHat,
  HeartPulse,
  House,
  KeyRound,
  Landmark,
  Laptop,
  type LucideIcon,
  Megaphone,
  Minus,
  Monitor,
  Package,
  Percent,
  Plane,
  Receipt,
  Repeat,
  Scale,
  Scissors,
  Server,
  Settings,
  ShoppingBag,
  ShoppingBasket,
  Smartphone,
  Sofa,
  Sparkles,
  TrendingUp,
  Users,
  Utensils,
  UtensilsCrossed,
  Wifi,
  Zap,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/cn";

export type Tone = "default" | "good" | "warn" | "danger" | "info";

export const TONE: Record<Tone, string> = {
  default: "bg-muted text-muted-foreground",
  good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "bg-red-500/10 text-red-600 dark:text-red-400",
  info: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

/** One number worth knowing, linking to the records behind it. */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  href,
  valueClassName,
  footer,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  href?: string;
  valueClassName?: string;
  footer?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", TONE[tone])}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <div
        className={cn("mt-1 truncate text-lg font-semibold tabular-nums sm:text-2xl", tone === "danger" && "text-red-600 dark:text-red-400", valueClassName)}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
      {footer}
    </>
  );
  const className = "block h-full min-w-0 rounded-xl border border-border bg-card px-4 py-3 transition-colors";
  return href ? (
    <Link href={href} className={cn(className, "hover:bg-accent/40")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** A titled block with an optional "see all" link. */
export function Section({
  title,
  hint,
  href,
  linkLabel = "View all",
  actions,
  children,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  href?: string;
  linkLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {href && (
            <Link href={href} className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
              {linkLabel}
              <ChevronRight className="size-3.5" />
            </Link>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

/** The quiet in-card empty line. */
export function EmptyNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
      <p>{children}</p>
      {action}
    </div>
  );
}

/** A full empty state with the action that fills it. Never "No data found". */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("rounded-xl border border-dashed border-border bg-card/50", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** Change against a previous period. `goodWhen` says which direction is good. */
export function Delta({ value, goodWhen = "up", suffix = "%" }: { value: number | null | undefined; goodWhen?: "up" | "down"; suffix?: string }) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className="text-xs text-muted-foreground">—</span>;
  if (value === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="size-3" />0{suffix}
      </span>
    );
  }
  const up = value > 0;
  const good = up === (goodWhen === "up");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
      )}
    >
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {Math.abs(value).toFixed(1).replace(/\.0$/, "")}
      {suffix}
    </span>
  );
}

/** Attention pills under the stat row, as on the TeamOS dashboard. */
export function Pill({
  href,
  tone = "warn",
  icon: Icon,
  children,
}: {
  href?: string;
  tone?: "warn" | "danger" | "info" | "good";
  icon: LucideIcon;
  children: ReactNode;
}) {
  const className = cn(
    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
    tone === "warn" && "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300",
    tone === "danger" && "bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300",
    tone === "info" && "bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 dark:text-sky-300",
    tone === "good" && "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300",
  );
  const content = (
    <>
      <Icon className="size-3.5" />
      {children}
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  utensils: Utensils,
  "utensils-crossed": UtensilsCrossed,
  "shopping-basket": ShoppingBasket,
  car: Car,
  fuel: Fuel,
  house: House,
  receipt: Receipt,
  zap: Zap,
  flame: Flame,
  droplet: Droplet,
  wifi: Wifi,
  smartphone: Smartphone,
  "shopping-bag": ShoppingBag,
  "heart-pulse": HeartPulse,
  "graduation-cap": GraduationCap,
  users: Users,
  sofa: Sofa,
  clapperboard: Clapperboard,
  plane: Plane,
  repeat: Repeat,
  sparkles: Sparkles,
  scissors: Scissors,
  "hand-heart": HandHeart,
  percent: Percent,
  landmark: Landmark,
  "trending-up": TrendingUp,
  "circle-dashed": CircleDashed,
  briefcase: Briefcase,
  laptop: Laptop,
  "building-2": Building2,
  "key-round": KeyRound,
  gift: Gift,
  "app-window": AppWindow,
  server: Server,
  megaphone: Megaphone,
  "badge-dollar-sign": BadgeDollarSign,
  code: Code,
  "hard-hat": HardHat,
  settings: Settings,
  building: Building,
  scale: Scale,
  calculator: Calculator,
  monitor: Monitor,
  "flask-conical": FlaskConical,
  "credit-card": CreditCard,
  package: Package,
  handshake: Handshake,
};

export const CATEGORY_TILE: Record<string, string> = {
  orange: "bg-orange-500/15 text-orange-600 dark:text-orange-300",
  sky: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  pink: "bg-pink-500/15 text-pink-600 dark:text-pink-300",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-300",
  indigo: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  teal: "bg-teal-500/15 text-teal-600 dark:text-teal-300",
  stone: "bg-stone-500/15 text-stone-600 dark:text-stone-300",
  purple: "bg-purple-500/15 text-purple-600 dark:text-purple-300",
  cyan: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300",
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  green: "bg-green-500/15 text-green-600 dark:text-green-300",
  lime: "bg-lime-500/15 text-lime-700 dark:text-lime-300",
  red: "bg-red-500/15 text-red-600 dark:text-red-300",
  zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  slate: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
  neutral: "bg-muted text-muted-foreground",
};

export function CategoryIcon({ icon, className }: { icon?: string | null; className?: string }) {
  const Icon = (icon && CATEGORY_ICONS[icon]) || CircleDashed;
  return <Icon className={className} />;
}

/** A coloured tile with the category's icon, as in the expenses breakdown. */
export function CategoryTile({ icon, color, size = "md" }: { icon?: string | null; color?: string | null; size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        size === "sm" ? "size-6" : "size-8",
        CATEGORY_TILE[color ?? "neutral"] ?? CATEGORY_TILE.neutral,
      )}
    >
      <CategoryIcon icon={icon} className={size === "sm" ? "size-3.5" : "size-4"} />
    </span>
  );
}

export function CategoryChip({ name, icon }: { name: string; icon?: string | null }) {
  return (
    <span className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
      <CategoryIcon icon={icon} className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </span>
  );
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "error" | "info" | "secondary" | "outline"> = {
  posted: "success",
  draft: "warning",
  pending: "info",
  void: "secondary",
  active: "success",
  paid: "success",
  overdue: "error",
  partially_paid: "warning",
  cancelled: "secondary",
  failed: "error",
  succeeded: "success",
  partial: "warning",
  running: "info",
  connected: "success",
  error: "error",
  needs_attention: "warning",
  disconnected: "secondary",
  syncing: "info",
  trial: "info",
  renewal_due: "warning",
  expired: "error",
  paused: "secondary",
  scheduled: "outline",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"} className="capitalize">
      {label ?? status.replace(/_/g, " ")}
    </Badge>
  );
}

/** How sure the model or the rules were about a value. */
export function ConfidenceMeter({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(value * 100);
  const tone = value >= 0.9 ? "bg-emerald-500" : value >= 0.75 ? "bg-amber-500" : "bg-red-500";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums", className)} title={`${pct}% confidence`}>
      <span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  );
}

/** A thin progress bar for budgets and goals. */
export function ProgressBar({ value, tone = "default", className }: { value: number; tone?: Tone; className?: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const bar =
    tone === "danger" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : tone === "good" ? "bg-emerald-500" : tone === "info" ? "bg-sky-500" : "bg-primary";
  return (
    <span className={cn("block h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <span className={cn("block h-full rounded-full transition-[width]", bar)} style={{ width: `${clamped}%` }} />
    </span>
  );
}

/** A two-column list of facts on a detail page. */
export function Facts({ items }: { items: Array<{ label: string; value: ReactNode } | null | false> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.filter(Boolean).map((item) => {
        const fact = item as { label: string; value: ReactNode };
        return (
          <div key={fact.label} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/60 pb-2">
            <dt className="shrink-0 text-muted-foreground text-xs">{fact.label}</dt>
            <dd className="min-w-0 truncate text-right">{fact.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
