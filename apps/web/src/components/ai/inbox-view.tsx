"use client";

import { TYPE_LABELS } from "@expensewise/core";
import {
  AlertTriangle,
  Camera,
  CheckCheck,
  ChevronRight,
  Copy,
  FileWarning,
  Inbox,
  type LucideIcon,
  PlugZap,
  Repeat,
  Sparkles,
  Tags,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { ConfidenceMeter, EmptyNote, EmptyState, Section, StatCard, type Tone } from "@/components/app/blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Category, Project } from "@/lib/api/types";
import type { AiStatusView, BulkResult, InboxView as InboxData, InboxDraftView, InboxShow, InboxStatus, UncategorizedView } from "@/lib/api/types/ai";
import { cn } from "@/lib/cn";
import { formatDay, titleFromKind } from "@/lib/format";
import { toast } from "@/lib/toast";
import { InboxItemCard, KIND_GROUPS } from "./inbox-items";
import { CAPTURE_KIND, Segmented, SourceTag, transactionsHref } from "./shared";

const TILES: Array<{ show: InboxShow; label: string; key: keyof InboxData["summary"]; icon: LucideIcon; tone: Tone; hint: string }> = [
  { show: "drafts", label: "Needs review", key: "needsReview", icon: FileWarning, tone: "warn", hint: "drafts & pending" },
  { show: "uncategorized", label: "Uncategorized", key: "uncategorized", icon: Tags, tone: "info", hint: "last 90 days" },
  { show: "duplicates", label: "Duplicates", key: "duplicates", icon: Copy, tone: "danger", hint: "possible doubles" },
  { show: "recurring", label: "Recurring", key: "recurring", icon: Repeat, tone: "info", hint: "not tracked yet" },
  { show: "anomalies", label: "Anomalies", key: "anomalies", icon: TrendingUp, tone: "warn", hint: "unusual spending" },
  { show: "integrations", label: "Integrations", key: "integrationErrors", icon: PlugZap, tone: "danger", hint: "need attention" },
  { show: "warnings", label: "Warnings", key: "warnings", icon: AlertTriangle, tone: "warn", hint: "budgets & renewals" },
];

const STATUSES: Array<{ value: InboxStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "snoozed", label: "Snoozed" },
  { value: "resolved", label: "Done" },
  { value: "dismissed", label: "Dismissed" },
];

const SHOW_GROUPS: Partial<Record<InboxShow, string>> = {
  duplicates: "duplicates",
  recurring: "recurring",
  anomalies: "anomalies",
  integrations: "integrations",
  warnings: "warnings",
};

function inboxHref(show: InboxShow, status: InboxStatus) {
  const params = new URLSearchParams();
  if (show !== "all") params.set("show", show);
  if (status !== "open") params.set("status", status);
  const query = params.toString();
  return `/ai/inbox${query ? `?${query}` : ""}`;
}

/**
 * The AI Inbox: every decision waiting on a person. Summary tiles filter the
 * page; each item carries its evidence and the actions that settle it.
 */
export function InboxView({
  inbox,
  uncategorized,
  categories,
  projects,
  aiStatus,
  show,
  status,
}: {
  inbox: InboxData;
  uncategorized: UncategorizedView | null;
  categories: Category[];
  projects: Project[];
  aiStatus: AiStatusView | null;
  show: InboxShow;
  status: InboxStatus;
}) {
  const router = useRouter();
  const summary = inbox.summary;
  const total = Object.values(summary).reduce((sum, value) => sum + value, 0);
  const showDrafts = status === "open" && (show === "all" || show === "drafts");
  const showUncategorized = status === "open" && (show === "all" || show === "uncategorized");
  const groups = KIND_GROUPS.filter((group) => show === "all" || SHOW_GROUPS[show] === group.id)
    .map((group) => ({ ...group, items: inbox.items.filter((item) => group.kinds.includes(item.kind)) }))
    .filter((group) => group.items.length);
  const nothingHere = !groups.length && (!showDrafts || !inbox.drafts.length) && (!showUncategorized || !uncategorized?.items.length);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">AI Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Drafts to confirm, spending to categorise, and everything the daily checks found. Nothing changes until you decide.
          </p>
        </div>
        <Button size="sm" render={<Link href="/capture" />}>
          <Camera className="size-3.5" /> Capture
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {TILES.map((tile) => {
          const active = show === tile.show;
          const value = summary[tile.key];
          return (
            <div key={tile.show} className={cn("rounded-xl", active && "ring-2 ring-primary ring-offset-2 ring-offset-background")}>
              <StatCard
                icon={tile.icon}
                label={tile.label}
                value={value}
                hint={tile.hint}
                tone={value ? tile.tone : "default"}
                href={active ? inboxHref("all", status) : inboxHref(tile.show, "open")}
                valueClassName={value ? undefined : "text-muted-foreground"}
              />
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={status} onChange={(next) => router.push(inboxHref(show, next), { scroll: false })} items={STATUSES} label="Status" />
        {show !== "all" && (
          <Button size="xs" variant="ghost" render={<Link href={inboxHref("all", status)} />}>
            Show everything
          </Button>
        )}
      </div>

      {total === 0 && status === "open" && show === "all" ? (
        <EmptyState
          icon={CheckCheck}
          title="You're all caught up"
          description="Captured drafts, uncategorised spending, possible duplicates, recurring charges and unusual activity land here for you to decide on."
          action={
            <Button size="sm" render={<Link href="/capture" />}>
              <Camera className="size-3.5" /> Capture a payment
            </Button>
          }
        />
      ) : nothingHere ? (
        <EmptyState
          icon={Inbox}
          title={status === "open" ? "Nothing here right now" : `No ${STATUSES.find((s) => s.value === status)?.label.toLowerCase()} items`}
          description={
            status === "open"
              ? "This filter is clear. Other tiles may still have something waiting."
              : "Items you snooze, finish or dismiss are kept here for reference."
          }
          action={
            <Button size="sm" variant="outline" render={<Link href={inboxHref("all", "open")} />}>
              Back to the open inbox
            </Button>
          }
        />
      ) : null}

      {showDrafts && inbox.drafts.length > 0 && <DraftsSection drafts={inbox.drafts} total={summary.needsReview} />}
      {showUncategorized && uncategorized && uncategorized.items.length > 0 && (
        <UncategorizedSection
          initial={uncategorized}
          categories={categories}
          projects={projects}
          aiAvailable={aiStatus?.available ?? false}
          total={summary.uncategorized}
        />
      )}

      {groups.map((group) => (
        <Section key={group.id} title={group.title} hint={group.hint}>
          <ul className="flex flex-col gap-2">
            {group.items.map((item) => (
              <InboxItemCard key={item.id} item={item} categories={categories} />
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}

function DraftsSection({ drafts, total }: { drafts: InboxDraftView[]; total: number }) {
  const router = useRouter();
  const { money, canWrite } = useApp();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const allSelected = selected.length === drafts.length && drafts.length > 0;

  const post = async () => {
    setBusy(true);
    try {
      const result = await clientApi<BulkResult>("/transactions/bulk", { method: "POST", body: { ids: selected, action: "post" } });
      const posted = result.changed ?? 0;
      if (posted) toast.success(`${posted} posted to the ledger`);
      if (result.failures.length) {
        toast.warning(`${result.failures.length} still need${result.failures.length === 1 ? "s" : ""} details`, { description: result.failures[0]?.message });
      }
      setSelected([]);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Drafts to review"
      hint={total > drafts.length ? `The latest ${drafts.length} of ${total}` : "Suggested by captures, imports and rules. They're not in your balances yet."}
      href="/transactions?status=draft,pending&period=all_time"
      linkLabel="All drafts"
      actions={
        canWrite && selected.length > 0 ? (
          <Button size="xs" loading={busy} onClick={() => void post()}>
            Post {selected.length}
          </Button>
        ) : undefined
      }
    >
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="[&>th]:px-1 [&>th]:pb-2 [&>th]:text-left [&>th]:font-medium">
              {canWrite && (
                <th className="w-6">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelected(checked ? drafts.map((d) => d.id) : [])}
                    aria-label="Select all drafts"
                  />
                </th>
              )}
              <th>What</th>
              <th className="text-right!">Amount</th>
              <th>Needs</th>
              <th className="w-24">Confidence</th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {drafts.map((draft) => {
              const href = draft.captureId ? `/capture/${draft.captureId}?from=inbox` : transactionsHref([draft.id]);
              const Icon = (draft.source in CAPTURE_KIND ? CAPTURE_KIND[draft.source as keyof typeof CAPTURE_KIND].icon : null) ?? FileWarning;
              return (
                <tr key={draft.id} className="[&>td]:px-1 [&>td]:py-2 align-top">
                  {canWrite && (
                    <td>
                      <Checkbox
                        checked={selected.includes(draft.id)}
                        onCheckedChange={(checked) => setSelected((current) => (checked ? [...current, draft.id] : current.filter((id) => id !== draft.id)))}
                        aria-label="Select draft"
                      />
                    </td>
                  )}
                  <td className="min-w-0">
                    <Link href={href} className="flex min-w-0 items-start gap-2 hover:underline-offset-4 [&:hover_.title]:underline">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="title block truncate">{draft.merchant ?? draft.description ?? TYPE_LABELS[draft.type]}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatDay(draft.date)} · {draft.accountName ?? "no account"} · {titleFromKind(draft.source)}
                          {draft.categoryName && ` · ${draft.categoryName}`}
                        </span>
                        {draft.reviewReason && <span className="block truncate text-xs text-amber-700 dark:text-amber-300">{draft.reviewReason}</span>}
                      </span>
                    </Link>
                  </td>
                  <td className={cn("text-right tabular-nums whitespace-nowrap", draft.direction === "in" && draft.type !== "transfer" && "text-money-in")}>
                    {money(draft.amount, draft.currency)}
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {draft.missing.map((field) => (
                        <Badge key={field} variant="error">
                          {field}
                        </Badge>
                      ))}
                      {!draft.missing.length && <span className="text-xs text-muted-foreground">—</span>}
                    </span>
                  </td>
                  <td>{draft.confidence ? <ConfidenceMeter value={draft.confidence.overall} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td>
                    <Link href={href} aria-label="Review">
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function UncategorizedSection({
  initial,
  categories,
  projects,
  aiAvailable,
  total,
}: {
  initial: UncategorizedView;
  categories: Category[];
  projects: Project[];
  aiAvailable: boolean;
  total: number;
}) {
  const router = useRouter();
  const { money, canWrite, isBusiness } = useApp();
  const [data, setData] = useState(initial);
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.items.flatMap((item) => (item.suggestion ? [[item.transaction.id, item.suggestion.categoryId]] : []))),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const unplaced = data.items.filter((item) => !item.suggestion).length;

  const options = useMemo(() => {
    const build = (kind: "expense" | "income") => {
      const list = categories.filter((c) => c.kind === kind && !c.archived);
      return list
        .filter((c) => !c.parentId)
        .flatMap((parent) => [{ ...parent, depth: 0 }, ...list.filter((c) => c.parentId === parent.id).map((c) => ({ ...c, depth: 1 }))]);
    };
    return { expense: build("expense"), income: build("income") };
  }, [categories]);

  const askAi = async () => {
    setBusy("ai");
    try {
      const next = await clientApi<UncategorizedView>("/inbox/uncategorized", { query: { suggest: true, limit: 50 } });
      setData(next);
      setAsked(true);
      setChoices((current) => {
        const merged = { ...current };
        for (const item of next.items) if (item.suggestion && !merged[item.transaction.id]) merged[item.transaction.id] = item.suggestion.categoryId;
        return merged;
      });
      if (!next.ai.used) toast.info(next.ai.reason ?? "No AI suggestions this time");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const apply = async (ids: string[]) => {
    const items = ids.flatMap((id) => {
      const categoryId = choices[id];
      if (!categoryId) return [];
      const item = data.items.find((i) => i.transaction.id === id);
      const projectId = item?.suggestion?.categoryId === categoryId && isBusiness ? item.suggestion.projectId : null;
      return [{ transactionId: id, categoryId, ...(projectId ? { projectId } : {}) }];
    });
    if (!items.length) return toast.error("Choose a category first");
    setBusy(ids.length === 1 ? (ids[0] ?? "one") : "all");
    try {
      const result = await clientApi<BulkResult>("/inbox/uncategorized/apply", { method: "POST", body: { items } });
      const done = new Set(items.map((i) => i.transactionId).filter((id) => !result.failures.some((f) => f.transactionId === id)));
      setData((current) => ({ ...current, items: current.items.filter((i) => !done.has(i.transaction.id)), total: current.total - done.size }));
      toast.success(done.size === 1 ? "Categorised, and remembered for this merchant" : `${done.size} categorised; merchants remembered`);
      if (result.failures.length) toast.error(result.failures[0]?.message ?? "Some couldn't be updated");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const ready = data.items.filter((item) => choices[item.transaction.id]).map((item) => item.transaction.id);

  return (
    <Section
      title="Uncategorized"
      hint={`${total} posted in the last 90 days without a category. Choosing one teaches merchant memory for next time.`}
      href="/transactions?categoryId=none&period=last_90_days"
      linkLabel="Open in transactions"
      actions={
        canWrite ? (
          <span className="flex gap-1.5">
            {aiAvailable && unplaced > 0 && !asked && (
              <Button size="xs" variant="outline" loading={busy === "ai"} onClick={() => void askAi()}>
                <Sparkles className="size-3" /> Suggest {unplaced} with AI
              </Button>
            )}
            {ready.length > 0 && (
              <Button size="xs" loading={busy === "all"} onClick={() => void apply(ready)}>
                Apply {ready.length}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      {data.items.length ? (
        <ul className="-mx-1 divide-y divide-border">
          {data.items.map((item) => {
            const t = item.transaction;
            const kind = t.type === "income" ? "income" : "expense";
            const choice = choices[t.id] ?? "";
            const list = options[kind];
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-2">
                <Link href={transactionsHref([t.id])} className="min-w-0 flex-1 basis-56">
                  <span className="block truncate text-sm hover:underline">{t.merchant ?? t.description ?? TYPE_LABELS[t.type]}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatDay(t.date)} · {t.accountName ?? "—"}
                  </span>
                </Link>
                <span className={cn("w-28 text-right text-sm tabular-nums", t.direction === "in" && "text-money-in")}>{money(t.amount, t.currency)}</span>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Select
                    value={choice || null}
                    disabled={!canWrite}
                    onValueChange={(v) => typeof v === "string" && setChoices((current) => ({ ...current, [t.id]: v }))}
                  >
                    <SelectTrigger className="sm:w-52" aria-label="Category">
                      <SelectValue>{list.find((c) => c.id === choice)?.name ?? "Choose a category"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {list.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className={cn(c.depth === 1 && "ps-4 text-muted-foreground")}>{c.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {canWrite && (
                    <Button size="xs" variant="outline" disabled={!choice} loading={busy === t.id} onClick={() => void apply([t.id])}>
                      Apply
                    </Button>
                  )}
                </div>
                {item.suggestion && choice === item.suggestion.categoryId && (
                  <span className="flex w-full items-center gap-1.5 sm:w-auto">
                    <SourceTag source={item.suggestion.source} />
                    <ConfidenceMeter value={item.suggestion.confidence} />
                    {item.suggestion.projectName && isBusiness && projects.length > 0 && (
                      <span className="text-xs text-muted-foreground">→ {item.suggestion.projectName}</span>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyNote>Everything recent has a category.</EmptyNote>
      )}
    </Section>
  );
}
