"use client";

import {
  CircleAlert,
  CircleCheck,
  Clock,
  FileText,
  FlaskConical,
  HandCoins,
  KeyRound,
  ListChecks,
  MoreHorizontal,
  Pencil,
  PlugZap,
  RefreshCw,
  RotateCw,
  Send,
  Trash2,
  Unplug,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Facts, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { PageShell } from "@/components/app/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Account, Project } from "@/lib/api/types";
import type { CatalogEntry, ConnectionDetail, RemoveResult, SyncStart, TestResult, WebhookReveal, WebhookTestResult } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { EditConnectionDialog, WebhookRevealPanel } from "./connection-form";
import { RecordsTab, RunsTab, WebhookEventsTab } from "./detail-tabs";
import { BalanceComparison } from "./runs";
import { CATEGORY_LABEL, CodeBlock, ConfirmDialog, CopyField, FREQUENCY_LABEL, HealthBadge, ProviderTile } from "./shared";

export type DetailTab = "overview" | "records" | "runs" | "events";

export function ConnectionDetailView({
  detail,
  entry,
  accounts,
  projects,
  initialTab,
  initialRun,
  initialStatus,
}: {
  detail: ConnectionDetail;
  entry: CatalogEntry | null;
  accounts: Account[];
  projects: Project[];
  initialTab: DetailTab;
  initialRun: string | null;
  initialStatus: string | null;
}) {
  const { canManage, locale } = useApp();
  const router = useRouter();
  const [tab, setTab] = useState<DetailTab>(initialTab === "events" && !detail.capabilities.webhook ? "overview" : initialTab);
  const [runId, setRunId] = useState<string | null>(initialRun);
  const [editing, setEditing] = useState<"edit" | "reconnect" | null>(null);
  const [reveal, setReveal] = useState<WebhookReveal | null>(null);
  const [confirm, setConfirm] = useState<"disconnect" | "delete" | "rotate" | null>(null);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const disconnected = detail.status === "disconnected";
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? (id === detail.accountId ? detail.accountName : null);

  // Tab and open run live in the URL (shareable, survive refresh) without a server round trip.
  const syncUrl = (next: { tab?: DetailTab; run?: string | null }) => {
    const url = new URL(window.location.href);
    if (next.tab) url.searchParams.set("tab", next.tab);
    if (next.run) url.searchParams.set("run", next.run);
    else if (next.run === null || next.tab) url.searchParams.delete("run");
    window.history.replaceState(null, "", url);
  };
  const changeTab = (value: DetailTab) => {
    setTab(value);
    syncUrl({ tab: value });
  };
  const selectRun = (id: string | null) => {
    setRunId(id);
    syncUrl({ run: id });
  };

  // Links to this page with another tab or run (stat cards, notifications).
  useEffect(() => setTab(initialTab === "events" && !detail.capabilities.webhook ? "overview" : initialTab), [initialTab, detail.capabilities.webhook]);
  useEffect(() => {
    if (initialRun) setRunId(initialRun);
  }, [initialRun]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = () =>
    run("sync", async () => {
      const result = await clientApi<SyncStart>(`/integrations/${detail.id}/sync`, { method: "POST" });
      toast.success(result.status === "queued" ? "Sync started" : "A sync is already running");
      invalidateApiCache("/sync-runs");
      if (result.runId) {
        changeTab("runs");
        selectRun(result.runId);
      }
      router.refresh();
    });

  const testConnection = () =>
    run("test", async () => {
      const result = await clientApi<TestResult>(`/integrations/${detail.id}/test`, { method: "POST" });
      setTestResult(result);
      if (result.ok) toast.success("Connection works", { description: result.message });
      else toast.error("Connection test failed", { description: result.message });
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await clientApi(`/integrations/${detail.id}/disconnect`, { method: "POST" });
      toast.success("Disconnected. Its history stays.");
      setConfirm(null);
      invalidateApiCache("/integrations");
      router.refresh();
    });

  const remove = () =>
    run("delete", async () => {
      const result = await clientApi<RemoveResult>(`/integrations/${detail.id}`, { method: "DELETE" });
      setConfirm(null);
      invalidateApiCache("/integrations");
      if (result.deleted) {
        toast.success("Connection deleted");
        router.push("/integrations");
      } else {
        toast.info("Disconnected instead", { description: result.reason ?? "Imported transactions keep their link to it." });
      }
      router.refresh();
    });

  const rotate = () =>
    run("rotate", async () => {
      const result = await clientApi<WebhookReveal>(`/integrations/${detail.id}/webhook/rotate`, { method: "POST" });
      setConfirm(null);
      setReveal(result);
      router.refresh();
    });

  const menuItems = (
    <>
      <DropdownMenuItem onClick={() => setEditing(disconnected ? "reconnect" : "edit")}>
        {disconnected ? <PlugZap /> : <Pencil />}
        {disconnected ? "Reconnect" : "Edit"}
      </DropdownMenuItem>
      {detail.webhook && !disconnected && (
        <>
          <DropdownMenuItem onClick={() => setConfirm("rotate")}>
            <RotateCw /> Rotate webhook secret
          </DropdownMenuItem>
          {detail.webhook.supportsTestEvent && (
            <DropdownMenuItem onClick={() => setTestingWebhook(true)}>
              <Send /> Send test webhook
            </DropdownMenuItem>
          )}
        </>
      )}
      <DropdownMenuSeparator />
      {!disconnected && (
        <DropdownMenuItem onClick={() => setConfirm("disconnect")}>
          <Unplug /> Disconnect
        </DropdownMenuItem>
      )}
      <DropdownMenuItem variant="destructive" onClick={() => setConfirm("delete")}>
        <Trash2 /> Delete
      </DropdownMenuItem>
    </>
  );

  const reviewCount = detail.stats.transactions.draft + detail.stats.transactions.pending;

  return (
    <PageShell
      frame="settings"
      title={detail.name}
      crumbs={[{ label: "Integrations", href: "/integrations" }]}
      backHref="/integrations"
      width="wide"
      actions={
        canManage ? (
          <>
            {detail.capabilities.sync && !disconnected && (
              <Button size="xs" loading={busy === "sync"} onClick={() => void syncNow()}>
                <RefreshCw className="size-3.5" /> Sync now
              </Button>
            )}
            {detail.capabilities.testConnection && !disconnected && (
              <Button size="xs" variant="outline" loading={busy === "test"} onClick={() => void testConnection()}>
                <FlaskConical className="size-3.5" /> Test
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-xs" variant="outline" aria-label="More actions" />}>
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : undefined
      }
      mobileActions={
        canManage && detail.capabilities.sync && !disconnected ? (
          <Button aria-label="Sync now" className="size-10" size="icon" variant="ghost" loading={busy === "sync"} onClick={() => void syncNow()}>
            <RefreshCw className="size-5" />
          </Button>
        ) : undefined
      }
      mobileMenu={
        canManage ? (
          <>
            {detail.capabilities.testConnection && !disconnected && (
              <DropdownMenuItem onClick={() => void testConnection()}>
                <FlaskConical /> Test connection
              </DropdownMenuItem>
            )}
            {menuItems}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderTile icon={detail.icon} category={detail.category} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold">{detail.name}</h1>
              <StatusBadge status={detail.status} label={detail.status === "needs_attention" ? "Needs attention" : undefined} />
              {!disconnected && <HealthBadge health={detail.health} />}
            </div>
            <p className="text-xs text-muted-foreground">
              {detail.displayName} · {CATEGORY_LABEL[detail.category]} · {detail.trustLevel === "trusted" ? "posts automatically" : "records wait for review"}
            </p>
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3.5" />
              {detail.lastSyncedAt ? `Last activity ${timeAgo(detail.lastSyncedAt)}` : detail.capabilities.sync ? "Not synced yet" : "No events received yet"}
              {detail.capabilities.sync && ` · ${FREQUENCY_LABEL[detail.syncFrequency]?.toLowerCase()}`}
            </p>
          </div>
        </div>
        {canManage && !disconnected && detail.capabilities.sync && (
          <Button size="sm" variant="outline" className="md:hidden" loading={busy === "sync"} onClick={() => void syncNow()}>
            <RefreshCw className="size-3.5" /> Sync now
          </Button>
        )}
      </div>

      {disconnected && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
          <span className="flex items-center gap-2">
            <Unplug className="size-4 text-muted-foreground" />
            Disconnected: its credentials were removed. Everything it imported is still in your books.
          </span>
          {canManage && (
            <Button size="sm" onClick={() => setEditing("reconnect")}>
              <PlugZap className="size-3.5" /> Reconnect
            </Button>
          )}
        </div>
      )}
      {!disconnected && !detail.credentialsReadable && (
        <Notice tone="danger">
          The stored credentials can no longer be decrypted (the server&apos;s encryption key changed). Enter them again to resume syncing.
        </Notice>
      )}
      {!disconnected && detail.errorMessage && (
        <Notice tone={detail.status === "needs_attention" || detail.status === "error" ? "danger" : "warn"}>
          {detail.consecutiveFailures >= 2 ? `${detail.consecutiveFailures} syncs in a row failed. ` : ""}
          {detail.errorMessage}
          {detail.lastErrorAt ? ` · ${timeAgo(detail.lastErrorAt)}` : ""}
        </Notice>
      )}
      {testResult && (
        <Notice tone={testResult.ok ? "good" : "danger"} onDismiss={() => setTestResult(null)}>
          {testResult.message}
        </Notice>
      )}

      <Tabs value={tab} onValueChange={(value) => typeof value === "string" && changeTab(value as DetailTab)}>
        <TabsList variant="underline" className="border-b border-border">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="records">
            Records <span className="text-xs text-muted-foreground tabular-nums">{detail.stats.transactions.total.toLocaleString(locale)}</span>
          </TabsTab>
          <TabsTab value="runs">Sync runs</TabsTab>
          {detail.capabilities.webhook && <TabsTab value="events">Webhook events</TabsTab>}
        </TabsList>

        <TabsPanel value="overview" className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              icon={ListChecks}
              label="Transactions imported"
              value={detail.stats.transactions.total.toLocaleString(locale)}
              hint={`${detail.stats.transactions.posted.toLocaleString(locale)} posted`}
              href={`/integrations/${detail.id}?tab=records`}
            />
            <StatCard
              icon={CircleAlert}
              label="Waiting for review"
              value={reviewCount.toLocaleString(locale)}
              hint={reviewCount ? "Drafts and pending" : "Nothing to review"}
              tone={reviewCount ? "warn" : "default"}
              href={`/integrations/${detail.id}?tab=records&status=draft,pending`}
            />
            <StatCard
              icon={HandCoins}
              label="Receivables"
              value={detail.stats.receivables.toLocaleString(locale)}
              hint="Invoices from this source"
              href="/wealth/receivables"
            />
            <StatCard
              icon={detail.latestBalances.some((b) => b.difference) ? CircleAlert : CircleCheck}
              label="Balance check"
              value={
                detail.latestBalances.length
                  ? detail.latestBalances.some((b) => b.difference)
                    ? "Differs"
                    : detail.latestBalances.every((b) => b.difference === 0)
                      ? "Matches"
                      : "Reported"
                  : "—"
              }
              hint={detail.latestBalances[0]?.asOf ? `As of ${detail.latestBalances[0].asOf}` : "The source reports no balance"}
              tone={detail.latestBalances.some((b) => b.difference) ? "warn" : detail.latestBalances.length ? "good" : "default"}
            />
          </div>

          {detail.latestBalances.length > 0 && (
            <Section title="Balance check" hint="What the source reports against your books on the same day">
              <BalanceComparison balances={detail.latestBalances} accountName={accountName} />
            </Section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Details">
              <Facts
                items={[
                  { label: "Provider", value: detail.displayName },
                  {
                    label: "Account",
                    value: detail.accountId ? (
                      <Link href={`/accounts/${detail.accountId}`} className="hover:underline">
                        {detail.accountName}
                      </Link>
                    ) : (
                      "Chosen per record"
                    ),
                  },
                  detail.projectName ? { label: "Project", value: detail.projectName } : null,
                  detail.capabilities.sync && { label: "Sync", value: FREQUENCY_LABEL[detail.syncFrequency] },
                  { label: "New records", value: detail.trustLevel === "trusted" ? "Post automatically" : "Wait for review" },
                  { label: "Records imported", value: <span className="tabular-nums">{detail.recordsTotal.toLocaleString(locale)}</span> },
                  { label: "Last success", value: detail.lastSuccessAt ? formatDateTime(detail.lastSuccessAt) : "—" },
                  { label: "Connected", value: formatDateTime(detail.createdAt) },
                ]}
              />
            </Section>
            <Section
              title="Credentials"
              hint="Encrypted at rest. Only which fields are set is ever shown."
              actions={
                canManage && entry?.credentialFields.length ? (
                  <Button size="xs" variant="outline" onClick={() => setEditing(disconnected ? "reconnect" : "edit")}>
                    <KeyRound className="size-3.5" /> Replace
                  </Button>
                ) : undefined
              }
            >
              {detail.credentials.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {detail.credentials.map((credential) => (
                    <li key={credential.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="truncate">{credential.label}</span>
                      {credential.set ? (
                        <code className="font-mono text-xs text-muted-foreground">{credential.masked}</code>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not set</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{detail.displayName} needs no credentials.</p>
              )}
            </Section>
          </div>

          {detail.webhook && (
            <Section
              title="Webhook endpoint"
              hint={
                detail.webhook.secretSource === "provider"
                  ? "Events are verified with the provider's signing secret."
                  : "Events are verified with this connection's signing secret."
              }
              actions={
                canManage && !disconnected ? (
                  <>
                    {detail.webhook.supportsTestEvent && (
                      <Button size="xs" variant="outline" onClick={() => setTestingWebhook(true)}>
                        <Send className="size-3.5" /> Send test
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" onClick={() => setConfirm("rotate")}>
                      <RotateCw className="size-3.5" /> Rotate
                    </Button>
                  </>
                ) : undefined
              }
            >
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-3">
                  {detail.webhook.url && <CopyField label="Endpoint URL" value={detail.webhook.url} />}
                  <p className="text-xs text-muted-foreground">
                    {detail.webhook.secretSource === "provider"
                      ? detail.webhook.providerSecretSet
                        ? `${detail.displayName}'s signing secret is saved.`
                        : `Add the URL as an endpoint in ${detail.displayName}, then paste its signing secret into the credentials. Until then, events are refused.`
                      : "The signing secret was shown once, when the endpoint was created. Rotate it to get a new one; the old URL stops working at once."}
                  </p>
                  {detail.webhook.events.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-muted-foreground">Events:</span>
                      {detail.webhook.events.map((event) => (
                        <Badge key={event} variant="outline" size="sm" className="font-mono">
                          {event}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                {detail.webhook.scheme && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Signature ({detail.webhook.signatureHeader})</p>
                    <p className="rounded-lg bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed break-words">{detail.webhook.scheme}</p>
                    {detail.provider === "generic_webhook" && (
                      <Link href="/integrations/api#webhooks" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        <FileText className="size-3.5" /> Code samples for signing
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </Section>
          )}

          {Object.keys(detail.config).length > 0 && (
            <Section title="Settings" hint="Non-secret configuration, as stored">
              <CodeBlock code={JSON.stringify(detail.config, null, 2)} language="json" />
            </Section>
          )}
        </TabsPanel>

        <TabsPanel value="records" className="pt-2">
          {tab === "records" && <RecordsTab key={initialStatus ?? ""} connectionId={detail.id} initialStatus={initialStatus} />}
        </TabsPanel>
        <TabsPanel value="runs" className="pt-2">
          {tab === "runs" && (
            <RunsTab
              connectionId={detail.id}
              runId={runId}
              onRunChange={selectRun}
              canSync={canManage && !disconnected && detail.capabilities.sync}
              onSync={() => void syncNow()}
              accountName={accountName}
            />
          )}
        </TabsPanel>
        {detail.capabilities.webhook && (
          <TabsPanel value="events" className="pt-2">
            {tab === "events" && (
              <WebhookEventsTab
                connectionId={detail.id}
                onTest={canManage && detail.webhook?.supportsTestEvent && !disconnected ? () => setTestingWebhook(true) : undefined}
              />
            )}
          </TabsPanel>
        )}
      </Tabs>

      {(editing === "edit" || editing === "reconnect") && (
        <EditConnectionDialog
          connection={detail}
          entry={entry}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          accounts={accounts}
          projects={projects}
          reconnect={editing === "reconnect"}
          onRevealed={setReveal}
        />
      )}

      <ConfirmDialog
        open={confirm === "disconnect"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Disconnect ${detail.name}?`}
        description="Syncing stops, the credentials and webhook endpoint are deleted, and everything it imported stays in your books. You can reconnect later by entering the credentials again."
        confirmLabel="Disconnect"
        busy={busy === "disconnect"}
        onConfirm={() => void disconnect()}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Delete ${detail.name}?`}
        description={
          detail.stats.transactions.total > 0
            ? `It imported ${detail.stats.transactions.total.toLocaleString(locale)} transactions, which keep their link to it, so it will be disconnected instead of deleted.`
            : "It has not imported anything, so the connection and its sync history are deleted for good."
        }
        confirmLabel={detail.stats.transactions.total > 0 ? "Disconnect" : "Delete"}
        busy={busy === "delete"}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={confirm === "rotate"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Rotate the webhook secret?"
        description={`You get a new endpoint URL${detail.webhook?.secretSource === "generated" ? " and signing secret" : ""}. The old URL stops working immediately, so update the sender right away.`}
        confirmLabel="Rotate"
        destructive={false}
        busy={busy === "rotate"}
        onConfirm={() => void rotate()}
      />

      <Dialog open={reveal !== null} onOpenChange={(open) => !open && setReveal(null)}>
        <DialogPopup className="w-full max-w-lg">
          <DialogHeader>
            <DialogTitle>New webhook endpoint</DialogTitle>
            <DialogDescription>Update the sender with the new URL{reveal?.secretSource === "generated" ? " and secret" : ""}.</DialogDescription>
          </DialogHeader>
          <DialogPanel>{reveal && <WebhookRevealPanel reveal={reveal} providerName={detail.displayName} />}</DialogPanel>
          <DialogFooter>
            <Button size="sm" onClick={() => setReveal(null)}>
              I&apos;ve saved it
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <TestWebhookDialog
        open={testingWebhook}
        onOpenChange={setTestingWebhook}
        connectionId={detail.id}
        events={detail.provider === "generic_webhook" ? [] : (detail.webhook?.events ?? [])}
        onRun={(id) => {
          setTestingWebhook(false);
          changeTab("runs");
          selectRun(id);
        }}
      />
    </PageShell>
  );
}

function Notice({ tone, children, onDismiss }: { tone: "danger" | "warn" | "good"; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-xl px-4 py-3 text-sm",
        tone === "danger" && "bg-red-500/10 text-red-700 dark:text-red-300",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "good" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {tone === "good" ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs underline-offset-4 hover:underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  "charge.succeeded": "A successful charge",
  "charge.refunded": "A refund",
  "payout.paid": "A payout",
};

/** Fires a signed test event at the connection's own endpoint and shows what happened. */
function TestWebhookDialog({
  open,
  onOpenChange,
  connectionId,
  events,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  events: string[];
  onRun: (runId: string) => void;
}) {
  const router = useRouter();
  const [eventType, setEventType] = useState(events[0] ?? "");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WebhookTestResult | null>(null);

  const send = async () => {
    setSending(true);
    try {
      const data = await clientApi<WebhookTestResult>(`/integrations/${connectionId}/webhook/test`, { method: "POST", body: eventType ? { eventType } : {} });
      setResult(data);
      invalidateApiCache("/integrations");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setResult(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Webhook className="size-4" /> Send a test webhook
          </DialogTitle>
          <DialogDescription>
            A realistic event is signed with this connection&apos;s secret and delivered to its own URL, exactly like a real one, then imported. The records it
            creates are marked as test data.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {events.length > 0 && (
            <Select value={eventType} onValueChange={(v) => typeof v === "string" && setEventType(v)}>
              <SelectTrigger aria-label="Event type">
                <SelectValue>{EVENT_LABEL[eventType] ? `${EVENT_LABEL[eventType]} (${eventType})` : eventType}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {events.map((event) => (
                  <SelectItem key={event} value={event}>
                    {EVENT_LABEL[event] ?? event} <span className="font-mono text-xs text-muted-foreground">{event}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {result && (
            <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
              <p className="flex items-center gap-2">
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                Delivered: <code className="font-mono text-xs">{result.delivery.eventId}</code> ({result.delivery.status})
              </p>
              {result.processing && (
                <p className="text-xs text-muted-foreground">
                  Processing {result.processing.status}
                  {result.processing.run &&
                    `: ${result.processing.run.created} created, ${result.processing.run.skipped} skipped, ${result.processing.run.errors} errors`}
                  .
                </p>
              )}
              {result.processing?.run && (
                <Button size="xs" variant="outline" onClick={() => result.processing?.run && onRun(result.processing.run.id)}>
                  See the run
                </Button>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button size="sm" loading={sending} onClick={() => void send()}>
            <Send className="size-3.5" /> {result ? "Send another" : "Send test event"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
