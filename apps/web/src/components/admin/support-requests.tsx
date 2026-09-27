"use client";

import type { SupportStatus } from "@expensewise/core";
import { CheckCircle2, Inbox, Mail, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

export type SupportRequestRow = {
  id: string;
  userId: string | null;
  workspaceId: string | null;
  email: string;
  name: string | null;
  subject: string;
  message: string;
  page: string | null;
  status: SupportStatus;
  createdAt: string;
};

export type SupportList = { items: SupportRequestRow[]; total: number; page: number; pageSize: number; counts: Partial<Record<SupportStatus, number>> };

/** Admin → Support: messages from the contact page and the in-app help form. */
export function SupportRequests({ data, status, focus }: { data: SupportList; status: SupportStatus | null; focus: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(focus);

  const setStatus = async (id: string, next: SupportStatus) => {
    setBusy(id);
    try {
      await clientApi("/admin/support", { method: "PATCH", body: { ids: [id], status: next } });
      toast.success(next === "closed" ? "Marked as done" : "Reopened");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const tabs: Array<{ value: SupportStatus | null; label: string; count?: number }> = [
    { value: "open", label: "Open", count: data.counts.open ?? 0 },
    { value: "closed", label: "Done", count: data.counts.closed ?? 0 },
    { value: null, label: "All" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={tab.value ? `/admin/support?status=${tab.value}` : "/admin/support?status=all"}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm transition-colors",
              status === tab.value ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && <span className="ms-1.5 text-xs text-muted-foreground tabular-nums">{tab.count}</span>}
          </Link>
        ))}
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={status === "open" ? "No open requests" : "No requests here"}
          description="Messages from the contact page and the in-app Help & support form appear here, and are also emailed to SUPPORT_EMAIL."
          action={
            status !== null ? (
              <Button size="sm" variant="outline" render={<Link href="/admin/support?status=all" />}>
                Show all requests
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {data.items.map((item) => {
            const open = expanded === item.id;
            return (
              <li key={item.id} className="p-4">
                <button
                  type="button"
                  className="flex w-full items-start gap-3 text-left"
                  onClick={() => setExpanded(open ? null : item.id)}
                  aria-expanded={open}
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.status === "open" ? "bg-amber-500" : "bg-emerald-500")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.subject}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.name ? `${item.name} · ` : ""}
                      {item.email} · {timeAgo(item.createdAt)}
                      {item.userId ? " · signed in" : ""}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="mt-3 space-y-3 ps-5">
                    <p className="whitespace-pre-wrap rounded-lg bg-muted/40 px-3 py-2 text-sm">{item.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(item.createdAt)}
                      {item.page ? ` · sent from ${item.page}` : ""} · ref {item.id.slice(-8).toUpperCase()}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" render={<a href={`mailto:${item.email}?subject=${encodeURIComponent(`Re: ${item.subject}`)}`} />}>
                        <Mail aria-hidden /> Reply by email
                      </Button>
                      {item.status === "open" ? (
                        <Button size="sm" onClick={() => setStatus(item.id, "closed")} loading={busy === item.id}>
                          <CheckCircle2 aria-hidden /> Mark as done
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setStatus(item.id, "open")} loading={busy === item.id}>
                          <RotateCcw aria-hidden /> Reopen
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
