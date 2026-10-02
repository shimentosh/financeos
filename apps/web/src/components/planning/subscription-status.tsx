"use client";

import type { SubscriptionStatus } from "@expensewise/core";
import { Ban, Check, ChevronDown, Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { ConfirmDialog } from "./occurrence-history";
import { Field } from "./shared";

export type Tone = "green" | "blue" | "amber" | "orange" | "red" | "gray";

export const TONES: Record<Tone, { pill: string; dot: string }> = {
  green: { pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", dot: "bg-emerald-500" },
  blue: { pill: "bg-sky-500/10 text-sky-700 dark:text-sky-400", dot: "bg-sky-500" },
  amber: { pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  orange: { pill: "bg-orange-500/10 text-orange-700 dark:text-orange-400", dot: "bg-orange-500" },
  red: { pill: "bg-red-500/10 text-red-700 dark:text-red-400", dot: "bg-red-500" },
  gray: { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/60" },
};

const STATUS_TONES: Record<SubscriptionStatus, Tone> = {
  active: "green",
  renewed: "green",
  trial: "blue",
  renewal_due: "amber",
  cancellation_pending: "orange",
  cancelled: "gray",
  paused: "gray",
  expired: "red",
};

export function statusTone(status: SubscriptionStatus) {
  return TONES[STATUS_TONES[status] ?? "gray"];
}

type StatusSubject = {
  id: string;
  name: string;
  derivedStatus: SubscriptionStatus;
  statusLabel: string;
  expiryDate: string | null;
  nextRenewalDate: string | null;
};

/**
 * The subscription's status as a coloured pill. For people who can write it
 * is also the place to change it: pause, resume, cancel or reactivate.
 */
export function StatusMenu({ subscription: s, today }: { subscription: StatusSubject; today: string }) {
  const { canWrite } = useApp();
  const router = useRouter();
  const id = useId();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(s.expiryDate ?? s.nextRenewalDate ?? today);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const tone = statusTone(s.derivedStatus);

  const stopped = s.derivedStatus === "cancelled" || s.derivedStatus === "cancellation_pending" || s.derivedStatus === "expired";
  const paused = s.derivedStatus === "paused";

  const act = async (action: "pause" | "resume" | "cancel", message: string, body?: unknown) => {
    setBusy(true);
    try {
      await clientApi(`/subscriptions/${s.id}/${action}`, { method: "POST", body });
      toast.success(message);
      invalidateApiCache("/subscriptions");
      router.refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (await act("cancel", "Subscription cancelled; the history is kept", { effectiveDate: effectiveDate || null, reason: reason.trim() || null })) {
      setCancelOpen(false);
    }
  };

  const pill = (
    <>
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {s.statusLabel}
    </>
  );
  const pillClass = cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", tone.pill);

  if (!canWrite) return <span className={pillClass}>{pill}</span>;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Status: ${s.statusLabel}. Change status`}
              className={cn(pillClass, "relative z-10 cursor-pointer transition hover:ring-2 hover:ring-current/20", busy && "opacity-60")}
              onClick={(e) => e.stopPropagation()}
            />
          }
        >
          {pill}
          <ChevronDown className="size-3 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Change status</p>
          {paused || stopped ? (
            <DropdownMenuItem onClick={() => void act("resume", stopped ? "Reactivated" : "Active again; reminders are back")}>
              <Play className="size-3.5" /> {stopped ? "Reactivate" : "Active — resume"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              <Check className="size-3.5" /> Active
            </DropdownMenuItem>
          )}
          {!stopped && !paused && (
            <DropdownMenuItem onClick={() => void act("pause", "Paused; reminders stop until you resume")}>
              <Pause className="size-3.5" /> Pause — stop reminders for now
            </DropdownMenuItem>
          )}
          {!stopped && (
            <DropdownMenuItem onClick={() => setCancelOpen(true)}>
              <Ban className="size-3.5" /> Cancel subscription…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel ${s.name}?`}
        description="Renewals and reminders stop. You'll still get a notice before access ends, and the payment history stays."
        confirmLabel="Cancel subscription"
        busy={busy}
        onConfirm={() => void cancel()}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Access ends" htmlFor={`${id}-effective`}>
            <Input id={`${id}-effective`} type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </Field>
          <Field label="Reason" htmlFor={`${id}-reason`}>
            <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}
