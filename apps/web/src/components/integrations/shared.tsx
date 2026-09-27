"use client";

import {
  Banknote,
  BookOpen,
  BookOpenCheck,
  Check,
  Citrus,
  Copy,
  CreditCard,
  FileSpreadsheet,
  Globe,
  Kanban,
  Landmark,
  type LucideIcon,
  Plug,
  ShoppingBag,
  Smartphone,
  Users,
  Wallet,
  Webhook,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { TONE, type Tone } from "@/components/app/blocks";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ConnectionHealth, ConnectorCategory, SyncTrigger } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

/** Catalog `icon` names (lucide) to components. Unknown names fall back to a plug. */
const PROVIDER_ICONS: Record<string, LucideIcon> = {
  landmark: Landmark,
  "credit-card": CreditCard,
  plug: Plug,
  webhook: Webhook,
  wallet: Wallet,
  globe: Globe,
  banknote: Banknote,
  citrus: Citrus,
  "shopping-bag": ShoppingBag,
  smartphone: Smartphone,
  "book-open": BookOpen,
  "book-open-check": BookOpenCheck,
  users: Users,
  kanban: Kanban,
  "file-spreadsheet": FileSpreadsheet,
};

export function providerIcon(name: string | null | undefined): LucideIcon {
  return (name && PROVIDER_ICONS[name]) || Plug;
}

const CATEGORY_TONE: Record<ConnectorCategory, string> = {
  payments: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  banking: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  accounting: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  crm: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  projects: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  ecommerce: "bg-pink-500/15 text-pink-600 dark:text-pink-300",
  custom: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
};

export const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  payments: "Payments",
  banking: "Banks & wallets",
  accounting: "Accounting",
  crm: "CRM",
  projects: "Projects",
  ecommerce: "E-commerce",
  custom: "Your own apps",
};

export const CATEGORY_ORDER: ConnectorCategory[] = ["banking", "payments", "ecommerce", "accounting", "crm", "projects", "custom"];

/** The tone-tinted icon tile for a provider. */
export function ProviderTile({ icon, category, size = "md" }: { icon: string; category: ConnectorCategory; size?: "sm" | "md" | "lg" }) {
  const Icon = providerIcon(icon);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        size === "sm" ? "size-7" : size === "lg" ? "size-11 rounded-xl" : "size-9",
        CATEGORY_TONE[category] ?? CATEGORY_TONE.custom,
      )}
    >
      <Icon className={size === "sm" ? "size-3.5" : size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}

const HEALTH: Record<ConnectionHealth, { label: string; tone: Tone; hint: string }> = {
  healthy: { label: "Healthy", tone: "good", hint: "The last sync succeeded" },
  syncing: { label: "Syncing", tone: "info", hint: "A sync is running now" },
  pending: { label: "First sync pending", tone: "info", hint: "Waiting for its first sync" },
  stale: { label: "Stale", tone: "warn", hint: "No successful sync for a while" },
  degraded: { label: "Degraded", tone: "warn", hint: "Some records or syncs failed" },
  failing: { label: "Failing", tone: "danger", hint: "Syncs keep failing: check the credentials" },
  disconnected: { label: "Disconnected", tone: "default", hint: "Credentials removed; history kept" },
};

export function healthTone(health: ConnectionHealth): Tone {
  return HEALTH[health]?.tone ?? "default";
}

export function HealthBadge({ health, className }: { health: ConnectionHealth; className?: string }) {
  const meta = HEALTH[health] ?? HEALTH.healthy;
  return (
    <span title={meta.hint} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[meta.tone], className)}>
      <span className="size-1.5 rounded-full bg-current" />
      {meta.label}
    </span>
  );
}

export const TRIGGER_LABEL: Record<SyncTrigger, string> = {
  initial: "Initial",
  incremental: "Continued",
  manual: "Manual",
  scheduled: "Scheduled",
  webhook: "Webhook",
  retry: "Retry",
};

export const FREQUENCY_LABEL: Record<string, string> = { manual: "Only when I sync", hourly: "Every hour", daily: "Once a day" };

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export async function copyText(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Copy failed: select the text and copy it by hand");
  }
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      className={className}
      onClick={() => {
        void copyText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/** A monospace value with a copy button: URLs, secrets, keys. */
export function CopyField({ label, value, secret, hint }: { label: string; value: string; secret?: boolean; hint?: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div
        className={cn("flex items-center gap-1 rounded-lg border border-border bg-muted/40 py-1 ps-2.5 pe-1", secret && "border-amber-500/40 bg-amber-500/5")}
      >
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A code sample with a copy button. */
export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-border bg-muted/40", className)}>
      {language && <span className="absolute top-1.5 left-2.5 text-[10px] uppercase tracking-wide text-muted-foreground">{language}</span>}
      <CopyButton value={code} label="Copy code" className="absolute top-1 right-1" />
      <pre className={cn("overflow-x-auto p-3 pe-9 font-mono text-xs leading-relaxed", language && "pt-6")}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** A stop-sign confirmation (delete, disconnect, revoke, revert). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  destructive = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  destructive?: boolean;
  children?: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children && <div className="space-y-3 px-6 pb-4">{children}</div>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>Cancel</AlertDialogClose>
          <Button variant={destructive ? "destructive" : "default"} size="sm" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Small capability chips on catalog cards. */
export function CapabilityChips({ capabilities }: { capabilities: { sync: boolean; webhook: boolean; import: boolean } }) {
  const chips = [capabilities.sync && "Sync", capabilities.webhook && "Webhooks", capabilities.import && "File import"].filter(Boolean) as string[];
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <Badge key={chip} variant="outline" size="sm">
          {chip}
        </Badge>
      ))}
    </span>
  );
}

/** A link to transactions in the web app: the list filtered to these ids. */
export function transactionsHref(ids: string[]): string {
  return `/transactions?period=all_time&ids=${ids.join(",")}`;
}
