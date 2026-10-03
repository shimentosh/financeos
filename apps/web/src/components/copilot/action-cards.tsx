"use client";

import type { CopilotAction, CopilotActionKind, CopilotActionOutcome, CopilotMessageView } from "@financeos/core";
import {
  AlertTriangle,
  ArrowUpRight,
  Brain,
  Briefcase,
  Check,
  CreditCard,
  FolderPlus,
  HandCoins,
  Loader2,
  type LucideIcon,
  Pencil,
  PiggyBank,
  Receipt,
  Repeat,
  Target,
  Wallet,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";

const ICONS: Record<CopilotActionKind, LucideIcon> = {
  record_transaction: Receipt,
  update_transaction: Pencil,
  create_category: FolderPlus,
  create_account: Wallet,
  create_project: Briefcase,
  create_subscription: Repeat,
  create_recurring: Repeat,
  create_budget: PiggyBank,
  create_goal: Target,
  create_rule: Wand2,
  create_receivable: HandCoins,
  create_liability: CreditCard,
};

const open = (action: CopilotAction) => action.status === "proposed" || action.status === "failed";

/**
 * The changes an answer suggests, each a card the user confirms or discards.
 * Nothing reaches the books until Confirm; the card then links to the record.
 */
export function ActionCards({
  message,
  canWrite,
  onUpdate,
}: {
  message: CopilotMessageView;
  canWrite: boolean;
  onUpdate: (message: CopilotMessageView) => void;
}) {
  const router = useRouter();
  const actions = message.data.actions ?? [];
  const pending = actions.filter(open);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (kind: "apply" | "discard", ids?: string[]) => {
    setBusy(ids?.length === 1 ? `${kind}:${ids[0]}` : kind);
    try {
      const outcome = await clientApi<CopilotActionOutcome>(`/copilot/messages/${message.id}/actions/${kind}`, {
        method: "POST",
        body: ids ? { actionIds: ids } : {},
      });
      onUpdate(outcome.message);
      if (kind === "apply") {
        const saved = outcome.actions.filter((a) => a.status === "applied");
        const failed = outcome.actions.filter((a) => a.status === "failed");
        if (saved.length) toast.success(saved.length === 1 ? `Saved: ${saved[0]?.summary}` : `${saved.length} changes saved`);
        if (failed.length) toast.error(failed[0]?.error ?? "Couldn't save that");
        // Lists elsewhere in the app now have new records.
        invalidateApiCache();
        router.refresh();
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  if (!actions.length) return null;
  return (
    <div className="space-y-2">
      {actions.map((action) => (
        <ActionCard
          key={action.id}
          action={action}
          all={actions}
          canWrite={canWrite}
          busy={busy}
          onConfirm={() => run("apply", [action.id])}
          onDiscard={() => run("discard", [action.id])}
        />
      ))}
      {canWrite && pending.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => run("apply")} loading={busy === "apply"} disabled={Boolean(busy)}>
            <Check aria-hidden /> Confirm all {pending.length}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => run("discard")} loading={busy === "discard"} disabled={Boolean(busy)}>
            Discard all
          </Button>
        </div>
      )}
    </div>
  );
}

function ActionCard({
  action,
  all,
  canWrite,
  busy,
  onConfirm,
  onDiscard,
}: {
  action: CopilotAction;
  all: CopilotAction[];
  canWrite: boolean;
  busy: string | null;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const Icon = ICONS[action.kind] ?? Receipt;
  const needs = action.dependsOn.map((id) => all.find((a) => a.id === id)).filter((a): a is CopilotAction => Boolean(a && a.status !== "applied"));
  const [expanded, setExpanded] = useState(action.details.length <= 6);
  const details = expanded ? action.details : action.details.slice(0, 4);
  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-colors",
        action.status === "proposed" && "border-violet-500/30 bg-violet-500/[0.03]",
        action.status === "applying" && "border-border bg-card",
        action.status === "applied" && "border-emerald-500/30 bg-emerald-500/[0.04]",
        action.status === "failed" && "border-red-500/30 bg-red-500/[0.04]",
        action.status === "discarded" && "border-border bg-muted/30 opacity-70",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg",
            action.status === "applied" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-violet-500/10 text-violet-600 dark:text-violet-400",
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
            {action.title}
            <StatusPill action={action} />
          </p>
          <p className={cn("text-sm tabular-nums text-muted-foreground", action.status === "discarded" && "line-through")}>{action.summary}</p>
        </div>
      </div>

      {action.status !== "discarded" && details.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border/60 pt-2.5 text-xs">
          {details.map((detail) => (
            <div key={`${detail.label}-${detail.value}`} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words tabular-nums">{detail.value}</dd>
            </div>
          ))}
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="col-span-2 justify-self-start text-muted-foreground underline-offset-2 hover:underline"
            >
              {action.details.length - 4} more
            </button>
          )}
        </dl>
      )}

      {open(action) && action.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {action.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {warning}
            </li>
          ))}
        </ul>
      )}
      {open(action) && needs.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Confirming also saves: {needs.map((a) => a.summary).join("; ")}</p>
      )}
      {action.status === "failed" && action.error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{action.error}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {open(action) && canWrite && (
          <>
            <Button size="xs" onClick={onConfirm} loading={busy === `apply:${action.id}`} disabled={Boolean(busy)}>
              <Check aria-hidden /> {action.status === "failed" ? "Try again" : "Confirm"}
            </Button>
            <Button size="xs" variant="ghost" onClick={onDiscard} loading={busy === `discard:${action.id}`} disabled={Boolean(busy)}>
              <X aria-hidden /> Discard
            </Button>
          </>
        )}
        {open(action) && !canWrite && <span className="text-xs text-muted-foreground">Someone with edit access can confirm this.</span>}
        {action.status === "applied" && action.result?.href && (
          <Link
            href={action.result.href}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Open {action.result.label} <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}

function StatusPill({ action }: { action: CopilotAction }) {
  const pill = "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-normal";
  if (action.status === "proposed") return <span className={cn(pill, "bg-violet-500/10 text-violet-700 dark:text-violet-300")}>Not saved yet</span>;
  if (action.status === "applying")
    return (
      <span className={cn(pill, "bg-muted text-muted-foreground")}>
        <Loader2 className="size-3 animate-spin" aria-hidden /> Saving
      </span>
    );
  if (action.status === "applied")
    return (
      <span className={cn(pill, "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>
        <Check className="size-3" aria-hidden /> Saved
      </span>
    );
  if (action.status === "failed") return <span className={cn(pill, "bg-red-500/10 text-red-700 dark:text-red-400")}>Not saved</span>;
  return <span className={cn(pill, "bg-muted text-muted-foreground")}>Discarded</span>;
}

/** Notes saved to the assistant's memory in this answer. */
export function RememberedNotes({ items }: { items: Array<{ id: string; text: string }> }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <span key={item.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          <Brain className="size-3 shrink-0" aria-hidden />
          <span className="truncate">Remembered: {item.text}</span>
        </span>
      ))}
      <Link href="/settings/ai#memory" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        Manage
      </Link>
    </div>
  );
}
