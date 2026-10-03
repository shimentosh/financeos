"use client";

import { SELECTABLE_CURRENCIES, today } from "@expensewise/core";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { ExchangeRate } from "@/lib/api/types";
import { formatDateTime, formatDay, titleFromKind } from "@/lib/format";
import { toast } from "@/lib/toast";
import { SettingsCard } from "./settings-page";

export function CurrencySettings({ rates }: { rates: ExchangeRate[] }) {
  const { workspace, canManage } = useApp();
  const router = useRouter();
  const id = useId();
  const [from, setFrom] = useState("USD");
  const [rate, setRate] = useState("");
  const [date, setDate] = useState(today(workspace.timezone));
  const [busy, setBusy] = useState(false);

  // The newest rate per pair, then history.
  const latest = new Map<string, ExchangeRate>();
  for (const r of rates) {
    const key = `${r.fromCurrency}→${r.toCurrency}`;
    const current = latest.get(key);
    if (!current || r.date > current.date) latest.set(key, r);
  }

  const add = async () => {
    setBusy(true);
    try {
      await clientApi("/exchange-rates", { method: "POST", body: { fromCurrency: from, toCurrency: workspace.baseCurrency, rate, date } });
      toast.success(`1 ${from} = ${rate} ${workspace.baseCurrency} from ${formatDay(date)}`);
      setRate("");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: ExchangeRate) => {
    try {
      await clientApi(`/exchange-rates/${row.id}`, { method: "DELETE" });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <>
      <SettingsCard
        title={`Reporting currency: ${workspace.baseCurrency}`}
        description="Every transaction keeps its original amount and currency. Reports convert to the reporting currency with the rate valid on the transaction's date."
      >
        <ul className="divide-y divide-border">
          {[...latest.values()].map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                1 {row.fromCurrency} = <span className="font-medium tabular-nums">{Number(row.rate).toLocaleString("en", { maximumFractionDigits: 6 })}</span>{" "}
                {row.toCurrency}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                from {formatDay(row.date)}
                {row.source === "seed" && <Badge variant="warning">Starter rate — update it</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </SettingsCard>
      {canManage && (
        <SettingsCard
          title="Add a rate"
          description="Rates apply from their date until a newer one. Use the rate your bank or card actually gave you."
          footer={
            <Button size="sm" loading={busy} disabled={!rate} onClick={() => void add()}>
              <Plus className="size-3.5" /> Save rate
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>1 unit of</Label>
              <Select value={from} onValueChange={(v) => typeof v === "string" && setFrom(v)}>
                <SelectTrigger>
                  <SelectValue>{from}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_CURRENCIES.filter((c) => c !== workspace.baseCurrency).map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-rate`}>equals ({workspace.baseCurrency})</Label>
              <Input id={`${id}-rate`} inputMode="decimal" placeholder="122.50" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-date`}>From</Label>
              <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
        </SettingsCard>
      )}
      <SettingsCard title="History">
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="[&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">
                <th>Pair</th>
                <th>Rate</th>
                <th>From</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rates.map((row) => (
                <tr key={row.id} className="[&>td]:py-1.5">
                  <td>
                    {row.fromCurrency} → {row.toCurrency}
                  </td>
                  <td className="tabular-nums">{Number(row.rate).toLocaleString("en", { maximumFractionDigits: 6 })}</td>
                  <td className="text-muted-foreground">{formatDay(row.date)}</td>
                  <td className="text-muted-foreground capitalize">{row.source}</td>
                  <td className="text-right">
                    {canManage && (
                      <Button size="icon-xs" variant="ghost" aria-label="Delete rate" onClick={() => void remove(row)}>
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </>
  );
}

type AiStatus = {
  configured: boolean;
  provider: string;
  model: string | null;
  enabled: boolean;
  budget: number | null;
  spentThisMonth: number;
  /** Present when the installation bills for AI in credits. */
  credits?: { allowance: number; remainingAllowance: number; balance: number; remaining: number; periodEnd: string } | null;
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic Claude",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI Grok",
  qwen: "Qwen",
  moonshot: "Kimi",
  together: "Together AI",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  custom: "a custom endpoint",
};

export function AiSettings({
  status,
  usage,
}: {
  status: AiStatus | null;
  usage: { totals?: { calls: number; costUsd: number | string; inputTokens?: number; outputTokens?: number } } | null;
}) {
  const { workspace, canManage, me } = useApp();
  const router = useRouter();
  const [enabled, setEnabled] = useState(workspace.settings.aiEnabled !== false);
  const [autoPost, setAutoPost] = useState(Boolean(workspace.settings.autoPostHighConfidence));
  const [autoSubs, setAutoSubs] = useState(Boolean(workspace.settings.autoCreateDetectedSubscriptions));
  const [budget, setBudget] = useState(workspace.settings.aiMonthlyBudgetUsd?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await clientApi("/workspaces/current", {
        method: "PATCH",
        body: {
          settings: {
            aiEnabled: enabled,
            autoPostHighConfidence: autoPost,
            autoCreateDetectedSubscriptions: autoSubs,
            aiMonthlyBudgetUsd: budget.trim() ? Number(budget) : null,
          },
        },
      });
      toast.success("AI settings saved");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsCard title="Provider">
        {status ? (
          <p className="text-sm">
            {status.configured ? (
              <>
                Using <span className="font-medium">{status.model}</span> ({PROVIDER_NAMES[status.provider] ?? status.provider}). Spent this month:{" "}
                <span className="font-medium tabular-nums">${Number(status.spentThisMonth).toFixed(2)}</span>
                {status.budget ? ` of $${status.budget}` : ""}.
                {status.credits && (
                  <>
                    {" "}
                    AI credits left: <span className="font-medium tabular-nums">{status.credits.remaining.toLocaleString()}</span>{" "}
                    <Link href="/settings/billing" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
                      Plan & billing
                    </Link>
                    .
                  </>
                )}
              </>
            ) : (
              "No AI provider is set up yet. Screenshots can still be attached and reviewed by hand, text entries use the built-in parser, and rules and merchant memory keep working."
            )}{" "}
            <span className="text-muted-foreground">
              The provider is chosen for the whole installation
              {me.user.isAdmin ? (
                <>
                  {" "}
                  in{" "}
                  <Link href="/admin/ai" className="underline underline-offset-2 hover:text-foreground">
                    Admin → AI
                  </Link>
                </>
              ) : (
                " by a platform admin"
              )}
              .
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">AI status is not available yet.</p>
        )}
        {usage?.totals && (
          <p className="text-xs text-muted-foreground">
            {usage.totals.calls} calls this month · ${Number(usage.totals.costUsd).toFixed(2)}
          </p>
        )}
      </SettingsCard>
      <SettingsCard
        title="Behaviour"
        description="AI output is always a draft until you confirm it, unless you choose otherwise below."
        footer={
          canManage ? (
            <Button size="sm" loading={busy} onClick={() => void save()}>
              Save
            </Button>
          ) : undefined
        }
      >
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
          <span>
            Use AI in this workspace
            <span className="block text-xs text-muted-foreground">Screenshot reading, categorisation help, the Copilot and report summaries.</span>
          </span>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canManage} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
          <span>
            Post captures without review when every field is certain
            <span className="block text-xs text-muted-foreground">Only above 95% confidence, with no duplicate candidates and no rule asking for review.</span>
          </span>
          <Switch checked={autoPost} onCheckedChange={setAutoPost} disabled={!canManage} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
          <span>
            Create detected subscriptions automatically
            <span className="block text-xs text-muted-foreground">Otherwise you are asked each time.</span>
          </span>
          <Switch checked={autoSubs} onCheckedChange={setAutoSubs} disabled={!canManage} />
        </label>
        <div className="space-y-1">
          <Label htmlFor="ai-budget">{status?.credits ? "Monthly AI cap for this workspace (USD, optional)" : "Monthly AI budget (USD)"}</Label>
          <Input
            id="ai-budget"
            inputMode="decimal"
            placeholder={status?.credits ? "No cap" : "Server default"}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            disabled={!canManage}
            className="max-w-40"
          />
          <p className="text-xs text-muted-foreground">
            {status?.credits
              ? "AI is paid for with the workspace owner's AI credits. This cap is an extra limit you can set yourself: leave it empty for no cap, or enter 0 to turn AI off for this workspace. When reached, AI pauses until next month and deterministic rules take over."
              : "When reached, AI features pause until next month and deterministic rules take over. 0 means no limit."}
          </p>
        </div>
      </SettingsCard>
    </>
  );
}

type AuditRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: string;
  actorId: string | null;
  source: string | null;
  createdAt: string;
  before: unknown;
  after: unknown;
};

export function AuditLog({ page }: { page: { items: AuditRow[]; total: number; page: number; pageSize: number } }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const go = (next: number) => {
    const search = new URLSearchParams(params.toString());
    search.set("page", String(next));
    router.push(`${pathname}?${search}`);
  };

  return (
    <SettingsCard
      title="Every change, with before and after"
      description="Financial changes are recorded in the same database transaction as the change itself."
    >
      <ul className="divide-y divide-border">
        {page.items.map((row) => (
          <li key={row.id} className="py-2">
            <button type="button" onClick={() => setOpen(open === row.id ? null : row.id)} className="flex w-full items-center gap-3 text-left">
              <span className="w-36 shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(row.createdAt)}</span>
              <span className="min-w-0 flex-1 truncate text-sm">
                {titleFromKind(row.action.replace(".", " "))}
                {row.entityType === "transaction" && row.entityId && (
                  <a
                    href={`/transactions?ids=${row.entityId}&period=all_time`}
                    onClick={(e) => e.stopPropagation()}
                    className="ms-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
                  >
                    view
                  </a>
                )}
              </span>
              <Badge variant="outline" className="capitalize">
                {row.actorType}
              </Badge>
            </button>
            {open === row.id && (
              <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2">
                <pre className="max-h-56 overflow-auto rounded-lg bg-muted/50 p-2">{JSON.stringify(row.before, null, 2) ?? "—"}</pre>
                <pre className="max-h-56 overflow-auto rounded-lg bg-muted/50 p-2">{JSON.stringify(row.after, null, 2) ?? "—"}</pre>
              </div>
            )}
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-1">
          <Button size="xs" variant="outline" disabled={page.page <= 1} onClick={() => go(page.page - 1)}>
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="px-2 text-xs text-muted-foreground tabular-nums">
            {page.page} / {pages}
          </span>
          <Button size="xs" variant="outline" disabled={page.page >= pages} onClick={() => go(page.page + 1)}>
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}
