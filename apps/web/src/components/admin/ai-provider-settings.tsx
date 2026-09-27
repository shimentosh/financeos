"use client";

import type {
  AiConfigInput,
  AiConfigTestResult,
  AiConfigView,
  AiModelConfigInput,
  AiModelConfigView,
  AiProviderId,
  AiProviderPreset,
  AiStructuredMode,
} from "@expensewise/core";
import { Check, ChevronDown, CircleAlert, ExternalLink, Eye, FlaskConical, HardDrive, KeyRound, RotateCcw, Save, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
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
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

type Tri = "auto" | "yes" | "no";
type Form = {
  provider: AiProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  vision: Tri;
  tools: Tri;
  structured: AiStructuredMode | "auto";
  priceInput: string;
  priceOutput: string;
  priceCache: string;
};

const TRI = [
  { value: "auto", label: "Automatic" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
const STRUCTURED = [
  { value: "auto", label: "Provider default" },
  { value: "json_schema", label: "JSON schema (strict)" },
  { value: "json_object", label: "JSON mode" },
  { value: "prompt", label: "Instructions only" },
];

const tri = (value: boolean | null | undefined): Tri => (value === true ? "yes" : value === false ? "no" : "auto");
const fromTri = (value: Tri) => (value === "auto" ? null : value === "yes");

function formFor(view: AiModelConfigView | null, presets: AiProviderPreset[], fallback: AiProviderId): Form {
  const preset = presets.find((p) => p.id === (view?.provider ?? fallback));
  return {
    provider: view?.provider ?? fallback,
    model: view?.model ?? preset?.defaultModel ?? "",
    // Only a changed endpoint is kept in the form; the preset's default is implied.
    baseUrl: view?.baseUrl && view.baseUrl !== preset?.baseUrl ? view.baseUrl : "",
    apiKey: "",
    clearKey: false,
    vision: tri(view?.overrides.vision),
    tools: tri(view?.overrides.tools),
    structured: view?.overrides.structured ?? "auto",
    priceInput: view?.overrides.prices ? String(view.prices.input) : "",
    priceOutput: view?.overrides.prices ? String(view.prices.output) : "",
    priceCache: view?.overrides.prices ? String(view.prices.cacheRead) : "",
  };
}

function toInput(form: Form): AiModelConfigInput {
  const prices =
    form.priceInput.trim() && form.priceOutput.trim()
      ? { input: Number(form.priceInput), output: Number(form.priceOutput), cacheRead: form.priceCache.trim() ? Number(form.priceCache) : null }
      : null;
  return {
    provider: form.provider,
    model: form.model.trim(),
    baseUrl: form.baseUrl.trim() || null,
    ...(form.clearKey ? { apiKey: null } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    vision: fromTri(form.vision),
    tools: fromTri(form.tools),
    structured: form.structured === "auto" ? null : form.structured,
    prices,
  };
}

/**
 * Admin → AI: pick the provider for the whole installation (DeepSeek, OpenAI,
 * Gemini, Claude, a local model…), paste its key, test it, save. A second
 * model can read screenshots when the main one cannot.
 */
export function AiProviderSettings({ view }: { view: AiConfigView }) {
  const router = useRouter();
  const presets = view.presets;
  const [primary, setPrimary] = useState<Form>(() => formFor(view.primary, presets, "deepseek"));
  const [useVision, setUseVision] = useState(Boolean(view.vision));
  const [vision, setVision] = useState<Form>(() => formFor(view.vision, presets, "gemini"));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"primary" | "vision" | null>(null);
  const [results, setResults] = useState<Partial<Record<"primary" | "vision", AiConfigTestResult>>>({});
  const [resetOpen, setResetOpen] = useState(false);

  const draft = (): AiConfigInput => ({ primary: toInput(primary), vision: useVision ? toInput(vision) : null });
  const primaryPreset = presets.find((p) => p.id === primary.provider);
  const primaryReadsImages = useMemo(() => {
    if (primary.vision !== "auto") return primary.vision === "yes";
    const known = primaryPreset?.models.find((m) => m.id === primary.model);
    if (known) return known.vision;
    return primary.provider === view.primary?.provider && primary.model === view.primary.model
      ? view.primary.capabilities.vision
      : primary.provider === "anthropic";
  }, [primary, primaryPreset, view.primary]);

  const save = async () => {
    setSaving(true);
    try {
      await clientApi<AiConfigView>("/admin/ai-config", { method: "PUT", body: draft() });
      toast.success("AI settings saved; every workspace uses them now");
      setPrimary((f) => ({ ...f, apiKey: "", clearKey: false }));
      setVision((f) => ({ ...f, apiKey: "", clearKey: false }));
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const test = async (target: "primary" | "vision") => {
    setTesting(target);
    try {
      const result = await clientApi<AiConfigTestResult>("/admin/ai-config/test", { method: "POST", body: { target, draft: draft() } });
      setResults((r) => ({ ...r, [target]: result }));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(null);
    }
  };

  const reset = async () => {
    try {
      await clientApi("/admin/ai-config", { method: "DELETE" });
      toast.success("Back to the server's .env settings");
      setResetOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <ActiveStatus view={view} />

      <Section title="Main model" hint="Categorising, text and voice notes, report summaries and the Copilot. Screenshots too, if it can read images.">
        <ModelForm form={primary} onChange={setPrimary} presets={presets} saved={view.primary} result={results.primary} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => test("primary")}
            loading={testing === "primary"}
            disabled={testing !== null || !primary.model.trim()}
          >
            <FlaskConical aria-hidden /> Test connection
          </Button>
          <span className="text-xs text-muted-foreground">Makes a few small real calls (a few hundred tokens).</span>
        </div>
      </Section>

      <Section
        title="Image model"
        hint="Reads screenshots, receipts and PDFs when the main model cannot — DeepSeek, for one, is text-only."
        actions={
          <div className="flex items-center gap-2">
            <Label htmlFor="use-vision" className="text-xs text-muted-foreground">
              Use a separate model
            </Label>
            <Switch id="use-vision" checked={useVision} onCheckedChange={setUseVision} />
          </div>
        }
      >
        {useVision ? (
          <>
            <ModelForm form={vision} onChange={setVision} presets={presets} saved={view.vision} result={results.vision} onlyVision />
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => test("vision")}
                loading={testing === "vision"}
                disabled={testing !== null || !vision.model.trim()}
              >
                <FlaskConical aria-hidden /> Test image model
              </Button>
            </div>
          </>
        ) : (
          <p className={cn("flex items-start gap-2 text-sm", primaryReadsImages ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400")}>
            {primaryReadsImages ? (
              <>
                <Eye className="mt-0.5 size-4 shrink-0" aria-hidden /> The main model reads screenshots itself.
              </>
            ) : (
              <>
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> The main model can't read images, so screenshots and receipts will need entering
                by hand. Turn this on and add Gemini Flash, GPT or Claude for images.
              </>
            )}
          </p>
        )}
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {view.source === "admin" && (
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
            <RotateCcw aria-hidden /> Use the server's .env instead
          </Button>
        )}
        <Button onClick={save} loading={saving} disabled={!primary.model.trim()}>
          <Save aria-hidden /> Save AI settings
        </Button>
      </div>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Go back to the server's settings?</AlertDialogTitle>
            <AlertDialogDescription>
              The provider, model and keys saved here are removed. AI then uses what the server's .env names (AI_PROVIDER, AI_MODEL and the provider's key), or
              turns off if it names nothing.
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

function ActiveStatus({ view }: { view: AiConfigView }) {
  const primary = view.primary;
  const source =
    view.source === "admin"
      ? `saved here${view.updatedBy ? ` by ${view.updatedBy}` : ""}${view.updatedAt ? ` ${timeAgo(view.updatedAt)}` : ""}`
      : "from the server's .env";
  return (
    <div className={cn("rounded-xl border p-4", primary ? "border-border bg-card" : "border-amber-500/40 bg-amber-500/5")}>
      {primary ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Active now · {source}</p>
            <p className="font-semibold">
              {primary.providerName} · <span className="font-mono text-sm">{primary.model}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Capability ok label="Text & JSON" />
            <Capability ok={primary.capabilities.tools} label="Copilot tools" />
            <Capability
              ok={primary.capabilities.vision || Boolean(view.vision?.capabilities.vision)}
              label={primary.capabilities.vision ? "Screenshots" : view.vision ? `Screenshots via ${view.vision.providerName}` : "Screenshots"}
            />
          </div>
          <p className="ms-auto text-xs text-muted-foreground tabular-nums">
            ${primary.prices.input} / ${primary.prices.output} per 1M tokens
            {primary.prices.source === "unknown" && " (price unknown: counted high so budgets hold)"}
            {primary.prices.source === "free" && " (local, free)"}
          </p>
        </div>
      ) : (
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            <span className="font-medium">AI is off.</span> {view.unavailableReason} Choose a provider below — the app keeps working without one, using the
            built-in parser, rules and merchant memory.
          </span>
        </p>
      )}
    </div>
  );
}

function Capability({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
        ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground line-through decoration-muted-foreground/50",
      )}
    >
      {ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
      {label}
    </span>
  );
}

function ModelForm({
  form,
  onChange,
  presets,
  saved,
  result,
  onlyVision = false,
}: {
  form: Form;
  onChange: (update: (form: Form) => Form) => void;
  presets: AiProviderPreset[];
  saved: AiModelConfigView | null;
  result?: AiConfigTestResult;
  onlyVision?: boolean;
}) {
  const id = useId();
  const [advanced, setAdvanced] = useState(form.vision !== "auto" || form.tools !== "auto" || form.structured !== "auto" || Boolean(form.priceInput));
  const preset = presets.find((p) => p.id === form.provider) as AiProviderPreset;
  const set = (patch: Partial<Form>) => onChange((f) => ({ ...f, ...patch }));
  const choices = onlyVision ? presets.filter((p) => p.local || p.models.length === 0 || p.models.some((m) => m.vision)) : presets;
  const savedKey = saved?.provider === form.provider ? saved.apiKey : null;
  const needsEndpoint = form.provider === "custom" || preset.local;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {choices.map((p) => {
          const selected = p.id === form.provider;
          const readsImages = p.models.some((m) => m.vision) || p.id === "anthropic";
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected}
              onClick={() => set({ provider: p.id, model: p.defaultModel, baseUrl: "", apiKey: "", clearKey: false })}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                selected ? "border-foreground bg-accent ring-1 ring-foreground" : "border-border bg-card hover:bg-accent/50",
              )}
            >
              <span className="truncate font-medium text-sm">{p.name}</span>
              <span className="flex flex-wrap gap-1">
                {p.local && (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    <HardDrive className="size-2.5" aria-hidden /> Local
                  </span>
                )}
                {readsImages && (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    <Eye className="size-2.5" aria-hidden /> Images
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {preset.note && <p className="text-xs text-muted-foreground">{preset.note}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-model`}>Model</Label>
          <Input
            id={`${id}-model`}
            value={form.model}
            onChange={(e) => set({ model: e.target.value })}
            placeholder={preset.defaultModel || "model-id"}
            list={`${id}-models`}
          />
          <datalist id={`${id}-models`}>
            {preset.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          {preset.models.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {preset.models
                .filter((m) => !onlyVision || m.vision)
                .map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => set({ model: m.id })}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                      form.model === m.id ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m.label}
                  </button>
                ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${id}-key`}>API key {!preset.keyRequired && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
            {preset.keyUrl && (
              <a
                href={preset.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Get a key <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </div>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              className="[&_input]:ps-8"
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value, clearKey: false })}
              placeholder={
                savedKey?.set && !form.clearKey
                  ? `${savedKey.source === "env" ? `From ${preset.envKey ?? "the server"}` : "Saved"} ${savedKey.masked} — leave blank to keep`
                  : preset.keyRequired
                    ? `Paste your ${preset.name} key`
                    : "Not needed for most local servers"
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Stored encrypted and never shown again.
            {savedKey?.source === "admin" && !form.clearKey && (
              <>
                {" "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => set({ clearKey: true, apiKey: "" })}>
                  Remove the saved key
                </button>
                {preset.envKey ? ` (then ${preset.envKey} from the server is used)` : ""}.
              </>
            )}
            {form.clearKey && " The saved key will be removed when you save."}
          </p>
        </div>

        {(needsEndpoint || advanced) && preset.id !== "anthropic" && (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-url`}>Endpoint URL</Label>
            <Input
              id={`${id}-url`}
              value={form.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder={preset.baseUrl ?? "https://your-gateway.example.com/v1"}
              inputMode="url"
            />
            <p className="text-xs text-muted-foreground">
              The address before /chat/completions. {preset.baseUrl ? "Leave blank for the default." : "Required."}
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} aria-hidden /> Advanced: capabilities and prices
      </button>
      {advanced && (
        <div className="grid gap-3 rounded-xl border border-border bg-muted/30 p-3 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-vision`}>Can read images</Label>
            <OptionSelect id={`${id}-vision`} value={form.vision} onChange={(v) => set({ vision: v as Tri })} options={TRI} placeholder="Automatic" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-tools`}>Can use tools (Copilot)</Label>
            <OptionSelect id={`${id}-tools`} value={form.tools} onChange={(v) => set({ tools: v as Tri })} options={TRI} placeholder="Automatic" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-json`}>How to ask for JSON</Label>
            <OptionSelect
              id={`${id}-json`}
              value={form.structured}
              onChange={(v) => set({ structured: v as Form["structured"] })}
              options={STRUCTURED}
              placeholder="Provider default"
            />
          </div>
          <div className="space-y-1.5 md:col-span-3">
            <Label>Price, USD per million tokens</Label>
            <div className="grid grid-cols-3 gap-2">
              <Input
                inputMode="decimal"
                value={form.priceInput}
                onChange={(e) => set({ priceInput: e.target.value })}
                placeholder={`Input ${saved?.prices.input ?? ""}`}
              />
              <Input
                inputMode="decimal"
                value={form.priceOutput}
                onChange={(e) => set({ priceOutput: e.target.value })}
                placeholder={`Output ${saved?.prices.output ?? ""}`}
              />
              <Input
                inputMode="decimal"
                value={form.priceCache}
                onChange={(e) => set({ priceCache: e.target.value })}
                placeholder={`Cached ${saved?.prices.cacheRead ?? ""}`}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank to use the built-in list. Budgets use these numbers; an unknown model is counted at $10 / $50 so a budget is never overspent.
            </p>
          </div>
        </div>
      )}

      {result && (
        <div className={cn("rounded-xl border p-3 text-sm", result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5")}>
          <p className="font-medium">
            {result.ok ? "Works" : "Didn't work"} ·{" "}
            <span className="font-normal text-muted-foreground tabular-nums">{(result.latencyMs / 1000).toFixed(1)}s</span>
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
                  <span className="font-medium capitalize">
                    {check.name === "json" ? "Reading a note (JSON)" : check.name === "tools" ? "Tool call" : check.name}
                  </span>{" "}
                  — {check.message}
                </span>
              </li>
            ))}
            {!result.checks.length && <li className="text-xs">{result.message}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
