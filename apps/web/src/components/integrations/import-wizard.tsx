"use client";

import { COMMON_CURRENCIES } from "@financeos/core";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  CloudUpload,
  FileSpreadsheet,
  FileText,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type DragEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, StatusBadge } from "@/components/app/blocks";
import { TransactionDetailDrawer } from "@/components/transactions/transaction-detail";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { clientApi, errorMessage } from "@/lib/api/client";
import { fileUrl } from "@/lib/api/files";
import type { Account, Category, Project } from "@/lib/api/types";
import type {
  AmountSign,
  DateFormat,
  ImportBatch,
  ImportCommitResult,
  ImportCounts,
  ImportDetail,
  ImportMapping,
  ImportRow,
  ImportRowStatus,
  ImportRowsPage,
  ImportUpload,
} from "@/lib/api/types/integrations";
import { cn } from "@/lib/cn";
import { formatDay, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Pager } from "./detail-tabs";
import { ConfirmDialog } from "./shared";

const NONE = "__none__";
const ZERO: ImportCounts = { valid: 0, invalid: 0, duplicate: 0, imported: 0, skipped: 0 };

type MappedField = keyof ImportMapping;

const FIELDS: Array<{ key: MappedField; label: string; hint: string; required?: boolean }> = [
  { key: "date", label: "Date", hint: "Transaction or value date", required: true },
  { key: "description", label: "Description", hint: "Narration, particulars, details" },
  { key: "amount", label: "Amount", hint: "One signed column (use this or debit/credit)" },
  { key: "debit", label: "Money out (debit)", hint: "Withdrawal / Dr column" },
  { key: "credit", label: "Money in (credit)", hint: "Deposit / Cr column" },
  { key: "merchant", label: "Merchant / payee", hint: "To/From, beneficiary" },
  { key: "reference", label: "Reference", hint: "TrxID, cheque or reference number" },
  { key: "currency", label: "Currency", hint: "Only if rows differ in currency" },
  { key: "category", label: "Category", hint: "Matched to your categories by name" },
  { key: "type", label: "Type", hint: "Dr/Cr or income/expense marker" },
  { key: "balance", label: "Running balance", hint: "Kept for reference" },
];

const DATE_FORMATS: Array<{ value: DateFormat; label: string }> = [
  { value: "auto", label: "Detect (day first)" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY · 13/09/2026" },
  { value: "DD-MM-YYYY", label: "DD-MM-YYYY · 13-09-2026" },
  { value: "DD.MM.YYYY", label: "DD.MM.YYYY · 13.09.2026" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY · 09/13/2026" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD · 2026-09-13" },
];

const ROW_TABS: Array<{ value: ImportRowStatus; label: string }> = [
  { value: "valid", label: "Ready" },
  { value: "duplicate", label: "Duplicates" },
  { value: "invalid", label: "Invalid" },
  { value: "skipped", label: "Skipped" },
  { value: "imported", label: "Imported" },
];

type Step = "upload" | "map" | "preview" | "done";

function stepFor(batch: ImportBatch | null, backToMap: boolean): Step {
  if (!batch) return "upload";
  if (batch.status === "uploaded" || batch.status === "mapped") return "map";
  if (batch.status === "previewed" || batch.status === "failed") return backToMap ? "map" : "preview";
  return "done";
}

function Steps({ step }: { step: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: "upload", label: "Upload" },
    { key: "map", label: "Map columns" },
    { key: "preview", label: "Preview" },
    { key: "done", label: "Import" },
  ];
  const current = steps.findIndex((s) => s.key === step);
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {steps.map((s, index) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full text-[11px] font-medium tabular-nums",
              index < current
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : index === current
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {index < current ? <Check className="size-3" /> : index + 1}
          </span>
          <span className={cn(index === current ? "font-medium text-foreground" : "text-muted-foreground")}>{s.label}</span>
          {index < steps.length - 1 && <span className="mx-1 h-px w-4 bg-border" />}
        </li>
      ))}
    </ol>
  );
}

/**
 * Statement import: upload a CSV or .xlsx → map its columns → preview every
 * row (duplicates and errors flagged) → import. The URL follows the batch, so
 * an import can be resumed from /integrations/import/[id].
 */
export function ImportWizard({
  initial,
  accounts,
  categories,
  projects,
}: {
  initial: ImportDetail | null;
  accounts: Account[];
  categories: Category[];
  projects: Project[];
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<ImportDetail | null>(initial);
  const [detected, setDetected] = useState<ImportUpload["detected"] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [backToMap, setBackToMap] = useState(false);
  const [lastSummary, setLastSummary] = useState<ImportCommitResult["summary"]>(null);

  const batch = detail?.batch ?? null;
  const step = stepFor(batch, backToMap);

  const reload = useCallback(async () => {
    if (!batch) return;
    try {
      setDetail(await clientApi<ImportDetail>(`/imports/${batch.id}`));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [batch]);

  // A background import: poll until it finishes.
  useEffect(() => {
    if (batch?.status !== "importing") return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [batch?.status, reload]);

  const onUploaded = (upload: ImportUpload, source: File) => {
    setDetail({
      batch: upload.batch,
      suggestedMapping: upload.suggestedMapping,
      suggestedOptions: upload.suggestedOptions,
      sampleRows: upload.sampleRows,
      counts: { ...ZERO, valid: upload.batch.totalRows },
    });
    setDetected(upload.detected);
    setFile(source);
    setBackToMap(false);
    setLastSummary(null);
    window.history.replaceState(null, "", `/integrations/import/${upload.batch.id}`);
  };

  const startOver = () => {
    setDetail(null);
    setDetected(null);
    setFile(null);
    setBackToMap(false);
    setLastSummary(null);
    window.history.replaceState(null, "", "/integrations/import");
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Steps step={step} />
        {batch && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <FileSpreadsheet className="size-3.5 shrink-0" />
            {batch.fileId ? (
              <a
                href={fileUrl(batch.fileId, { download: true })}
                className="truncate underline-offset-4 hover:text-foreground hover:underline"
                title="Download the original file"
              >
                {batch.filename}
              </a>
            ) : (
              <span className="truncate">{batch.filename}</span>
            )}
            <span className="tabular-nums">· {batch.totalRows.toLocaleString()} rows</span>
          </span>
        )}
      </div>
      {step === "upload" && <UploadStep onUploaded={onUploaded} />}
      {step === "map" && detail && (
        <MapStep
          detail={detail}
          detected={detected}
          file={file}
          accounts={accounts}
          categories={categories}
          projects={projects}
          onUploaded={onUploaded}
          onPreviewed={(next) => {
            setDetail(next);
            setBackToMap(false);
          }}
          onCancelled={startOver}
        />
      )}
      {step === "preview" && detail && (
        <PreviewStep
          detail={detail}
          onBack={() => setBackToMap(true)}
          onCancelled={startOver}
          onCommitted={(result) => {
            setLastSummary(result.summary);
            setDetail((current) => (current ? { ...current, batch: result.batch } : current));
            void reload();
            router.refresh();
          }}
        />
      )}
      {step === "done" && detail && <DoneStep detail={detail} summary={lastSummary} onReload={reload} onStartOver={startOver} />}
    </div>
  );
}

// ------------------------------------------------------------------ upload

async function uploadFile(file: File, sheet?: string): Promise<ImportUpload> {
  const form = new FormData();
  form.append("file", file);
  if (sheet) form.append("sheet", sheet);
  return clientApi<ImportUpload>("/imports", { method: "POST", body: form });
}

function UploadStep({ onUploaded }: { onUploaded: (upload: ImportUpload, file: File) => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdf, setPdf] = useState(false);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPdf(false);
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      setPdf(true);
      return;
    }
    setUploading(true);
    try {
      onUploaded(await uploadFile(file), file);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <label
        htmlFor={inputId}
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDragging(false);
          void handle(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-accent/30",
        )}
      >
        {uploading ? <Loader2 className="size-8 animate-spin text-muted-foreground" /> : <CloudUpload className="size-8 text-muted-foreground" />}
        <span className="text-sm font-medium">{uploading ? "Reading the file…" : "Drop a statement here, or choose a file"}</span>
        <span className="max-w-md text-xs text-muted-foreground">
          CSV or Excel (.xlsx) exports from your bank, card or bKash, up to 12 MB and 20,000 rows. Columns are detected for you and nothing is saved until you
          confirm the preview.
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf"
          className="sr-only"
          disabled={uploading}
          onChange={(e: ChangeEvent<HTMLInputElement>) => void handle(e.target.files?.[0])}
        />
      </label>
      {pdf && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm">
          <FileText className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">PDF statements are read by AI capture</p>
            <p className="text-xs text-muted-foreground">
              AI capture extracts the transactions from a PDF and asks you to confirm them. For a fast bulk import here, download the CSV or Excel version of
              the statement instead.
            </p>
          </div>
          <Button size="sm" render={<Link href="/capture?mode=screenshot" />}>
            <Sparkles className="size-3.5" /> Open AI capture
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- map

function MapStep({
  detail,
  detected,
  file,
  accounts,
  categories,
  projects,
  onUploaded,
  onPreviewed,
  onCancelled,
}: {
  detail: ImportDetail;
  detected: ImportUpload["detected"] | null;
  file: File | null;
  accounts: Account[];
  categories: Category[];
  projects: Project[];
  onUploaded: (upload: ImportUpload, file: File) => void;
  onPreviewed: (detail: ImportDetail) => void;
  onCancelled: () => void;
}) {
  const { isBusiness, workspace } = useApp();
  const id = useId();
  const { batch } = detail;
  const hasSavedMapping = Object.keys(batch.mapping ?? {}).length > 0;
  const [accountId, setAccountId] = useState(batch.accountId ?? (accounts.length === 1 ? (accounts[0]?.id ?? "") : ""));
  const [mapping, setMapping] = useState<ImportMapping>(hasSavedMapping ? batch.mapping : detail.suggestedMapping);
  const [dateFormat, setDateFormat] = useState<DateFormat>(batch.options.dateFormat ?? detail.suggestedOptions.dateFormat);
  const [amountSign, setAmountSign] = useState<AmountSign>(batch.options.amountSign ?? detail.suggestedOptions.amountSign);
  const [currency, setCurrency] = useState(batch.options.defaultCurrency ?? NONE);
  const [categoryId, setCategoryId] = useState(batch.options.defaultCategoryId ?? NONE);
  const [projectId, setProjectId] = useState(batch.options.defaultProjectId ?? NONE);
  const [skipRows, setSkipRows] = useState(String(batch.options.skipRows ?? 0));
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const account = accounts.find((a) => a.id === accountId);
  const headers = batch.headers;
  const sample = detail.sampleRows;
  const fieldFor = (header: string) => FIELDS.find((f) => mapping[f.key] === header);
  const example = (header: string | undefined) => (header ? sample.map((row) => row.raw[header]).find((value) => value?.trim()) : undefined);
  const hasAmount = Boolean(mapping.amount || mapping.debit || mapping.credit);

  const setField = (key: MappedField, value: string) => setMapping((current) => ({ ...current, [key]: value === NONE ? undefined : value }));

  const switchSheet = async (sheet: string) => {
    if (!file || sheet === batch.options.sheet) return;
    setSwitching(true);
    try {
      const upload = await uploadFile(file, sheet);
      await clientApi(`/imports/${batch.id}`, { method: "DELETE" }).catch(() => undefined);
      onUploaded(upload, file);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSwitching(false);
    }
  };

  const preview = async () => {
    setError(null);
    if (!accountId) return setError("Choose the account this statement belongs to");
    if (!mapping.date) return setError("Map the date column");
    if (!hasAmount) return setError("Map an amount column, or the debit and credit columns");
    setSaving(true);
    try {
      await clientApi(`/imports/${batch.id}/mapping`, {
        method: "PUT",
        body: {
          accountId,
          mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
          options: {
            dateFormat,
            amountSign,
            defaultCurrency: currency === NONE ? undefined : currency,
            defaultCategoryId: categoryId === NONE ? null : categoryId,
            defaultProjectId: projectId === NONE ? null : projectId,
            skipRows: Math.max(0, Math.min(50, Number(skipRows) || 0)),
          },
        },
      });
      onPreviewed(await clientApi<ImportDetail>(`/imports/${batch.id}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    try {
      await clientApi(`/imports/${batch.id}`, { method: "DELETE" });
      toast.success("Import cancelled");
      onCancelled();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-4">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Which account is this?</h2>
            {detected && (
              <span className="text-[11px] text-muted-foreground">
                Header found on row {detected.headerRow}
                {detected.delimiter ? ` · "${detected.delimiter === "\t" ? "tab" : detected.delimiter}" separated` : ""}
              </span>
            )}
          </div>
          <Select value={accountId || NONE} onValueChange={(v) => typeof v === "string" && setAccountId(v === NONE ? "" : v)}>
            <SelectTrigger aria-label="Account">
              <SelectValue>{account ? `${account.name} · ${account.currency}` : "Choose an account"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!accounts.length && (
            <p className="text-xs text-muted-foreground">
              Add the account first on the{" "}
              <Link href="/accounts" className="underline underline-offset-4">
                Accounts
              </Link>{" "}
              page.
            </p>
          )}
          {detected?.sameFileAs && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              This exact file was uploaded before. Rows already imported will be recognised and skipped.
            </p>
          )}
          {detected && detected.sheets.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-sheet`}>Sheet</Label>
              <Select
                value={batch.options.sheet ?? detected.sheet ?? ""}
                onValueChange={(v) => typeof v === "string" && void switchSheet(v)}
                disabled={!file || switching}
              >
                <SelectTrigger id={`${id}-sheet`}>
                  <SelectValue>{batch.options.sheet ?? detected.sheet}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {detected.sheets.map((sheet) => (
                    <SelectItem key={sheet} value={sheet}>
                      {sheet}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div>
            <h2 className="text-sm font-semibold">Match the columns</h2>
            <p className="text-xs text-muted-foreground">We guessed from the headers. Use one Amount column, or separate money-out and money-in columns.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => {
              const value = mapping[field.key];
              const sampleValue = example(value);
              return (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`${id}-${field.key}`}>
                    {field.label}
                    {field.required && <span className="text-muted-foreground"> *</span>}
                  </Label>
                  <Select value={value ?? NONE} onValueChange={(v) => typeof v === "string" && setField(field.key, v)}>
                    <SelectTrigger id={`${id}-${field.key}`} size="sm">
                      <SelectValue>{value ?? "Not in this file"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not in this file</SelectItem>
                      {headers.map((header) => (
                        <SelectItem key={header} value={header}>
                          {header}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="truncate text-[11px] text-muted-foreground">{sampleValue ? `e.g. ${sampleValue}` : field.hint}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Options</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-date`}>Date format</Label>
              <Select value={dateFormat} onValueChange={(v) => typeof v === "string" && setDateFormat(v as DateFormat)}>
                <SelectTrigger id={`${id}-date`} size="sm">
                  <SelectValue>{DATE_FORMATS.find((f) => f.value === dateFormat)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DATE_FORMATS.map((format) => (
                    <SelectItem key={format.value} value={format.value}>
                      {format.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mapping.amount && !mapping.debit && !mapping.credit && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-sign`}>Negative amounts are</Label>
                <Select value={amountSign} onValueChange={(v) => typeof v === "string" && setAmountSign(v as AmountSign)}>
                  <SelectTrigger id={`${id}-sign`} size="sm">
                    <SelectValue>{amountSign === "negative_is_expense" ? "Money out (usual)" : "Money in (card statements)"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="negative_is_expense">Money out (usual)</SelectItem>
                    <SelectItem value="positive_is_expense">Money in (card statements)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor={`${id}-currency`}>Currency</Label>
              <Select value={currency} onValueChange={(v) => typeof v === "string" && setCurrency(v)}>
                <SelectTrigger id={`${id}-currency`} size="sm">
                  <SelectValue>{currency === NONE ? `Account currency${account ? ` (${account.currency})` : ""}` : currency}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Account currency{account ? ` (${account.currency})` : ""}</SelectItem>
                  {[...new Set([workspace.baseCurrency, ...COMMON_CURRENCIES])].map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-category`}>Fallback category</Label>
              <Select value={categoryId} onValueChange={(v) => typeof v === "string" && setCategoryId(v)}>
                <SelectTrigger id={`${id}-category`} size="sm">
                  <SelectValue>{categoryId === NONE ? "Leave uncategorised" : (categories.find((c) => c.id === categoryId)?.name ?? "Category")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Leave uncategorised</SelectItem>
                  {categories
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className={cn(c.parentId && "ps-3")}>{c.name}</span>
                        <span className="text-[11px] text-muted-foreground"> · {c.kind}</span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {isBusiness && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-project`}>Project</Label>
                <Select value={projectId} onValueChange={(v) => typeof v === "string" && setProjectId(v)}>
                  <SelectTrigger id={`${id}-project`} size="sm">
                    <SelectValue>{projectId === NONE ? "No project" : (projects.find((p) => p.id === projectId)?.name ?? "Project")}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor={`${id}-skip`}>Skip first rows</Label>
              <Input id={`${id}-skip`} size="sm" inputMode="numeric" value={skipRows} onChange={(e) => setSkipRows(e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Your rules still run when you import and win over the fallback category.</p>
        </section>

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
            <Trash2 className="size-3.5" /> Cancel import
          </Button>
          <Button size="sm" loading={saving} onClick={() => void preview()}>
            Preview {batch.totalRows.toLocaleString()} rows <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>

      <section className="min-w-0 space-y-2 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">First rows of the file</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr className="[&>th]:px-2.5 [&>th]:py-2 [&>th]:text-left [&>th]:align-bottom [&>th]:font-medium">
                <th className="w-10">Row</th>
                {headers.map((header) => {
                  const field = fieldFor(header);
                  return (
                    <th key={header} className="min-w-24 whitespace-nowrap">
                      {field && <span className="mb-1 block w-fit rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{field.label}</span>}
                      {header}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sample.slice(0, 12).map((row) => (
                <tr key={row.rowNumber} className="[&>td]:px-2.5 [&>td]:py-1.5">
                  <td className="tabular-nums text-muted-foreground">{row.rowNumber}</td>
                  {headers.map((header) => (
                    <td key={header} className={cn("max-w-48 truncate whitespace-nowrap", fieldFor(header) ? "text-foreground" : "text-muted-foreground")}>
                      {row.raw[header]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this import?"
        description="Nothing from it has been saved to your books. The uploaded file stays in your files."
        confirmLabel="Cancel import"
        onConfirm={() => void cancel()}
      />
    </div>
  );
}

// ----------------------------------------------------------------- preview

function RowsTable({
  rows,
  status,
  included,
  onToggle,
  onOpenTransaction,
}: {
  rows: ImportRow[];
  status: ImportRowStatus;
  included: Set<string>;
  onToggle: (id: string) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const { money } = useApp();
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            {status === "duplicate" && <th className="w-10">Import</th>}
            <th className="w-12">Row</th>
            <th className="hidden w-28 sm:table-cell">Date</th>
            <th>Description</th>
            <th className="w-32 text-right!">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const n = row.normalized;
            const label = n?.merchant ?? n?.description ?? Object.values(row.raw).filter(Boolean).slice(0, 3).join(" · ");
            const linked = row.transactionId ?? row.duplicateOfId;
            return (
              <tr key={row.id} className="align-top [&>td]:px-3 [&>td]:py-2">
                {status === "duplicate" && (
                  <td>
                    <Checkbox checked={included.has(row.id)} onCheckedChange={() => onToggle(row.id)} aria-label={`Import row ${row.rowNumber} anyway`} />
                  </td>
                )}
                <td className="text-xs tabular-nums text-muted-foreground">{row.rowNumber}</td>
                <td className="hidden text-xs tabular-nums text-muted-foreground sm:table-cell">{n?.date ? formatDay(n.date) : "—"}</td>
                <td className="max-w-0">
                  <p className="text-xs tabular-nums text-muted-foreground sm:hidden">{n?.date ? formatDay(n.date) : ""}</p>
                  <p className="truncate font-medium">{label || "—"}</p>
                  {n?.merchant && n.description && <p className="truncate text-xs text-muted-foreground">{n.description}</p>}
                  {(row.error || n?.categoryHint || n?.reference) && (
                    <p className={cn("text-xs break-words", row.status === "invalid" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                      {row.error ??
                        [n?.reference && `Ref ${n.reference}`, n?.categoryHint && `Category “${n.categoryHint}”${n.categoryId ? "" : " (no match)"}`]
                          .filter(Boolean)
                          .join(" · ")}
                    </p>
                  )}
                  {linked && (
                    <button
                      type="button"
                      onClick={() => onOpenTransaction(linked)}
                      className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {row.transactionId ? "Open the transaction" : "Open the matching transaction"}
                    </button>
                  )}
                </td>
                <td className="text-right">
                  {n ? (
                    <span className={cn("font-medium tabular-nums", n.direction === "in" && "text-money-in")}>
                      {money(n.signedAmount, n.currency, { signed: n.direction === "in" })}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PreviewStep({
  detail,
  onBack,
  onCancelled,
  onCommitted,
}: {
  detail: ImportDetail;
  onBack: () => void;
  onCancelled: () => void;
  onCommitted: (result: ImportCommitResult) => void;
}) {
  const { locale } = useApp();
  const { batch, counts } = detail;
  const [tab, setTab] = useState<ImportRowStatus>(counts.valid ? "valid" : counts.duplicate ? "duplicate" : "invalid");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ImportRowsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [openTransaction, setOpenTransaction] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    clientApi<ImportRowsPage>(`/imports/${batch.id}/rows`, { query: { status: tab, page, pageSize: 50 } })
      .then((data) => !cancelled && setRows(data))
      .catch((error) => !cancelled && toast.error(errorMessage(error)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [batch.id, tab, page]);

  const toggle = (id: string) =>
    setIncluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const total = counts.valid + included.size;

  const commit = async () => {
    setCommitting(true);
    try {
      const result = await clientApi<ImportCommitResult>(`/imports/${batch.id}/commit`, { method: "POST", body: { includeDuplicates: [...included] } });
      if (result.queued) toast.info("Importing in the background", { description: "You can leave this page; the import continues." });
      else toast.success(`${result.summary?.imported ?? 0} transactions imported`);
      onCommitted(result);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCommitting(false);
    }
  };

  const cancel = async () => {
    try {
      await clientApi(`/imports/${batch.id}`, { method: "DELETE" });
      toast.success("Import cancelled");
      onCancelled();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const tabs = ROW_TABS.filter((t) => t.value !== "imported" || counts.imported > 0);

  return (
    <div className="space-y-4">
      {batch.status === "failed" && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {batch.error ?? "The last attempt imported nothing."} Check the Invalid tab, fix the mapping or the account, and try again.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <p className="text-sm">
          <span className="font-semibold tabular-nums">{counts.valid.toLocaleString(locale)}</span> ready to import into{" "}
          <span className="font-medium">{batch.accountName ?? "the account"}</span>
          {counts.duplicate > 0 && (
            <>
              {" "}
              · <span className="tabular-nums">{counts.duplicate.toLocaleString(locale)}</span> look like transactions you already have
            </>
          )}
          {counts.invalid > 0 && (
            <>
              {" "}
              · <span className="tabular-nums text-red-600 dark:text-red-400">{counts.invalid.toLocaleString(locale)}</span> cannot be read
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground">Rules run as they import. Everything posts to the ledger unless a rule asks for review.</p>
      </div>

      <div role="tablist" aria-label="Rows" className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 p-1">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => {
              setTab(t.value);
              setPage(1);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              tab === t.value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            <span className="tabular-nums text-muted-foreground">{counts[t.value].toLocaleString(locale)}</span>
          </button>
        ))}
      </div>

      {tab === "duplicate" && counts.duplicate > 0 && (
        <p className="text-xs text-muted-foreground">
          Rows already imported from this file, or matching a transaction you entered another way, are left out. Tick a row to import it anyway (a row imported
          before is still never imported twice).
        </p>
      )}

      {loading && !rows ? (
        <div className="space-y-2">
          {["a", "b", "c", "d", "e"].map((key) => (
            <Skeleton key={key} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : rows && rows.items.length === 0 ? (
        <EmptyNote>{tab === "valid" ? "No rows are ready. Check the other tabs or the mapping." : "No rows here."}</EmptyNote>
      ) : rows ? (
        <div className={cn("space-y-3 transition-opacity", loading && "opacity-70")}>
          <RowsTable rows={rows.items} status={tab} included={included} onToggle={toggle} onOpenTransaction={setOpenTransaction} />
          <Pager page={rows.page} pageSize={rows.pageSize} total={rows.total} onPage={setPage} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onBack}>
            <ArrowLeft className="size-3.5" /> Back to mapping
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
            <Trash2 className="size-3.5" /> Cancel
          </Button>
        </div>
        <Button size="sm" loading={committing} disabled={total === 0} onClick={() => void commit()}>
          <Upload className="size-3.5" /> Import {total.toLocaleString(locale)} transactions
        </Button>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this import?"
        description="Nothing from it has been saved to your books yet."
        confirmLabel="Cancel import"
        onConfirm={() => void cancel()}
      />
      <TransactionDetailDrawer id={openTransaction} onClose={() => setOpenTransaction(null)} />
    </div>
  );
}

// -------------------------------------------------------------------- done

function DoneStep({
  detail,
  summary,
  onReload,
  onStartOver,
}: {
  detail: ImportDetail;
  summary: ImportCommitResult["summary"];
  onReload: () => Promise<void>;
  onStartOver: () => void;
}) {
  const { locale } = useApp();
  const router = useRouter();
  const { batch, counts } = detail;
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [rows, setRows] = useState<ImportRowsPage | null>(null);
  const [page, setPage] = useState(1);
  const [openTransaction, setOpenTransaction] = useState<string | null>(null);

  useEffect(() => {
    if (batch.status !== "completed" || counts.imported === 0) return;
    clientApi<ImportRowsPage>(`/imports/${batch.id}/rows`, { query: { status: "imported", page, pageSize: 25 } })
      .then(setRows)
      .catch(() => setRows(null));
  }, [batch.id, batch.status, counts.imported, page]);

  const revert = async () => {
    setReverting(true);
    try {
      const result = await clientApi<{ voided: number }>(`/imports/${batch.id}`, { method: "DELETE", query: { revert: true } });
      toast.success(`Import reverted: ${result.voided} transactions voided`);
      setConfirmRevert(false);
      await onReload();
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setReverting(false);
    }
  };

  if (batch.status === "importing") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium">Importing {batch.validRows.toLocaleString(locale)} rows…</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Large files import in the background. This page updates by itself, and you can leave it: the import keeps going.
        </p>
      </div>
    );
  }

  const cancelled = batch.status === "cancelled";
  const stats = [
    { label: "Imported", value: summary?.imported ?? counts.imported, tone: "good" as const },
    { label: "Saved as drafts", value: summary?.drafts ?? null },
    { label: "Already in your books", value: summary?.duplicates ?? counts.duplicate },
    { label: "Skipped", value: summary?.skipped ?? counts.skipped },
    { label: "Could not import", value: summary?.failed ?? counts.invalid, tone: "danger" as const },
  ].filter((stat) => stat.value !== null);

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-4",
          cancelled ? "border-border bg-muted/40" : "border-emerald-500/30 bg-emerald-500/5",
        )}
      >
        <div className="flex items-start gap-3">
          {cancelled ? <Undo2 className="mt-0.5 size-5 text-muted-foreground" /> : <Check className="mt-0.5 size-5 text-emerald-600 dark:text-emerald-400" />}
          <div>
            <p className="font-medium">
              {cancelled ? (batch.error?.startsWith("Reverted") ? "This import was reverted" : "This import was cancelled") : "Import complete"}
            </p>
            <p className="text-xs text-muted-foreground">
              {cancelled
                ? (batch.error ?? "Nothing from it is in your books.")
                : `${batch.filename} → ${batch.accountName ?? "account"}${batch.completedAt ? ` · ${timeAgo(batch.completedAt)}` : ""}`}
            </p>
          </div>
        </div>
        <StatusBadge status={batch.status === "completed" ? "succeeded" : "cancelled"} label={batch.status} />
      </div>

      {!cancelled && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-lg border border-border px-3 py-2">
              <div
                className={cn(
                  "text-lg font-semibold tabular-nums",
                  stat.tone === "good" && (stat.value ?? 0) > 0 && "text-emerald-600 dark:text-emerald-400",
                  stat.tone === "danger" && (stat.value ?? 0) > 0 && "text-red-600 dark:text-red-400",
                )}
              >
                {(stat.value ?? 0).toLocaleString(locale)}
              </div>
              <div className="text-[11px] text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {rows && rows.items.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Imported rows</h2>
          <RowsTable rows={rows.items} status="imported" included={new Set()} onToggle={() => undefined} onOpenTransaction={setOpenTransaction} />
          <Pager page={rows.page} pageSize={rows.pageSize} total={rows.total} onPage={setPage} />
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {batch.accountId && !cancelled && (
            <Button size="sm" variant="outline" render={<Link href={`/accounts/${batch.accountId}`} />}>
              Open {batch.accountName ?? "the account"}
            </Button>
          )}
          {batch.status === "completed" && counts.imported > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRevert(true)}>
              <RotateCcw className="size-3.5" /> Revert import
            </Button>
          )}
        </div>
        <Button size="sm" onClick={onStartOver}>
          <Upload className="size-3.5" /> Import another file
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        title="Revert this import?"
        description={`The ${counts.imported.toLocaleString(locale)} transactions it created are voided and the balances go back. They stay in the audit log, and importing the same rows again will show them as already imported.`}
        confirmLabel="Revert import"
        busy={reverting}
        onConfirm={() => void revert()}
      />
      <TransactionDetailDrawer id={openTransaction} onClose={() => setOpenTransaction(null)} />
    </div>
  );
}

/** The latest imports, to resume or review. */
export function RecentImports({ batches }: { batches: ImportBatch[] }) {
  const { locale } = useApp();
  if (!batches.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium text-muted-foreground">Recent imports</h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>File</th>
              <th className="hidden md:table-cell">Account</th>
              <th>Status</th>
              <th className="text-right!">Rows</th>
              <th className="hidden text-right! sm:table-cell">Imported</th>
              <th className="hidden md:table-cell">Uploaded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {batches.map((batch) => (
              <tr key={batch.id} className="transition-colors hover:bg-accent/40 [&>td]:px-3 [&>td]:py-2">
                <td className="max-w-0">
                  <Link href={`/integrations/import/${batch.id}`} className="flex min-w-0 items-center gap-1.5 font-medium hover:underline">
                    <FileSpreadsheet className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{batch.filename}</span>
                  </Link>
                </td>
                <td className="hidden max-w-40 truncate text-xs text-muted-foreground md:table-cell">{batch.accountName ?? "—"}</td>
                <td>
                  <StatusBadge
                    status={
                      batch.status === "completed"
                        ? "succeeded"
                        : batch.status === "importing"
                          ? "running"
                          : batch.status === "cancelled"
                            ? "cancelled"
                            : batch.status === "failed"
                              ? "failed"
                              : "draft"
                    }
                    label={
                      batch.status === "uploaded" || batch.status === "mapped"
                        ? "Needs mapping"
                        : batch.status === "previewed"
                          ? "Ready to import"
                          : batch.status
                    }
                  />
                </td>
                <td className="text-right text-xs tabular-nums">{batch.totalRows.toLocaleString(locale)}</td>
                <td className="hidden text-right text-xs tabular-nums sm:table-cell">{batch.importedRows.toLocaleString(locale)}</td>
                <td className="hidden text-xs text-muted-foreground md:table-cell">{timeAgo(batch.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
