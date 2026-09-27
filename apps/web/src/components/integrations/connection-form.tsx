"use client";

import { CircleAlert, CircleCheck, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi } from "@/lib/api/client";
import { ApiError } from "@/lib/api/shared";
import type { Account, Project } from "@/lib/api/types";
import type { CatalogEntry, Connection, ConnectResult, FieldSpec, SyncFrequency, TrustLevel, UpdateResult, WebhookReveal } from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { CopyField, FREQUENCY_LABEL, ProviderTile } from "./shared";

const AUTO = "__auto__";
const NONE = "__none__";

type Values = Record<string, string | boolean>;
type FieldErrors = Record<string, string>;

/** Form values for a set of fields, from stored config (json fields as pretty text). */
export function valuesFromConfig(fields: FieldSpec[], config: Record<string, unknown> = {}): Values {
  const values: Values = {};
  for (const field of fields) {
    const stored = config[field.key] ?? field.default;
    if (field.type === "boolean") values[field.key] = stored === true;
    else if (field.type === "json") values[field.key] = stored === undefined || stored === null ? "" : JSON.stringify(stored, null, 2);
    else values[field.key] = stored === undefined || stored === null ? "" : String(stored);
  }
  return values;
}

/** Turns form values into the API's shape; returns per-field errors instead of throwing. */
function toPayload(fields: FieldSpec[], values: Values, section: "credentials" | "config", options: { keepEmpty?: boolean } = {}) {
  const out: Record<string, unknown> = {};
  const errors: FieldErrors = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === "boolean") {
      out[field.key] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
      if (field.required && section === "config") errors[`${section}.${field.key}`] = `${field.label} is required`;
      if (field.required && section === "credentials" && !options.keepEmpty) errors[`${section}.${field.key}`] = `${field.label} is required`;
      if (section === "config" && options.keepEmpty) out[field.key] = null;
      continue;
    }
    if (field.type === "json") {
      try {
        out[field.key] = JSON.parse(text);
      } catch {
        errors[`${section}.${field.key}`] = "This is not valid JSON";
      }
    } else if (field.type === "number") {
      const number = Number(text);
      if (!Number.isFinite(number)) errors[`${section}.${field.key}`] = "Enter a number";
      else out[field.key] = number;
    } else out[field.key] = text;
  }
  return { payload: out, errors };
}

/** API validation issues (`credentials.secretKey`, `config.endpoints.0.path`) keyed by the field they belong to. */
function issuesByField(error: unknown): { fields: FieldErrors; message: string } {
  if (!(error instanceof ApiError)) return { fields: {}, message: error instanceof Error ? error.message : "Something went wrong. Try again." };
  const fields: FieldErrors = {};
  for (const issue of error.body?.issues ?? []) {
    const [section, key] = issue.path.split(".");
    if ((section === "credentials" || section === "config") && key && !fields[`${section}.${key}`]) fields[`${section}.${key}`] = issue.message;
  }
  return { fields, message: error.message };
}

export function FieldInput({
  field,
  value,
  onChange,
  error,
  accounts,
  placeholder,
}: {
  field: FieldSpec;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
  error?: string;
  accounts: Account[];
  placeholder?: string;
}) {
  const id = useId();
  const text = typeof value === "string" ? value : "";
  const help = field.help && <p className="text-[11px] leading-snug text-muted-foreground">{field.help}</p>;
  const invalid = error ? true : undefined;

  if (field.type === "boolean") {
    return (
      <Label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 font-normal">
        <span>
          {field.label}
          {help}
        </span>
        <Switch checked={value === true} onCheckedChange={onChange} />
      </Label>
    );
  }

  let control: ReactNode;
  if (field.type === "select" || field.type === "account") {
    const options =
      field.type === "account" ? accounts.map((account) => ({ value: account.id, label: `${account.name} · ${account.currency}` })) : (field.options ?? []);
    const current = options.find((option) => option.value === text);
    control = (
      <Select value={text || NONE} onValueChange={(v) => typeof v === "string" && onChange(v === NONE ? "" : v)}>
        <SelectTrigger id={id} aria-invalid={invalid}>
          <SelectValue>{current?.label ?? (field.type === "account" ? "No account" : "Choose…")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {!field.required && <SelectItem value={NONE}>{field.type === "account" ? "No account" : "Not set"}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (field.type === "json") {
    control = (
      <Textarea
        id={id}
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        spellCheck={false}
        aria-invalid={invalid}
        className="font-mono text-xs"
      />
    );
  } else {
    control = (
      <Input
        id={id}
        type={field.type === "password" ? "password" : field.type === "url" ? "url" : "text"}
        inputMode={field.type === "number" ? "numeric" : undefined}
        autoComplete={field.type === "password" ? "new-password" : "off"}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? field.placeholder}
        aria-invalid={invalid}
        className={cn(field.type === "password" && "font-mono")}
      />
    );
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {field.label}
        {field.required && <span className="text-muted-foreground"> *</span>}
      </Label>
      {control}
      {error ? <p className="text-[11px] text-destructive-foreground">{error}</p> : help}
    </div>
  );
}

function SectionTitle({ icon: Icon, children, hint }: { icon?: typeof KeyRound; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="pt-1">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {children}
      </h3>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TrustChoice({ value, onChange }: { value: TrustLevel; onChange: (value: TrustLevel) => void }) {
  const options: Array<{ value: TrustLevel; title: string; body: string }> = [
    { value: "review", title: "Review first", body: "Records arrive as drafts. You confirm them before they touch balances." },
    { value: "trusted", title: "Post automatically", body: "Records post straight to the ledger. Possible duplicates still wait for you." },
  ];
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">How new records arrive</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
            value === option.value ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40",
          )}
        >
          <span className="font-medium">{option.title}</span>
          <span className="block text-[11px] leading-snug text-muted-foreground">{option.body}</span>
        </button>
      ))}
    </fieldset>
  );
}

function FrequencySelect({ value, onChange }: { value: SyncFrequency; onChange: (value: SyncFrequency) => void }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Sync</Label>
      <Select value={value} onValueChange={(v) => typeof v === "string" && onChange(v as SyncFrequency)}>
        <SelectTrigger id={id}>
          <SelectValue>{FREQUENCY_LABEL[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(["hourly", "daily", "manual"] as const).map((frequency) => (
            <SelectItem key={frequency} value={frequency}>
              {FREQUENCY_LABEL[frequency]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AccountSelect({
  value,
  onChange,
  accounts,
  entry,
}: {
  value: string;
  onChange: (value: string) => void;
  accounts: Account[];
  entry: Pick<CatalogEntry, "requiresAccount" | "createsAccount">;
}) {
  const id = useId();
  const label =
    value === AUTO ? "Create one automatically" : value === NONE ? "No default account" : (accounts.find((a) => a.id === value)?.name ?? "Choose an account");
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Account{entry.requiresAccount && !entry.createsAccount && <span className="text-muted-foreground"> *</span>}</Label>
      <Select value={value} onValueChange={(v) => typeof v === "string" && onChange(v)}>
        <SelectTrigger id={id}>
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {entry.createsAccount && <SelectItem value={AUTO}>Create one automatically</SelectItem>}
          {!entry.requiresAccount && <SelectItem value={NONE}>No default account</SelectItem>}
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.name} · {account.currency}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {entry.createsAccount
          ? "Where records land. We can create a matching account (with the right currency) for you."
          : entry.requiresAccount
            ? "Where records land."
            : "Where records land when the source does not name an account. Without one, records wait for you to choose."}
      </p>
    </div>
  );
}

function ProjectSelect({ value, onChange, projects }: { value: string; onChange: (value: string) => void; projects: Project[] }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Project</Label>
      <Select value={value} onValueChange={(v) => typeof v === "string" && onChange(v)}>
        <SelectTrigger id={id}>
          <SelectValue>{value === NONE ? "No default project" : (projects.find((p) => p.id === value)?.name ?? "Project")}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No default project</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">Records without a project of their own are assigned to this one.</p>
    </div>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** URL and secret of a webhook endpoint, shown once. */
export function WebhookRevealPanel({ reveal, providerName }: { reveal: WebhookReveal; providerName: string }) {
  if (reveal.secretSource === "provider") {
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium">Webhook endpoint</p>
        <CopyField label="Endpoint URL" value={reveal.url} />
        <p className="text-xs text-muted-foreground">
          Add this URL as a webhook endpoint in {providerName}, then paste the signing secret {providerName} gives you into this connection&apos;s credentials.
          Events are verified with that secret{reveal.signatureHeader ? ` (${reveal.signatureHeader} header)` : ""}.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldCheck className="size-4 text-amber-600 dark:text-amber-400" />
        Webhook endpoint and signing secret
      </p>
      <CopyField label="Endpoint URL" value={reveal.url} />
      <CopyField
        label="Signing secret"
        value={reveal.secret}
        secret
        hint="Copy it now: you won't see this secret again. Rotate it from the connection if it is ever lost."
      />
      {reveal.signatureHeader && <p className="text-[11px] text-muted-foreground">Signatures arrive in the {reveal.signatureHeader} header.</p>}
    </div>
  );
}

/** Connect a provider from the catalog. The form is generated from its field metadata. */
export function ConnectDialog({
  entry,
  open,
  onOpenChange,
  accounts,
  projects,
}: {
  entry: CatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  projects: Project[];
}) {
  const router = useRouter();
  const { isBusiness } = useApp();
  const nameId = useId();
  const [name, setName] = useState("");
  const [credentials, setCredentials] = useState<Values>({});
  const [config, setConfig] = useState<Values>({});
  const [accountId, setAccountId] = useState(AUTO);
  const [projectId, setProjectId] = useState(NONE);
  const [frequency, setFrequency] = useState<SyncFrequency>("daily");
  const [trust, setTrust] = useState<TrustLevel>("review");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);

  // Reset only when the dialog opens for a provider. The refresh after connecting brings a
  // new accounts list; resetting on that would wipe the result and its one-time secret.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const provider = entry?.provider;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on opening and the provider only (see above)
  useEffect(() => {
    if (!open || !entry) return;
    setName(entry.displayName);
    setCredentials(valuesFromConfig(entry.credentialFields));
    setConfig(valuesFromConfig(entry.configFields));
    setAccountId(entry.createsAccount ? AUTO : entry.requiresAccount ? (accountsRef.current[0]?.id ?? AUTO) : NONE);
    setProjectId(NONE);
    setFrequency(entry.capabilities.sync ? (entry.defaultSyncFrequency ?? "daily") : "manual");
    setTrust("review");
    setFieldErrors({});
    setError(null);
    setResult(null);
  }, [open, provider]);

  if (!entry) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const creds = toPayload(entry.credentialFields, credentials, "credentials");
    const settings = toPayload(entry.configFields, config, "config");
    const errors = { ...creds.errors, ...settings.errors };
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    if (entry.requiresAccount && !entry.createsAccount && (accountId === AUTO || accountId === NONE))
      return setError("Choose the account these records land in");
    setSaving(true);
    try {
      const data = await clientApi<ConnectResult>("/integrations", {
        method: "POST",
        body: {
          provider: entry.provider,
          name: name.trim() || entry.displayName,
          credentials: Object.fromEntries(Object.entries(creds.payload).filter(([, v]) => typeof v === "string" && v)),
          config: settings.payload,
          accountId: accountId === AUTO || accountId === NONE ? null : accountId,
          projectId: projectId === NONE ? null : projectId,
          syncFrequency: frequency,
          trustLevel: trust,
        },
      });
      setResult(data);
      invalidateApiCache("/integrations");
      invalidateApiCache("/accounts");
      router.refresh();
    } catch (err) {
      const parsed = issuesByField(err);
      setFieldErrors(parsed.fields);
      setError(parsed.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-lg">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheck className="size-5 text-emerald-600 dark:text-emerald-400" />
                {result.connection.name} is connected
              </DialogTitle>
              <DialogDescription>{result.validation?.message ?? `${entry.displayName} is ready.`}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              {result.createdAccount && (
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
                  Records land in a new account,{" "}
                  <Link href={`/accounts/${result.createdAccount.id}`} className="font-medium underline-offset-4 hover:underline">
                    {result.createdAccount.name}
                  </Link>{" "}
                  ({result.createdAccount.currency}).
                </p>
              )}
              {result.initialSyncRunId && (
                <p className="rounded-lg bg-sky-500/10 px-3 py-2 text-sm text-sky-700 dark:text-sky-300">
                  The first sync has started.{" "}
                  <Link
                    href={`/integrations/${result.connection.id}?tab=runs&run=${result.initialSyncRunId}`}
                    className="font-medium underline underline-offset-4"
                  >
                    Follow its progress
                  </Link>
                </p>
              )}
              {result.webhook && <WebhookRevealPanel reveal={result.webhook} providerName={entry.displayName} />}
              {result.connection.trustLevel === "review" && (
                <p className="text-xs text-muted-foreground">
                  Imported records arrive as drafts to review. Switch the connection to “Post automatically” once you trust it.
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button size="sm" onClick={() => router.push(`/integrations/${result.connection.id}`)}>
                Open connection
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <ProviderTile icon={entry.icon} category={entry.category} size="lg" />
                <div className="min-w-0">
                  <DialogTitle>Connect {entry.displayName}</DialogTitle>
                  <DialogDescription className="line-clamp-2">{entry.description}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor={nameId}>Name</Label>
                <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={entry.displayName} />
              </div>
              {entry.credentialFields.length > 0 && (
                <>
                  <SectionTitle icon={KeyRound} hint="Encrypted as soon as they arrive and never shown again.">
                    Credentials
                  </SectionTitle>
                  {entry.credentialFields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={credentials[field.key]}
                      onChange={(v) => setCredentials((current) => ({ ...current, [field.key]: v }))}
                      error={fieldErrors[`credentials.${field.key}`]}
                      accounts={accounts}
                    />
                  ))}
                </>
              )}
              {entry.configFields.length > 0 && (
                <>
                  <SectionTitle>Settings</SectionTitle>
                  {entry.configFields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={config[field.key]}
                      onChange={(v) => setConfig((current) => ({ ...current, [field.key]: v }))}
                      error={fieldErrors[`config.${field.key}`]}
                      accounts={accounts}
                    />
                  ))}
                </>
              )}
              <SectionTitle>Where records go</SectionTitle>
              <AccountSelect value={accountId} onChange={setAccountId} accounts={accounts} entry={entry} />
              {isBusiness && <ProjectSelect value={projectId} onChange={setProjectId} projects={projects} />}
              {entry.capabilities.sync && <FrequencySelect value={frequency} onChange={setFrequency} />}
              <div className="space-y-1">
                <Label>How new records arrive</Label>
                <TrustChoice value={trust} onChange={setTrust} />
              </div>
              {error && <ErrorNote>{error}</ErrorNote>}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                {entry.capabilities.testConnection ? "Test and connect" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Edit a connection: name, sync, trust, account/project, settings, and
 * (optionally) replace every credential. On a disconnected connection,
 * saving credentials reconnects it.
 */
export function EditConnectionDialog({
  connection,
  entry,
  open,
  onOpenChange,
  accounts,
  projects,
  reconnect,
  onRevealed,
}: {
  connection: Connection;
  entry: CatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  projects: Project[];
  /** Opened to reconnect: credentials are part of the form. */
  reconnect?: boolean;
  onRevealed?: (reveal: WebhookReveal) => void;
}) {
  const router = useRouter();
  const { isBusiness } = useApp();
  const nameId = useId();
  const credentialFields = entry?.credentialFields ?? [];
  const configFields = entry?.configFields ?? [];
  const [name, setName] = useState(connection.name);
  const [config, setConfig] = useState<Values>({});
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const [credentials, setCredentials] = useState<Values>({});
  const [accountId, setAccountId] = useState(NONE);
  const [projectId, setProjectId] = useState(NONE);
  const [frequency, setFrequency] = useState<SyncFrequency>(connection.syncFrequency);
  const [trust, setTrust] = useState<TrustLevel>(connection.trustLevel);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setName(connection.name);
    setConfig(valuesFromConfig(configFields, connection.config));
    setReplaceCredentials(Boolean(reconnect));
    setCredentials(valuesFromConfig(credentialFields));
    setAccountId(connection.accountId ?? NONE);
    setProjectId(connection.projectId ?? NONE);
    setFrequency(connection.syncFrequency);
    setTrust(connection.trustLevel);
    setFieldErrors({});
    setError(null);
  }, [open, connection, reconnect]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const settings = toPayload(configFields, config, "config", { keepEmpty: true });
    const creds = replaceCredentials ? toPayload(credentialFields, credentials, "credentials") : { payload: {}, errors: {} };
    const errors = { ...settings.errors, ...creds.errors };
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    const original = toPayload(configFields, valuesFromConfig(configFields, connection.config), "config", { keepEmpty: true }).payload;
    const configChanged = JSON.stringify(original) !== JSON.stringify(settings.payload);
    setSaving(true);
    try {
      const data = await clientApi<UpdateResult>(`/integrations/${connection.id}`, {
        method: "PATCH",
        body: {
          name: name.trim() || connection.name,
          // Only changed settings are sent: a config change re-tests the connection.
          ...(configChanged ? { config: settings.payload } : {}),
          accountId: accountId === NONE ? null : accountId,
          projectId: projectId === NONE ? null : projectId,
          ...(connection.capabilities.sync ? { syncFrequency: frequency } : {}),
          trustLevel: trust,
          ...(replaceCredentials ? { credentials: Object.fromEntries(Object.entries(creds.payload).filter(([, v]) => typeof v === "string" && v)) } : {}),
        },
      });
      toast.success(reconnect ? "Reconnected" : "Connection updated");
      invalidateApiCache("/integrations");
      if (data.webhook) onRevealed?.(data.webhook);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const parsed = issuesByField(err);
      setFieldErrors(parsed.fields);
      setError(parsed.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{reconnect ? `Reconnect ${connection.name}` : `Edit ${connection.name}`}</DialogTitle>
            <DialogDescription>
              {reconnect ? "Enter the credentials again. History and settings are kept." : `${connection.displayName} · changes apply from the next sync.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={nameId}>Name</Label>
              <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </div>
            {(credentialFields.length > 0 || reconnect) && (
              <>
                <SectionTitle icon={KeyRound} hint="Saved credentials are never shown. Replacing them tests the connection again.">
                  Credentials
                </SectionTitle>
                {!reconnect && (
                  <Label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 font-normal">
                    <span>
                      Replace credentials
                      <span className="block text-[11px] text-muted-foreground">
                        {connection.credentials.filter((c) => c.set).length
                          ? `Saved: ${connection.credentials
                              .filter((c) => c.set)
                              .map((c) => `${c.label} ${c.masked ?? ""}`)
                              .join(", ")}`
                          : "No credentials saved"}
                      </span>
                    </span>
                    <Switch checked={replaceCredentials} onCheckedChange={setReplaceCredentials} />
                  </Label>
                )}
                {replaceCredentials &&
                  credentialFields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={credentials[field.key]}
                      onChange={(v) => setCredentials((current) => ({ ...current, [field.key]: v }))}
                      error={fieldErrors[`credentials.${field.key}`]}
                      accounts={accounts}
                    />
                  ))}
                {replaceCredentials && credentialFields.length === 0 && (
                  <p className="text-xs text-muted-foreground">{connection.displayName} needs no credentials: saving reconnects it.</p>
                )}
              </>
            )}
            {configFields.length > 0 && (
              <>
                <SectionTitle>Settings</SectionTitle>
                {configFields.map((field) => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={config[field.key]}
                    onChange={(v) => setConfig((current) => ({ ...current, [field.key]: v }))}
                    error={fieldErrors[`config.${field.key}`]}
                    accounts={accounts}
                  />
                ))}
              </>
            )}
            <SectionTitle>Where records go</SectionTitle>
            <AccountSelect
              value={accountId}
              onChange={setAccountId}
              accounts={accounts}
              entry={{ requiresAccount: entry?.requiresAccount ?? false, createsAccount: false }}
            />
            {isBusiness && <ProjectSelect value={projectId} onChange={setProjectId} projects={projects} />}
            {connection.capabilities.sync && <FrequencySelect value={frequency} onChange={setFrequency} />}
            <div className="space-y-1">
              <Label>How new records arrive</Label>
              <TrustChoice value={trust} onChange={setTrust} />
            </div>
            {entry?.website && (
              <a
                href={entry.website}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {entry.displayName} website <ExternalLink className="size-3" />
              </a>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {reconnect ? "Reconnect" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
