"use client";

import { Bot, KeyRound, Plus, ShieldCheck, Trash2, Webhook } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, Section, StatusBadge } from "@/components/app/blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { ApiKey, ApiKeyCreated, Connection } from "@/lib/api/types/integrations";
import { formatDateTime, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { CodeBlock, ConfirmDialog, CopyField } from "./shared";

/** The app's own origin, for copy-pasteable examples (known only in the browser). */
function useOrigin() {
  const [origin, setOrigin] = useState("https://your-financeos-domain");
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

export function ApiView({ keys, customWebhooks }: { keys: ApiKey[] | null; customWebhooks: Connection[] }) {
  const origin = useOrigin();
  return (
    <div className="space-y-4">
      <ApiKeysSection keys={keys} />
      <McpDocs origin={origin} />
      <ApiDocs origin={origin} />
      <WebhookDocs customWebhooks={customWebhooks} />
    </div>
  );
}

// -------------------------------------------------------------- API keys

const EXPIRY: Array<{ value: string; label: string }> = [
  { value: "never", label: "Never expires" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

function ApiKeysSection({ keys }: { keys: ApiKey[] | null }) {
  const { canManage } = useApp();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await clientApi(`/api-keys/${revoking.id}`, { method: "DELETE" });
      toast.success(`${revoking.name} revoked`);
      setRevoking(null);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="API keys"
      hint="Keys let your own apps and scripts read and write this workspace through the public API."
      actions={
        canManage ? (
          <Button size="xs" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> New key
          </Button>
        ) : undefined
      }
    >
      {!canManage || keys === null ? (
        <EmptyNote>Only workspace owners and admins can see and create API keys.</EmptyNote>
      ) : keys.length === 0 ? (
        <EmptyNote
          action={
            <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
              <KeyRound className="size-3.5" /> Create your first key
            </Button>
          }
        >
          No keys yet. Create one per app, with only the scopes it needs.
        </EmptyNote>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Name</th>
                <th className="hidden sm:table-cell">Key</th>
                <th>Scopes</th>
                <th className="hidden md:table-cell">Last used</th>
                <th className="hidden lg:table-cell">Expires</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {keys.map((key) => (
                <tr key={key.id} className="[&>td]:px-3 [&>td]:py-2">
                  <td className="max-w-0">
                    <span className="block truncate font-medium">{key.name}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {key.status !== "active" && <StatusBadge status={key.status === "revoked" ? "cancelled" : "expired"} label={key.status} />}
                      Created {timeAgo(key.createdAt)}
                    </span>
                  </td>
                  <td className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{key.prefix}…</td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <Badge key={scope} variant={scope === "write" ? "warning" : "outline"} size="sm">
                          {scope}
                        </Badge>
                      ))}
                    </span>
                  </td>
                  <td className="hidden text-xs text-muted-foreground md:table-cell">{key.lastUsedAt ? timeAgo(key.lastUsedAt) : "Never"}</td>
                  <td className="hidden text-xs text-muted-foreground lg:table-cell">{key.expiresAt ? formatDateTime(key.expiresAt) : "Never"}</td>
                  <td className="text-right">
                    {key.status === "active" && (
                      <Button size="icon-xs" variant="ghost" aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        description="Every request with this key is refused from now on. Apps using it stop working until they get a new key."
        confirmLabel="Revoke key"
        busy={busy}
        onConfirm={() => void revoke()}
      />
    </Section>
  );
}

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [expiry, setExpiry] = useState("never");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setWrite(false);
    setExpiry("never");
    setError(null);
    setCreated(null);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data = await clientApi<ApiKeyCreated>("/api-keys", {
        method: "POST",
        body: { name: name.trim(), scopes: write ? ["read", "write"] : ["read"], expiresInDays: expiry === "never" ? null : Number(expiry) },
      });
      setCreated(data);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" />
                {created.apiKey.name} is ready
              </DialogTitle>
              <DialogDescription>Store it in your app&apos;s secrets now. This is the only time the full key is shown.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <CopyField
                label="API key"
                value={created.key}
                secret
                hint={`Scopes: ${created.apiKey.scopes.join(", ")} · recognise it later by ${created.apiKey.prefix}…`}
              />
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                I&apos;ve stored it
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>One key per app makes it easy to revoke just that app later.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Shop backend, Zapier, monthly script…"
                />
              </div>
              <div className="space-y-2">
                <Label>Scopes</Label>
                <Label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 font-normal">
                  <Checkbox checked disabled className="mt-0.5" />
                  <span>
                    Read
                    <span className="block text-[11px] text-muted-foreground">Accounts, transactions and the monthly summary.</span>
                  </span>
                </Label>
                <Label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 font-normal">
                  <Checkbox checked={write} onCheckedChange={(checked) => setWrite(checked === true)} className="mt-0.5" />
                  <span>
                    Write
                    <span className="block text-[11px] text-muted-foreground">
                      Create transactions, revenue and expenses. They arrive as drafts unless the request asks to post.
                    </span>
                  </span>
                </Label>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-expiry`}>Expiry</Label>
                <Select value={expiry} onValueChange={(v) => typeof v === "string" && setExpiry(v)}>
                  <SelectTrigger id={`${id}-expiry`}>
                    <SelectValue>{EXPIRY.find((e) => e.value === expiry)?.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {error && (
                <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
                  {error}
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving} disabled={!name.trim()}>
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}

// ------------------------------------------------------------------ docs

const ENDPOINTS: Array<{ method: "GET" | "POST"; path: string; scope: "read" | "write"; description: string }> = [
  { method: "GET", path: "/v1/accounts", scope: "read", description: "Accounts with balances (account and base currency)" },
  {
    method: "GET",
    path: "/v1/transactions",
    scope: "read",
    description: "Transactions: page, pageSize ≤ 100, from, to, type, status, accountId, categoryId, projectId, q",
  },
  { method: "GET", path: "/v1/summary", scope: "read", description: "This month's income, expense and net in the base currency" },
  { method: "POST", path: "/v1/revenue", scope: "write", description: "Record revenue (income). Idempotent by external_id" },
  { method: "POST", path: "/v1/expenses", scope: "write", description: "Record an expense. Idempotent by external_id" },
  { method: "POST", path: "/v1/transactions", scope: "write", description: "Any ledger transaction. Idempotent when externalId is sent" },
];

const ERRORS: Array<[string, string]> = [
  ["400 validation_failed", "The body is invalid; `issues` lists each field."],
  ["401 missing_api_key / invalid_api_key", "No key, or a key that is wrong, revoked or expired."],
  ["403 insufficient_scope", "A read-only key tried to write."],
  ["422 missing_account", '`status: "posted"` needs `account_id`.'],
  ["429 rate_limited", "More than 120 requests a minute with one key."],
];

// ------------------------------------------------------------------- MCP

const MCP_READ_TOOLS = [
  "get_setup",
  "get_summary",
  "get_spending",
  "get_category_breakdown",
  "get_top_payees",
  "compare_periods",
  "get_balances",
  "get_net_worth",
  "get_upcoming_payments",
  "get_subscriptions",
  "get_budgets",
  "get_cash_forecast",
  "get_receivables",
  "get_liabilities",
  "get_goals",
  "search_transactions",
];
const MCP_WRITE_TOOLS = [
  "record_transaction",
  "update_transaction",
  "create_category",
  "create_account",
  "create_subscription",
  "create_recurring",
  "create_budget",
  "create_goal",
  "create_rule",
  "create_receivable",
  "create_liability",
  "remember",
  "forget",
];

/**
 * Connecting an AI agent (Claude Desktop, Claude Code, Cursor…) over MCP. The
 * same API keys: read keys can ask, write keys can also record and create.
 */
function McpDocs({ origin }: { origin: string }) {
  const url = `${origin}/api/mcp`;
  const claudeCode = `claude mcp add --transport http financeos ${url} \\
  --header "Authorization: Bearer ew_live_…"`;
  const cursor = `{
  "mcpServers": {
    "financeos": {
      "url": "${url}",
      "headers": { "Authorization": "Bearer ew_live_…" }
    }
  }
}`;
  const desktop = `{
  "mcpServers": {
    "financeos": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${url}", "--header", "Authorization:\${FINANCEOS_AUTH}"],
      "env": { "FINANCEOS_AUTH": "Bearer ew_live_…" }
    }
  }
}`;
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <Bot className="size-4 text-violet-600 dark:text-violet-400" aria-hidden /> AI agents (MCP)
        </span>
      }
      hint="Let Claude, Cursor or any MCP client read your books and, with a write key, record expenses and set things up — using the same checks and audit trail as the app."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <CopyField label="MCP endpoint (Streamable HTTP)" value={url} />
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Authentication.</span> Create an API key above and send it as{" "}
              <code className="font-mono">Authorization: Bearer ew_live_…</code>. The key decides the workspace.
            </p>
            <p>
              <span className="font-medium text-foreground">Read keys</span> get the questions: balances, spending, budgets, bills, net worth, search.{" "}
              <span className="font-medium text-foreground">Write keys</span> also record transactions and create categories, accounts, subscriptions, budgets,
              goals and rules. Writes happen at once (your agent asks you first); large amounts wait for review if you set a review threshold.
            </p>
            <p>
              <span className="font-medium text-foreground">In the app,</span> the{" "}
              <Link href="/ai/copilot" className="underline underline-offset-2 hover:text-foreground">
                Copilot
              </Link>{" "}
              does the same from chat, with a confirm card for every change.
            </p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Tools</p>
            <div className="flex flex-wrap gap-1">
              {MCP_READ_TOOLS.map((tool) => (
                <Badge key={tool} variant="outline" className="font-mono text-[10px]">
                  {tool}
                </Badge>
              ))}
              {MCP_WRITE_TOOLS.map((tool) => (
                <Badge key={tool} variant="secondary" className="font-mono text-[10px]" title="Needs a key with the write scope">
                  {tool}
                </Badge>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">Shaded tools need the write scope.</p>
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">Claude Code</p>
            <CodeBlock code={claudeCode} language="bash" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Cursor, Windsurf and clients that take a URL (mcp.json)</p>
            <CodeBlock code={cursor} language="json" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Claude Desktop (claude_desktop_config.json)</p>
            <CodeBlock code={desktop} language="json" />
          </div>
        </div>
      </div>
    </Section>
  );
}

function ApiDocs({ origin }: { origin: string }) {
  const base = `${origin}/api/v1`;
  const revenue = `curl -X POST ${base}/revenue \\
  -H "Authorization: Bearer $FINANCEOS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "order_1001",
    "amount": 1499.50,
    "amount_unit": "major",
    "currency": "BDT",
    "date": "2026-09-21",
    "customer": "Rafiq Ahmed",
    "product": "Handloom saree",
    "category": "Product sales",
    "account_id": "<account id from GET /v1/accounts>",
    "status": "posted",
    "metadata": { "channel": "website" }
  }'`;
  const expense = `curl -X POST ${base}/expenses \\
  -H "Authorization: Bearer $FINANCEOS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "bill_2026_09_link3",
    "amount": 150000,
    "currency": "BDT",
    "date": "2026-09-12",
    "vendor": "Link3 Technologies",
    "category": "Internet",
    "description": "September internet bill"
  }'`;
  const read = `curl "${base}/transactions?from=2026-09-01&type=income&pageSize=20" \\
  -H "Authorization: Bearer $FINANCEOS_API_KEY"

curl ${base}/summary -H "Authorization: Bearer $FINANCEOS_API_KEY"`;
  const response = `{
  "id": "0199…",
  "duplicate": false,
  "status": "posted",
  "transaction": { "id": "0199…", "type": "income", "amount": 149950, "currency": "BDT", "source": "api", "externalId": "order_1001", … },
  "warnings": []
}`;

  return (
    <Section title="Public API v1" hint="REST over HTTPS with JSON. Everything a key writes is audited as the API.">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <CopyField label="Base URL" value={base} />
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Authentication.</span> Send the key as{" "}
              <code className="font-mono">Authorization: Bearer ew_live_…</code>. Read scope for GET, write scope for anything else.
            </p>
            <p>
              <span className="font-medium text-foreground">Money.</span> Amounts are integers in minor units (poisha, cents): 149950 is ৳1,499.50. On revenue
              and expenses you can send <code className="font-mono">&quot;amount_unit&quot;: &quot;major&quot;</code> and 1499.50 instead. Dates are{" "}
              <code className="font-mono">YYYY-MM-DD</code>.
            </p>
            <p>
              <span className="font-medium text-foreground">Idempotency.</span> Sending the same <code className="font-mono">external_id</code> (or{" "}
              <code className="font-mono">externalId</code>) again never creates a second record: you get the original back with{" "}
              <code className="font-mono">duplicate: true</code> and HTTP 200 instead of 201. Retries are always safe.
            </p>
            <p>
              <span className="font-medium text-foreground">Review.</span> New records are drafts for review unless you send{" "}
              <code className="font-mono">&quot;status&quot;: &quot;posted&quot;</code> (with an account). Category and project are matched by name; unknown
              names come back as <code className="font-mono">warnings</code>.
            </p>
            <p>
              <span className="font-medium text-foreground">Rate limit.</span> 120 requests a minute per key.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Endpoint</th>
                <th className="hidden sm:table-cell">Scope</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ENDPOINTS.map((endpoint) => (
                <tr key={`${endpoint.method} ${endpoint.path}`} className="align-top [&>td]:px-3 [&>td]:py-2">
                  <td className="whitespace-nowrap font-mono">
                    <span className={endpoint.method === "GET" ? "text-sky-600 dark:text-sky-400" : "text-emerald-600 dark:text-emerald-400"}>
                      {endpoint.method}
                    </span>{" "}
                    {endpoint.path}
                  </td>
                  <td className="hidden sm:table-cell">
                    <Badge variant={endpoint.scope === "write" ? "warning" : "outline"} size="sm">
                      {endpoint.scope}
                    </Badge>
                  </td>
                  <td className="text-muted-foreground">{endpoint.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Record revenue</p>
          <CodeBlock code={revenue} language="curl" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Record an expense (a draft to review)</p>
          <CodeBlock code={expense} language="curl" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Read</p>
          <CodeBlock code={read} language="curl" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Response (201 created, or 200 with duplicate: true)</p>
          <CodeBlock code={response} language="json" />
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Errors</p>
        <ul className="divide-y divide-border rounded-lg border border-border text-xs">
          {ERRORS.map(([code, meaning]) => (
            <li key={code} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-3">
              <code className="shrink-0 font-mono sm:w-64">{code}</code>
              <span className="text-muted-foreground">{meaning}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Errors are JSON: <code className="font-mono">{"{ statusCode, error, message, issues? }"}</code>.
        </p>
      </div>
    </Section>
  );
}

function WebhookDocs({ customWebhooks }: { customWebhooks: Connection[] }) {
  const { canManage } = useApp();
  const node = `import { createHmac } from "node:crypto";

const url = process.env.FINANCEOS_WEBHOOK_URL;       // from the connection page
const secret = process.env.FINANCEOS_WEBHOOK_SECRET; // shown once, when connected

const body = JSON.stringify({
  id: "order_1001",            // your event id: sending it twice is safe
  type: "revenue",             // "transaction" | "revenue" | "expense"
  data: {
    amount: 149950,            // minor units (or "amount_unit": "major")
    currency: "BDT",
    date: "2026-09-21",
    customer: "Rafiq Ahmed",
    product: "Handloom saree",
  },
});
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", secret).update(\`\${timestamp}.\${body}\`).digest("hex");

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-FinanceOS-Timestamp": timestamp,
    "X-FinanceOS-Signature": \`sha256=\${signature}\`,
  },
  body, // send exactly the bytes you signed
});
console.log(response.status, await response.json()); // 200 { status: "received" | "duplicate" }`;
  const shell = `BODY='{"id":"order_1001","type":"revenue","data":{"amount":149950,"currency":"BDT","date":"2026-09-21","customer":"Rafiq Ahmed"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$FINANCEOS_WEBHOOK_SECRET" -hex | sed 's/^.* //')

curl -X POST "$FINANCEOS_WEBHOOK_URL" \\
  -H "Content-Type: application/json" \\
  -H "X-FinanceOS-Timestamp: $TS" \\
  -H "X-FinanceOS-Signature: sha256=$SIG" \\
  --data "$BODY"`;
  const payload = `{
  "id": "evt_or_order_id",          // idempotency key (required)
  "type": "transaction" | "revenue" | "expense",
  "data": {
    "amount": 149950,               // number, > 0
    "amount_unit": "minor",         // or "major" (1499.50)
    "currency": "BDT",
    "date": "YYYY-MM-DD",
    "occurred_at": "2026-09-21T10:15:00+06:00",  // optional
    "description": "…", "category": "Product sales", "project": "Website",
    "reference": "INV-1001", "external_id": "…",  // external_id defaults to id
    "metadata": { },                // up to 8 KB
    // revenue: "customer", "product", "source"
    // expense: "vendor"
    // transaction: "type" (expense, income, refund, transfer, …), "direction", "counterparty"
  }
}`;
  return (
    <Section title="Custom webhooks" hint="Push events from your own app the moment they happen.">
      <div id="webhooks" className="grid scroll-mt-16 gap-4 lg:grid-cols-2">
        <div className="space-y-3 text-xs text-muted-foreground">
          <p>
            Create a <span className="font-medium text-foreground">Custom webhook</span> connection to get a private URL and a signing secret. Your app POSTs
            one JSON event per request; each is verified, stored once per <code className="font-mono">id</code>, and imported through the same rules and
            duplicate checks as a sync.
          </p>
          <div className="space-y-1">
            <p className="font-medium text-foreground">Signature</p>
            <p>
              <code className="font-mono">X-FinanceOS-Timestamp</code>: the current Unix time in seconds.
            </p>
            <p>
              <code className="font-mono">X-FinanceOS-Signature</code>: <code className="font-mono">sha256=</code> followed by the hex HMAC-SHA256 of{" "}
              <code className="font-mono">{"<timestamp>.<raw body>"}</code> (the timestamp, a dot, then the exact bytes you send), keyed with the
              connection&apos;s secret.
            </p>
            <p>Signing the timestamp stops replays: requests more than five minutes old or new are refused, as is any change to the body after signing.</p>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground">Responses</p>
            <p>
              <code className="font-mono">200 {'{ status: "received" }'}</code> accepted and queued ·{" "}
              <code className="font-mono">200 {'{ status: "duplicate" }'}</code> this id was already received · <code className="font-mono">401</code> bad or
              stale signature (recorded on the connection) · <code className="font-mono">400 invalid_event</code> the body does not match the shape ·{" "}
              <code className="font-mono">429</code> slow down.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {customWebhooks.map((connection) => (
              <Button key={connection.id} size="xs" variant="outline" render={<Link href={`/integrations/${connection.id}`} />}>
                <Webhook className="size-3.5" /> {connection.name}
              </Button>
            ))}
            {canManage && (
              <Button size="xs" render={<Link href="/integrations?connect=generic_webhook" />}>
                <Plus className="size-3.5" /> New custom webhook
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Event body</p>
          <CodeBlock code={payload} language="json" />
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Node.js</p>
          <CodeBlock code={node} language="js" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Shell (curl + openssl)</p>
          <CodeBlock code={shell} language="sh" />
        </div>
      </div>
    </Section>
  );
}
