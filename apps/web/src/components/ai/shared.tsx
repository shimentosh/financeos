"use client";

import { AlertTriangle, Camera, FileText, Info, type LucideIcon, Mic, Receipt, ShieldAlert, Sparkles, Type } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useApp } from "@/components/app/app-context";
import { Badge } from "@/components/ui/badge";
import type { AiStatusView, CaptureKind, CaptureStage, ConfidenceSource } from "@/lib/api/types/ai";
import { cn } from "@/lib/cn";

/** A drill-down to exact transactions, whatever their dates. */
export function transactionsHref(ids: string[]): string {
  return `/transactions?ids=${ids.join(",")}&period=all_time`;
}

/** AI spend is dollars and fractions of a cent, not ledger money. */
export function usd(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined) return "—";
  const places = digits ?? (value > 0 && value < 1 ? 4 : 2);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: places }).format(value);
}

export const STAGE_LABELS: Record<CaptureStage, string> = {
  received: "Reading",
  processing: "Reading",
  suggested: "Needs review",
  confirmed: "Posted",
  posted: "Auto-posted",
  failed: "Couldn't read",
  discarded: "Discarded",
};

const STAGE_VARIANT: Record<CaptureStage, "success" | "warning" | "error" | "info" | "secondary"> = {
  received: "info",
  processing: "info",
  suggested: "warning",
  confirmed: "success",
  posted: "success",
  failed: "error",
  discarded: "secondary",
};

export function StageBadge({ stage }: { stage: CaptureStage }) {
  return <Badge variant={STAGE_VARIANT[stage]}>{STAGE_LABELS[stage]}</Badge>;
}

export const CAPTURE_KIND: Record<CaptureKind, { label: string; icon: LucideIcon }> = {
  screenshot: { label: "Screenshot", icon: Camera },
  receipt: { label: "Receipt", icon: Receipt },
  pdf: { label: "PDF", icon: FileText },
  text: { label: "Text", icon: Type },
  voice: { label: "Voice", icon: Mic },
  email: { label: "Email", icon: FileText },
};

const SOURCE_LABELS: Record<ConfidenceSource, string> = {
  rule: "from a rule",
  merchant: "from merchant memory",
  ai: "AI",
  parser: "from your words",
  user: "you",
};

/** Where a suggested value came from. Rules and memory outrank the model. */
export function SourceTag({ source, className }: { source: ConfidenceSource | null | undefined; className?: string }) {
  if (!source) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded px-1 py-px text-[10px] font-medium leading-4",
        source === "ai" ? "bg-violet-500/10 text-violet-700 dark:text-violet-300" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {source === "ai" && <Sparkles className="size-2.5" />}
      {SOURCE_LABELS[source]}
    </span>
  );
}

const REASON_TEXT: Record<NonNullable<AiStatusView["reason"]>, string> = {
  not_configured: "AI isn't set up on this server.",
  disabled: "AI is turned off for this workspace.",
  budget: "This month's AI budget is used up.",
  credits: "The AI credits are used up.",
};

/**
 * Says plainly what still works when the model is unavailable: notes are read
 * by the built-in parser, files are kept for manual entry.
 */
export function AiAvailabilityNotice({ status, className }: { status: AiStatusView | null; className?: string }) {
  const { canManage } = useApp();
  if (!status || status.available) return null;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm", className)}>
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{status.reason ? REASON_TEXT[status.reason] : "AI is unavailable right now."}</p>
        <p className="text-muted-foreground text-xs">
          Text and voice notes are still read by the built-in parser. Screenshots, receipts and PDFs are saved so you can enter the details beside them.
          {status.reason === "credits" ? (
            <>
              {" "}
              <Link href="/settings/billing" className="underline underline-offset-4 hover:text-foreground">
                Get more credits
              </Link>
            </>
          ) : (
            canManage && (
              <>
                {" "}
                <Link href="/settings/ai" className="underline underline-offset-4 hover:text-foreground">
                  AI settings
                </Link>
              </>
            )
          )}
        </p>
      </div>
    </div>
  );
}

/** A quiet coloured strip with an icon, for notes and warnings inside a card. */
export function Callout({
  tone = "info",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "warn" | "danger";
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = icon ?? (tone === "info" ? Info : AlertTriangle);
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-3 py-2 text-sm",
        tone === "info" && "bg-sky-500/8 text-sky-900 dark:text-sky-200",
        tone === "warn" && "border border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-200",
        tone === "danger" && "border border-red-500/30 bg-red-500/5 text-red-900 dark:text-red-200",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 opacity-80" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-xs opacity-90">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Segmented tabs, as used across reports: `bg-muted/50 p-1` with a raised active tab. */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  className,
  size = "sm",
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: string; icon?: LucideIcon; count?: number }>;
  className?: string;
  size?: "sm" | "md";
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex items-center gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1", className)}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-md transition-colors",
              // md tabs share the row: on a phone they shrink and drop their icons instead of overflowing.
              size === "md" ? "min-w-0 flex-1 px-1.5 py-1.5 text-[13px] sm:px-3 sm:text-sm" : "shrink-0 px-2.5 py-1 text-xs",
              active ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className={size === "md" ? "hidden size-4 shrink-0 sm:block" : "size-3.5"} />}
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
