"use client";

import type { StorageConfigInput, StorageConfigView, StorageProvider, StorageTestResult } from "@financeos/core";
import { r2AccountId } from "@financeos/core";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  CloudUpload,
  Copy,
  ExternalLink,
  FlaskConical,
  HardDrive,
  KeyRound,
  Loader2,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Section } from "@/components/app/blocks";
import { OptionSelect } from "@/components/planning/shared";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import { ApiError } from "@/lib/api/shared";
import { cn } from "@/lib/cn";
import { formatBytes, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

type Form = {
  provider: StorageProvider;
  accountId: string;
  jurisdiction: "default" | "eu";
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
};

const JURISDICTIONS = [
  { value: "default", label: "Automatic (default)" },
  { value: "eu", label: "European Union" },
];

function formFor(view: StorageConfigView): Form {
  const saved = view.saved;
  return {
    provider: saved?.provider ?? "r2",
    accountId: saved?.accountId ?? "",
    jurisdiction: saved?.jurisdiction ?? "default",
    endpoint: saved?.endpoint ?? "",
    region: saved?.region ?? "us-east-1",
    bucket: saved?.bucket ?? "",
    accessKeyId: saved?.accessKeyId ?? "",
    secretAccessKey: "",
    forcePathStyle: saved?.forcePathStyle ?? false,
    prefix: saved?.prefix ?? "",
  };
}

function toInput(form: Form): StorageConfigInput {
  const common = {
    bucket: form.bucket.trim(),
    accessKeyId: form.accessKeyId.trim(),
    ...(form.secretAccessKey.trim() ? { secretAccessKey: form.secretAccessKey.trim() } : {}),
    prefix: form.prefix.trim() || null,
  };
  return form.provider === "r2"
    ? { provider: "r2", accountId: form.accountId.trim(), jurisdiction: form.jurisdiction, ...common }
    : { provider: "s3", endpoint: form.endpoint.trim() || null, region: form.region.trim() || "us-east-1", forcePathStyle: form.forcePathStyle, ...common };
}

/**
 * Admin → Storage: move receipts, screenshots and statements off the server's
 * disk into Cloudflare R2 (or any S3-compatible bucket). Test, save, then copy
 * the files already uploaded across in the background.
 */
export function StorageSettings({ view }: { view: StorageConfigView }) {
  const router = useRouter();
  const id = useId();
  const [form, setForm] = useState<Form>(() => formFor(view));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<StorageTestResult | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(!view.saved);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(view.saved?.prefix));
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
  };

  // While a copy runs, keep the counts moving.
  const copyRunning = view.copy?.status === "queued" || view.copy?.status === "running";
  useEffect(() => {
    if (!copyRunning) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [copyRunning, router]);

  const savedSecret =
    view.saved && view.saved.provider === form.provider && view.saved.accessKeyId === form.accessKeyId.trim() ? view.saved.secretAccessKey : null;
  const ready =
    form.bucket.trim().length >= 3 &&
    form.accessKeyId.trim().length > 0 &&
    (form.secretAccessKey.trim().length > 0 || Boolean(savedSecret?.set)) &&
    (form.provider === "s3" || form.accountId.trim().length > 0);

  const test = async () => {
    setTesting(true);
    try {
      const outcome = await clientApi<StorageTestResult>("/admin/storage/test", { method: "POST", body: { draft: toInput(form) } });
      setResult(outcome);
      if (outcome.ok) toast.success(outcome.message);
      else toast.error(outcome.message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await clientApi<StorageConfigView>("/admin/storage", { method: "PUT", body: toInput(form) });
      toast.success("Storage saved: new files go there from now on");
      setForm((f) => ({ ...f, secretAccessKey: "" }));
      setResult(null);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "storage_test_failed" && error.body?.issues) setResult(error.body.issues as unknown as StorageTestResult);
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    setCopying(true);
    try {
      await clientApi("/admin/storage/copy", { method: "POST" });
      toast.success("Copying in the background; this page updates as it goes");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCopying(false);
    }
  };

  const adminFiles = view.files.find((f) => f.backend === "admin")?.count ?? 0;
  const reset = async () => {
    try {
      await clientApi("/admin/storage", { method: "DELETE", query: { force: adminFiles > 0 ? "true" : undefined } });
      toast.success("Back to the server's .env storage");
      setResetOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <ActiveStatus view={view} />

      <Section title="Where files are now" hint="Every receipt, screenshot, statement and attachment, by where its bytes are stored.">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {view.files.map((row) => (
            <li key={row.backend} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg",
                  row.backend === "local" ? "bg-muted text-muted-foreground" : "bg-sky-500/10 text-sky-600 dark:text-sky-400",
                )}
              >
                {row.backend === "local" ? <HardDrive className="size-4" aria-hidden /> : <Cloud className="size-4" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {row.label}
                  {row.active && (
                    <span className="rounded-full bg-emerald-500/10 px-1.5 py-px text-[11px] font-normal text-emerald-700 dark:text-emerald-400">
                      New uploads
                    </span>
                  )}
                  {!row.readable && row.count > 0 && (
                    <span className="rounded-full bg-red-500/10 px-1.5 py-px text-[11px] font-normal text-red-700 dark:text-red-400">Can't be opened</span>
                  )}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">{row.location}</p>
              </div>
              <p className="text-sm tabular-nums">
                {row.count.toLocaleString()} file{row.count === 1 ? "" : "s"} <span className="text-muted-foreground">· {formatBytes(row.bytes)}</span>
              </p>
            </li>
          ))}
        </ul>
        {view.elsewhere > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 px-3 py-2.5">
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium tabular-nums">{view.elsewhere.toLocaleString()}</span> file{view.elsewhere === 1 ? " is" : "s are"} stored somewhere
              other than {view.active.label}. They still open from where they are; copy them across to keep everything in one place.
            </p>
            <Button size="sm" variant="outline" onClick={copy} loading={copying} disabled={copyRunning || Boolean(view.problem)}>
              <Copy aria-hidden /> Copy to {view.active.label}
            </Button>
          </div>
        )}
        {view.copy && <CopyStatus copy={view.copy} />}
      </Section>

      <Section
        title="Cloud storage"
        hint="Keep files in a bucket instead of on this server: they survive redeploys, and every server and worker sees the same files."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <ProviderCard
            selected={form.provider === "r2"}
            onSelect={() => set({ provider: "r2" })}
            title="Cloudflare R2"
            detail="No egress fees; S3-compatible. Recommended."
          />
          <ProviderCard
            selected={form.provider === "s3"}
            onSelect={() => set({ provider: "s3" })}
            title="Other S3-compatible"
            detail="AWS S3, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO…"
          />
        </div>

        {form.provider === "r2" && (
          <div className="rounded-xl border border-border bg-muted/30">
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium"
              aria-expanded={showHelp}
            >
              Where to find these in Cloudflare
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", showHelp && "rotate-180")} aria-hidden />
            </button>
            {showHelp && (
              <ol className="list-decimal space-y-1 px-3 pb-3 ps-8 text-sm text-muted-foreground">
                <li>
                  Cloudflare dashboard → <span className="text-foreground">R2 Object Storage</span> → create a bucket (keep it private; no public access is
                  needed).
                </li>
                <li>
                  <span className="text-foreground">Manage API tokens</span> → Create API token → permission{" "}
                  <span className="text-foreground">Object Read &amp; Write</span>, applied to that bucket only.
                </li>
                <li>
                  Copy the <span className="text-foreground">Access Key ID</span> and <span className="text-foreground">Secret Access Key</span> (the secret is
                  shown once).
                </li>
                <li>
                  The <span className="text-foreground">Account ID</span> is on the R2 overview page. Pasting the whole S3 API URL works too.
                </li>
                <li>
                  <a
                    href="https://developers.cloudflare.com/r2/api/tokens/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
                  >
                    Cloudflare's guide to R2 API tokens <ExternalLink className="size-3" aria-hidden />
                  </a>
                </li>
              </ol>
            )}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {form.provider === "r2" ? (
            <>
              <Field id={`${id}-account`} label="Account ID">
                <Input
                  id={`${id}-account`}
                  value={form.accountId}
                  onChange={(e) => set({ accountId: e.target.value })}
                  onBlur={() => form.accountId && set({ accountId: r2AccountId(form.accountId) })}
                  placeholder="32 characters, or the S3 API URL"
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              <Field id={`${id}-jurisdiction`} label="Data location">
                <OptionSelect
                  id={`${id}-jurisdiction`}
                  value={form.jurisdiction}
                  onChange={(v) => set({ jurisdiction: v as Form["jurisdiction"] })}
                  options={JURISDICTIONS}
                  placeholder="Automatic"
                />
              </Field>
            </>
          ) : (
            <>
              <Field id={`${id}-endpoint`} label="Endpoint URL" hint="Leave blank for AWS S3 itself.">
                <Input
                  id={`${id}-endpoint`}
                  value={form.endpoint}
                  onChange={(e) => set({ endpoint: e.target.value })}
                  placeholder="https://s3.us-west-004.backblazeb2.com"
                  inputMode="url"
                  autoComplete="off"
                />
              </Field>
              <Field id={`${id}-region`} label="Region">
                <Input id={`${id}-region`} value={form.region} onChange={(e) => set({ region: e.target.value })} placeholder="us-east-1" autoComplete="off" />
              </Field>
            </>
          )}
          <Field id={`${id}-bucket`} label="Bucket">
            <Input
              id={`${id}-bucket`}
              value={form.bucket}
              onChange={(e) => set({ bucket: e.target.value.toLowerCase() })}
              placeholder="financeos-files"
              autoComplete="off"
              className="font-mono"
            />
          </Field>
          <Field id={`${id}-key`} label="Access key ID">
            <Input
              id={`${id}-key`}
              value={form.accessKeyId}
              onChange={(e) => set({ accessKeyId: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field
            id={`${id}-secret`}
            label="Secret access key"
            hint={savedSecret?.set ? "Stored encrypted. Leave blank to keep the saved one." : "Stored encrypted and never shown again."}
            className="md:col-span-2"
          >
            <div className="relative">
              <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="new-password"
                className="[&_input]:ps-8"
                value={form.secretAccessKey}
                onChange={(e) => set({ secretAccessKey: e.target.value })}
                placeholder={savedSecret?.set ? `Saved ${savedSecret.masked ?? ""} — leave blank to keep` : "Paste the secret access key"}
              />
            </div>
          </Field>
          {form.provider === "s3" && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 md:col-span-2">
              <div>
                <Label htmlFor={`${id}-path`}>Path-style addressing</Label>
                <p className="text-xs text-muted-foreground">MinIO and most self-hosted stores need this on.</p>
              </div>
              <Switch id={`${id}-path`} checked={form.forcePathStyle} onCheckedChange={(v) => set({ forcePathStyle: v })} />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", showAdvanced && "rotate-180")} aria-hidden /> Folder inside the bucket
        </button>
        {showAdvanced && (
          <Field id={`${id}-prefix`} label="Folder (optional)" hint="Lets one bucket hold several installations, e.g. production and staging.">
            <Input
              id={`${id}-prefix`}
              value={form.prefix}
              onChange={(e) => set({ prefix: e.target.value })}
              placeholder="financeos/production"
              autoComplete="off"
              className="font-mono"
            />
          </Field>
        )}

        {result && <TestResult result={result} />}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">Saving runs the same test first; a bucket that fails it isn't saved.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={test} loading={testing} disabled={!ready || saving}>
              <FlaskConical aria-hidden /> Test connection
            </Button>
            <Button size="sm" onClick={save} loading={saving} disabled={!ready || testing}>
              <Save aria-hidden /> Save and use for new files
            </Button>
          </div>
        </div>
      </Section>

      {view.source === "admin" && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
            <RotateCcw aria-hidden /> Use the server's .env storage instead
          </Button>
        </div>
      )}

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop using this bucket?</AlertDialogTitle>
            <AlertDialogDescription>
              New files go to {view.env.label.toLowerCase()} ({view.env.location}) again.
              {adminFiles > 0 ? (
                <>
                  {" "}
                  <span className="font-medium text-foreground">
                    {adminFiles.toLocaleString()} file{adminFiles === 1 ? " is" : "s are"} stored only in this bucket and won't open
                  </span>{" "}
                  until these settings are saved again. The files themselves stay in the bucket.
                </>
              ) : (
                " No files are stored only in this bucket."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={reset}>
              Remove saved settings
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function ActiveStatus({ view }: { view: StorageConfigView }) {
  const source =
    view.source === "admin"
      ? `saved here${view.updatedBy ? ` by ${view.updatedBy}` : ""}${view.updatedAt ? ` ${timeAgo(view.updatedAt)}` : ""}`
      : "from the server's .env";
  return (
    <div className={cn("rounded-xl border p-4", view.problem ? "border-red-500/40 bg-red-500/5" : "border-border bg-card")}>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            view.active.backend === "local" ? "bg-muted text-muted-foreground" : "bg-sky-500/10 text-sky-600 dark:text-sky-400",
          )}
        >
          {view.active.backend === "local" ? <HardDrive className="size-4" aria-hidden /> : <CloudUpload className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">New uploads go to · {source}</p>
          <p className="font-semibold">{view.active.label}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{view.active.location}</p>
        </div>
      </div>
      {view.problem && (
        <p className="mt-3 flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> Uploads are failing: {view.problem}
        </p>
      )}
      {!view.problem && view.active.backend === "local" && (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> Files on this server's disk are lost if the server is replaced, and other servers can't
          see them. Set up a bucket below for anything beyond a single machine.
        </p>
      )}
    </div>
  );
}

function CopyStatus({ copy }: { copy: NonNullable<StorageConfigView["copy"]> }) {
  const running = copy.status === "queued" || copy.status === "running";
  const failed = copy.status === "failed" || copy.status === "dead";
  return (
    <p className={cn("flex items-start gap-2 text-xs", failed ? "text-red-700 dark:text-red-400" : "text-muted-foreground")}>
      {running ? (
        <Loader2 className="mt-px size-3.5 shrink-0 animate-spin" aria-hidden />
      ) : failed ? (
        <X className="mt-px size-3.5 shrink-0" aria-hidden />
      ) : (
        <Check className="mt-px size-3.5 shrink-0 text-emerald-600" aria-hidden />
      )}
      <span>
        {running ? "Copying" : failed ? "The last copy stopped" : "Last copy finished"} · {copy.copied.toLocaleString()} copied
        {copy.failed > 0 && `, ${copy.failed.toLocaleString()} couldn't be copied`} · {timeAgo(copy.updatedAt)}
        {copy.error && <span className="block">{copy.error}</span>}
      </span>
    </p>
  );
}

function ProviderCard({ selected, onSelect, title, detail }: { selected: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
        selected ? "border-foreground bg-accent ring-1 ring-foreground" : "border-border bg-card hover:bg-accent/50",
      )}
    >
      <span className="font-medium text-sm">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}

function Field({ id, label, hint, className, children }: { id: string; label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TestResult({ result }: { result: StorageTestResult }) {
  const names = { write: "Save a file", read: "Open it", delete: "Delete it" } as const;
  return (
    <div className={cn("rounded-xl border p-3 text-sm", result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5")}>
      <p className="font-medium">
        {result.ok ? "Works" : "Didn't work"} · <span className="font-normal text-muted-foreground tabular-nums">{(result.latencyMs / 1000).toFixed(1)}s</span>
      </p>
      <ul className="mt-1.5 space-y-1">
        {result.checks.map((check) => (
          <li key={check.name} className="flex items-start gap-2 text-xs">
            {check.ok ? (
              <Check className="mt-px size-3.5 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <X className="mt-px size-3.5 shrink-0 text-red-600" aria-hidden />
            )}
            <span>
              <span className="font-medium">{names[check.name]}</span> — {check.message}
            </span>
          </li>
        ))}
        {!result.checks.length && <li className="text-xs">{result.message}</li>}
      </ul>
    </div>
  );
}
