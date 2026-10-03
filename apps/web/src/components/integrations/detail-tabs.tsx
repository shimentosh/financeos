"use client";

import { TRANSACTION_TYPES, TYPE_LABELS } from "@financeos/core";
import { ChevronLeft, ChevronRight, History, ListChecks, RefreshCw, Search, Send, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CategoryChip, EmptyNote, EmptyState, StatusBadge } from "@/components/app/blocks";
import { TransactionDetailDrawer } from "@/components/transactions/transaction-detail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { TransactionListItem } from "@/lib/api/types";
import type { Page, RecordsPage, RunSummary, WebhookEventView } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { formatDateTime, formatDay, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/use-api";
import { RunDetailDialog, RunsTable } from "./runs";

const ALL = "__all__";

const STATUS_OPTIONS = [
  { value: ALL, label: "Any status" },
  { value: "posted", label: "Posted" },
  { value: "draft,pending", label: "Needs review" },
  { value: "void", label: "Voided" },
];

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const { locale } = useApp();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span className="tabular-nums">
        {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total.toLocaleString(locale)}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-3.5" /> Previous
        </Button>
        <Button variant="outline" size="xs" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {["a", "b", "c", "d", "e"].map((key) => (
        <Skeleton key={key} className="h-10 rounded-lg" />
      ))}
    </div>
  );
}

/** Transactions this connection imported, with the same look as the ledger list. */
export function RecordsTab({ connectionId, initialStatus }: { connectionId: string; initialStatus: string | null }) {
  const [status, setStatus] = useState(STATUS_OPTIONS.some((o) => o.value === initialStatus) ? (initialStatus as string) : ALL);
  const [type, setType] = useState(ALL);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, loading, error, reload } = useApi<RecordsPage>(`/integrations/${connectionId}/records`, {
    page,
    pageSize: 50,
    status: status === ALL ? undefined : status,
    type: type === ALL ? undefined : type,
    q: q || undefined,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onValueChange={(v) => {
            if (typeof v !== "string") return;
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue>{STATUS_OPTIONS.find((o) => o.value === status)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={type}
          onValueChange={(v) => {
            if (typeof v !== "string") return;
            setType(v);
            setPage(1);
          }}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue>{type === ALL ? "Any type" : TYPE_LABELS[type as keyof typeof TYPE_LABELS]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any type</SelectItem>
            {TRANSACTION_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative ms-auto w-full sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Merchant, reference, external id…"
            aria-label="Search records"
            className="pl-7"
          />
        </div>
      </div>

      {error ? (
        <EmptyNote
          action={
            <Button size="xs" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          }
        >
          {error.message}
        </EmptyNote>
      ) : !data && loading ? (
        <TableSkeleton />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={status !== ALL || type !== ALL || q ? "Nothing matches these filters" : "Nothing imported yet"}
          description={status !== ALL || type !== ALL || q ? "Clear a filter to see more." : "Records appear here after the first sync or webhook event."}
        />
      ) : data ? (
        <>
          <div className={cn("overflow-x-auto rounded-lg border border-border transition-opacity", loading && "opacity-70")}>
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                  <th className="hidden w-28 md:table-cell">Date</th>
                  <th>Description</th>
                  <th className="hidden w-40 lg:table-cell">External id</th>
                  <th className="hidden w-36 md:table-cell">Account</th>
                  <th className="w-36 text-right!">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((tx) => (
                  <RecordRow key={tx.id} tx={tx} onOpen={() => setSelected(tx.id)} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      ) : null}
      <TransactionDetailDrawer
        id={selected}
        onClose={() => {
          setSelected(null);
          void reload();
        }}
      />
    </div>
  );
}

function RecordRow({ tx, onOpen }: { tx: TransactionListItem; onOpen: () => void }) {
  const { money } = useApp();
  const incoming = tx.type !== "transfer" && tx.direction === "in";
  const title =
    tx.type === "transfer"
      ? `${tx.accountName ?? "?"} → ${tx.toAccountName ?? "?"}`
      : (tx.counterpartyName ?? tx.merchant ?? tx.description ?? TYPE_LABELS[tx.type]);
  return (
    <tr onClick={onOpen} className="cursor-pointer transition-colors hover:bg-accent/40 [&>td]:px-3 [&>td]:py-2">
      <td className="hidden text-xs tabular-nums text-muted-foreground md:table-cell">{formatDay(tx.date)}</td>
      <td className="max-w-0">
        <p className="text-xs tabular-nums text-muted-foreground md:hidden">{formatDay(tx.date)}</p>
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate font-medium", tx.status === "void" && "text-muted-foreground line-through")}>{title}</span>
          {tx.categoryName && <CategoryChip name={tx.categoryName} icon={tx.categoryIcon} />}
          {tx.status !== "posted" && <StatusBadge status={tx.status} label={tx.status === "draft" ? "Needs review" : undefined} />}
        </div>
        {(tx.reviewReason || tx.description) && (
          <p className="truncate text-xs text-muted-foreground">{tx.status !== "posted" && tx.reviewReason ? tx.reviewReason : tx.description}</p>
        )}
      </td>
      <td className="hidden max-w-0 truncate font-mono text-[11px] text-muted-foreground lg:table-cell">{tx.externalId}</td>
      <td className="hidden max-w-0 truncate text-xs text-muted-foreground md:table-cell">{tx.accountName ?? "No account"}</td>
      <td className="text-right">
        <span className={cn("font-medium tabular-nums", incoming && "text-money-in")}>
          {tx.type === "transfer" ? money(tx.amount, tx.currency) : money(incoming ? tx.amount : -tx.amount, tx.currency, { signed: incoming })}
        </span>
      </td>
    </tr>
  );
}

/** This connection's sync runs; `runId` is the one open in the side panel. */
export function RunsTab({
  connectionId,
  runId,
  onRunChange,
  canSync,
  onSync,
  accountName,
}: {
  connectionId: string;
  runId: string | null;
  onRunChange: (runId: string | null) => void;
  canSync: boolean;
  onSync: () => void;
  accountName: (id: string | null) => string | null;
}) {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useApi<Page<RunSummary>>("/sync-runs", { connectionId, page, pageSize: 25 });

  // Keep the list fresh while something is running.
  const running = data?.items.some((run) => run.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [running, reload]);

  return (
    <div className="space-y-3">
      {error ? (
        <EmptyNote>{error.message}</EmptyNote>
      ) : !data && loading ? (
        <TableSkeleton />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={History}
          title="No runs yet"
          description="Every sync and every webhook delivery is recorded here with what it found, created and skipped."
          action={
            canSync ? (
              <Button size="sm" onClick={onSync}>
                <RefreshCw className="size-3.5" /> Sync now
              </Button>
            ) : undefined
          }
        />
      ) : data ? (
        <>
          <RunsTable runs={data.items} onOpen={onRunChange} showConnection={false} />
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      ) : null}
      <RunDetailDialog
        runId={runId}
        onClose={() => {
          onRunChange(null);
          void reload();
        }}
        onChanged={(id) => {
          onRunChange(id);
          void reload();
        }}
        accountName={accountName}
      />
    </div>
  );
}

const EVENT_STATUS: Record<WebhookEventView["status"], string> = {
  received: "running",
  processed: "succeeded",
  ignored: "cancelled",
  failed: "failed",
  duplicate: "cancelled",
};

/** Deliveries to this connection's endpoint, including refused ones. */
export function WebhookEventsTab({ connectionId, onTest }: { connectionId: string; onTest?: () => void }) {
  const { data, loading, error, reload } = useApi<WebhookEventView[]>(`/integrations/${connectionId}/webhook-events`);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">The last 50 deliveries. Requests with a bad signature are refused and shown here without their content.</p>
        <Button size="xs" variant="ghost" onClick={() => void reload()}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>
      {error ? (
        <EmptyNote>{error.message}</EmptyNote>
      ) : !data && loading ? (
        <TableSkeleton />
      ) : data && data.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No deliveries yet"
          description="Point your app or provider at the endpoint URL on the Overview tab. Each delivery appears here."
          action={
            onTest ? (
              <Button size="sm" onClick={onTest}>
                <Send className="size-3.5" /> Send a test event
              </Button>
            ) : undefined
          }
        />
      ) : data ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Received</th>
                <th>Event</th>
                <th className="hidden md:table-cell">Event id</th>
                <th>Signature</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((event) => (
                <tr key={event.id} className="align-top [&>td]:px-3 [&>td]:py-2">
                  <td className="whitespace-nowrap text-xs tabular-nums" title={formatDateTime(event.receivedAt)}>
                    {timeAgo(event.receivedAt)}
                  </td>
                  <td className="max-w-48">
                    <span className="block truncate font-mono text-xs">{event.eventType}</span>
                    {event.error && <span className="block text-[11px] break-words text-muted-foreground">{event.error}</span>}
                  </td>
                  <td className="hidden max-w-48 truncate font-mono text-[11px] text-muted-foreground md:table-cell">{event.providerEventId ?? "—"}</td>
                  <td>
                    <span className={cn("text-xs", event.signatureValid ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                      {event.signatureValid ? "Valid" : "Refused"}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={EVENT_STATUS[event.status]} label={event.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
