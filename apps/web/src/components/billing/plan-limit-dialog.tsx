"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { PLAN_LIMIT_EVENT, type PlanLimitEventDetail } from "@/lib/api/types/billing";
import { formatBytes } from "@/lib/format";

const TITLES: Record<string, string> = {
  workspaces: "You've reached your workspace limit",
  membersPerWorkspace: "This workspace is full",
  storageBytes: "Your storage is full",
  apiAccess: "API access is on paid plans",
  integrations: "Connections are on paid plans",
  aiCredits: "You're out of AI credits",
};

function usage(detail: PlanLimitEventDetail) {
  const d = detail.details;
  if (!d || d.used === undefined || d.allowed === undefined || d.allowed === null) return null;
  return d.limit === "storageBytes"
    ? `${formatBytes(d.used)} of ${formatBytes(d.allowed)} used`
    : `${d.used.toLocaleString()} of ${d.allowed.toLocaleString()} used`;
}

/**
 * One dialog for the whole app: any request refused with HTTP 402
 * `plan_limit` (a workspace, an invitation, an upload, an API key…) says
 * which limit was reached and offers the plans.
 */
export function PlanLimitDialog() {
  const [detail, setDetail] = useState<PlanLimitEventDetail | null>(null);

  useEffect(() => {
    const onLimit = (event: Event) => setDetail((event as CustomEvent<PlanLimitEventDetail>).detail);
    window.addEventListener(PLAN_LIMIT_EVENT, onLimit);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, onLimit);
  }, []);

  const used = detail ? usage(detail) : null;
  return (
    <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <DialogTitle>{TITLES[detail?.details?.limit ?? ""] ?? "That's beyond your plan"}</DialogTitle>
          <DialogDescription>{detail?.message}</DialogDescription>
        </DialogHeader>
        {used && (
          <DialogPanel>
            <p className="text-sm text-muted-foreground tabular-nums">{used}</p>
          </DialogPanel>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
            Not now
          </Button>
          <Button size="sm" render={<Link href="/settings/billing" />} onClick={() => setDetail(null)}>
            See plans
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
