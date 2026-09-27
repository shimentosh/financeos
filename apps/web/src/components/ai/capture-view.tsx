"use client";

import { Camera, ChevronRight, ClipboardPaste, FileText, ImageUp, Mic, MicOff, Receipt, RotateCcw, Send, Sparkles, Type } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, Section } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { AiStatusView, CaptureListItem, CaptureView as CaptureViewData } from "@/lib/api/types/ai";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { AiAvailabilityNotice, CAPTURE_KIND, Callout, Segmented, StageBadge } from "./shared";

export type CaptureMode = "screenshot" | "receipt" | "text" | "voice";

const MODES: Array<{ value: CaptureMode; label: string; icon: typeof Camera }> = [
  { value: "screenshot", label: "Screenshot", icon: Camera },
  { value: "receipt", label: "Receipt", icon: Receipt },
  { value: "text", label: "Text", icon: Type },
  { value: "voice", label: "Voice", icon: Mic },
];

const MAX_BYTES = 12 * 1024 * 1024;
const ACCEPTED = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf)$/i;
const POLL_MS = 1500;
const POLL_LIMIT_MS = 120_000;
const PROGRESS = ["Reading the amount and the date…", "Matching your accounts and merchants…", "Checking it isn't already in your books…", "Almost there…"];
const EXAMPLES = ["আজ বিকাশে ১২৫০ টাকা Foodpanda", "Paid 20$ ChatGPT from Amex", "salary 185k received", "gotokal rickshaw 80 tk cash"];

type Busy =
  | { phase: "idle" }
  | { phase: "uploading"; label: string; preview: string | null }
  | { phase: "reading"; captureId: string; label: string; preview: string | null; slow: boolean }
  | { phase: "failed"; captureId: string | null; message: string; retryable: boolean; preview: string | null; label: string };

// ------------------------------------------------------------------ speech

type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechCtor = new () => SpeechRecognitionLike;

function speechRecognition(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ------------------------------------------------------------------- view

/**
 * Capture: a screenshot, a receipt photo, a PDF, a sentence or a voice note
 * becomes draft transactions to review. Nothing is posted from here.
 */
export function CaptureView({
  initialMode,
  initialText,
  status,
  recent,
}: {
  initialMode: CaptureMode;
  initialText: string | null;
  status: AiStatusView | null;
  recent: CaptureListItem[];
}) {
  const router = useRouter();
  const { canWrite } = useApp();
  const [mode, setMode] = useState<CaptureMode>(initialMode);
  const [busy, setBusy] = useState<Busy>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState(initialText ?? "");
  const [tick, setTick] = useState(0);
  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  const previewRef = useRef<string | null>(null);
  const autoSubmitted = useRef(false);

  const chooseMode = (next: CaptureMode) => {
    setMode(next);
    router.replace(`/capture?mode=${next}`, { scroll: false });
  };

  // Stop polling and free the preview when leaving the page.
  useEffect(
    () => () => {
      if (pollRef.current) pollRef.current.cancelled = true;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  // A calm, rotating line while the capture is being read.
  useEffect(() => {
    if (busy.phase !== "reading") return;
    const timer = setInterval(() => setTick((t) => t + 1), 2400);
    return () => clearInterval(timer);
  }, [busy.phase]);

  const settle = useCallback(
    (view: CaptureViewData, preview: string | null, label: string) => {
      const { id, stage } = view.capture;
      if (stage === "failed") {
        setBusy({
          phase: "failed",
          captureId: id,
          message: view.capture.error ?? "This capture could not be read.",
          retryable: view.capture.retryable,
          preview,
          label,
        });
        return;
      }
      if (stage === "posted") toast.success("Posted automatically", { description: "Every field was read with near certainty." });
      router.push(`/capture/${id}`);
    },
    [router],
  );

  const poll = useCallback(
    async (captureId: string, preview: string | null, label: string) => {
      if (pollRef.current) pollRef.current.cancelled = true;
      const token = { cancelled: false };
      pollRef.current = token;
      const started = Date.now();
      setBusy({ phase: "reading", captureId, label, preview, slow: false });
      while (!token.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (token.cancelled) return;
        try {
          const view = await clientApi<CaptureViewData>(`/captures/${captureId}`);
          if (view.capture.stage !== "processing" && view.capture.stage !== "received") return settle(view, preview, label);
        } catch {
          // A blip while polling is not a failure; the next poll decides.
        }
        const elapsed = Date.now() - started;
        if (elapsed > 20_000) setBusy((b) => (b.phase === "reading" && !b.slow ? { ...b, slow: true } : b));
        if (elapsed > POLL_LIMIT_MS) {
          setBusy({
            phase: "failed",
            captureId,
            message: "This is taking longer than usual. It will keep going in the background and show up in Recent captures.",
            retryable: true,
            preview,
            label,
          });
          return;
        }
      }
    },
    [settle],
  );

  const handle = useCallback(
    (view: CaptureViewData, preview: string | null, label: string) => {
      if (view.capture.stage === "processing" || view.capture.stage === "received") void poll(view.capture.id, preview, label);
      else settle(view, preview, label);
    },
    [poll, settle],
  );

  const upload = useCallback(
    async (file: File, kind: "screenshot" | "receipt" | "pdf") => {
      if (!canWrite) return;
      if (!ACCEPTED.test(file.type)) return toast.error("That file type can't be read", { description: "Use a PNG, JPEG, WebP or HEIC image, or a PDF." });
      if (file.size > MAX_BYTES) return toast.error("That file is larger than 12 MB");
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const preview = file.type.startsWith("image/") && !/hei[cf]/i.test(file.type) ? URL.createObjectURL(file) : null;
      previewRef.current = preview;
      const label = file.name || (kind === "receipt" ? "Receipt photo" : "Pasted screenshot");
      setBusy({ phase: "uploading", label, preview });
      const body = new FormData();
      body.append("file", file, file.name || `capture.${file.type.split("/")[1] ?? "png"}`);
      body.append("kind", file.type === "application/pdf" ? "pdf" : kind);
      try {
        const view = await clientApi<CaptureViewData>("/captures", { method: "POST", body });
        handle(view, preview, label);
      } catch (error) {
        setBusy({ phase: "failed", captureId: null, message: errorMessage(error), retryable: false, preview, label });
      }
    },
    [canWrite, handle],
  );

  const submitText = useCallback(
    async (value: string, kind: "text" | "voice") => {
      const trimmed = value.trim();
      if (trimmed.length < 2 || !canWrite) return;
      setBusy({ phase: "uploading", label: kind === "voice" ? "Voice note" : "Note", preview: null });
      try {
        const view = await clientApi<CaptureViewData>("/captures/text", { method: "POST", body: { text: trimmed, kind } });
        handle(view, null, kind === "voice" ? "Voice note" : "Note");
      } catch (error) {
        setBusy({ phase: "failed", captureId: null, message: errorMessage(error), retryable: false, preview: null, label: "Note" });
      }
    },
    [canWrite, handle],
  );

  // `?text=` from the command palette submits once.
  useEffect(() => {
    if (autoSubmitted.current || !initialText || initialMode !== "text") return;
    autoSubmitted.current = true;
    router.replace("/capture?mode=text", { scroll: false });
    void submitText(initialText, "text");
  }, [initialText, initialMode, router, submitText]);

  // Paste an image or PDF anywhere on the page.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((f) => ACCEPTED.test(f.type));
      if (!file) return;
      event.preventDefault();
      if (mode === "text" || mode === "voice") {
        setMode("screenshot");
        router.replace("/capture?mode=screenshot", { scroll: false });
      }
      void upload(file, mode === "receipt" ? "receipt" : "screenshot");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [mode, router, upload]);

  const retry = async () => {
    if (busy.phase !== "failed" || !busy.captureId) return setBusy({ phase: "idle" });
    const { captureId, preview, label } = busy;
    setBusy({ phase: "reading", captureId, label, preview, slow: false });
    try {
      const view = await clientApi<CaptureViewData>(`/captures/${captureId}/retry`, { method: "POST", body: {} });
      handle(view, preview, label);
    } catch (error) {
      setBusy({ phase: "failed", captureId, message: errorMessage(error), retryable: true, preview, label });
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file, mode === "receipt" ? "receipt" : "screenshot");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Capture</h1>
        <p className="text-sm text-muted-foreground">
          A screenshot, a receipt, a sentence or your voice becomes a draft you confirm. Nothing is posted until you say so.
        </p>
      </div>

      <AiAvailabilityNotice status={status} />

      <Segmented value={mode} onChange={chooseMode} items={MODES} size="md" label="Capture mode" className="max-w-xl" />

      {busy.phase !== "idle" ? (
        <BusyCard busy={busy} tick={tick} onRetry={() => void retry()} onReset={() => setBusy({ phase: "idle" })} />
      ) : mode === "screenshot" || mode === "receipt" ? (
        <DropZone mode={mode} dragging={dragging} setDragging={setDragging} onDrop={onDrop} onFile={(file) => void upload(file, mode)} disabled={!canWrite} />
      ) : mode === "text" ? (
        <TextCapture
          value={text}
          onChange={setText}
          onSubmit={() => void submitText(text, "text")}
          disabled={!canWrite}
          aiAvailable={status?.available ?? false}
        />
      ) : (
        <VoiceCapture onSubmit={(value, kind) => void submitText(value, kind)} disabled={!canWrite} />
      )}

      <Section
        title="Recent captures"
        hint="Everything you capture waits here until it is posted or discarded."
        href="/ai/inbox?show=drafts"
        linkLabel="Drafts in the inbox"
      >
        {recent.length ? (
          <ul className="-mx-1 divide-y divide-border">
            {recent.map((item) => (
              <RecentRow key={item.id} item={item} />
            ))}
          </ul>
        ) : (
          <EmptyNote>
            Nothing captured yet. Drop a bKash or bank screenshot, snap a receipt, or type “lunch 350 tk”: each becomes a draft with the amount, date, account
            and category filled in for you to check.
          </EmptyNote>
        )}
      </Section>
    </div>
  );
}

function RecentRow({ item }: { item: CaptureListItem }) {
  const kind = CAPTURE_KIND[item.kind];
  const Icon = kind.icon;
  const summary = item.inputText ?? (item.draftCount ? `${item.draftCount} transaction${item.draftCount === 1 ? "" : "s"} found` : (item.error ?? kind.label));
  return (
    <li>
      <Link href={`/capture/${item.id}`} className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-accent/40">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{summary}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {kind.label} · {timeAgo(item.createdAt)}
            {item.isSubscription && " · subscription detected"}
          </span>
        </span>
        <StageBadge stage={item.stage} />
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function DropZone({
  mode,
  dragging,
  setDragging,
  onDrop,
  onFile,
  disabled,
}: {
  mode: "screenshot" | "receipt";
  dragging: boolean;
  setDragging: (value: boolean) => void;
  onDrop: (event: DragEvent) => void;
  onFile: (file: File) => void;
  disabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const pick = (input: HTMLInputElement | null) => {
    const file = input?.files?.[0];
    if (file) onFile(file);
    if (input) input.value = "";
  };
  return (
    <section
      aria-label={mode === "receipt" ? "Upload a receipt" : "Upload a screenshot"}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
        {mode === "receipt" ? <Receipt className="size-7" /> : <ImageUp className="size-7" />}
      </span>
      <div className="max-w-md space-y-1">
        <p className="text-base font-medium">{mode === "receipt" ? "Snap or upload a receipt" : "Drop a screenshot here"}</p>
        <p className="text-sm text-muted-foreground">
          {mode === "receipt"
            ? "A shop receipt, an invoice or a PDF. The total, date and merchant are read; line items are kept."
            : "bKash, Nagad, Rocket, a banking app or a card SMS. Several payments on one screen become several drafts."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {mode === "receipt" && (
          <Button type="button" className="md:hidden" disabled={disabled} onClick={() => cameraRef.current?.click()}>
            <Camera className="size-4" /> Take a photo
          </Button>
        )}
        <Button
          type="button"
          variant={mode === "receipt" ? "outline" : "default"}
          className={cn(mode === "receipt" && "max-md:hidden md:inline-flex")}
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          <ImageUp className="size-4" /> Choose a file
        </Button>
        {mode === "receipt" && (
          <Button type="button" variant="outline" className="md:hidden" disabled={disabled} onClick={() => fileRef.current?.click()}>
            <ImageUp className="size-4" /> From gallery
          </Button>
        )}
      </div>
      <p className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
        <ClipboardPaste className="size-3.5" /> or paste it anywhere on this page with <Kbd>⌘</Kbd>
        <Kbd>V</Kbd> / <Kbd>Ctrl</Kbd>
        <Kbd>V</Kbd>
      </p>
      <p className="text-[11px] text-muted-foreground">PNG, JPEG, WebP, HEIC or PDF up to 12 MB.</p>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="sr-only" tabIndex={-1} onChange={(e) => pick(e.currentTarget)} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} onChange={(e) => pick(e.currentTarget)} />
    </section>
  );
}

function TextCapture({
  value,
  onChange,
  onSubmit,
  disabled,
  aiAvailable,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  aiAvailable: boolean;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <label htmlFor="capture-text" className="text-sm font-medium">
        Type it the way you'd say it
      </label>
      <Textarea
        id="capture-text"
        rows={4}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={EXAMPLES.join("\n")}
        disabled={disabled}
      />
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.slice(0, 3).map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onChange(example)}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          >
            {example}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Bangla, English or Banglish.{" "}
          {aiAvailable ? "Clear notes are read instantly without AI; the model helps with the rest." : "Read by the built-in parser."}
        </p>
        <Button type="submit" disabled={disabled || value.trim().length < 2}>
          <Send className="size-4" /> Make a draft
          <Kbd className="ms-1 hidden sm:inline-flex">⌘↵</Kbd>
        </Button>
      </div>
    </form>
  );
}

function VoiceCapture({ onSubmit, disabled }: { onSubmit: (value: string, kind: "text" | "voice") => void; disabled: boolean }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [lang, setLang] = useState<"bn-BD" | "en-US">("bn-BD");
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setSupported(Boolean(speechRecognition()));
    return () => recognition.current?.abort();
  }, []);

  const start = () => {
    const Ctor = speechRecognition();
    if (!Ctor) return;
    setError(null);
    setInterim("");
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let heard = "";
      let spoken = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        if (result.isFinal) spoken += result[0].transcript;
        else heard += result[0].transcript;
      }
      if (spoken) setFinalText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${spoken.trim()}`);
      setInterim(heard);
    };
    rec.onerror = (event) => {
      setError(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in the browser to use voice."
          : event.error === "no-speech"
            ? "Didn't catch anything. Try again a little closer."
            : `Voice input stopped (${event.error}).`,
      );
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      setInterim("");
    };
    recognition.current = rec;
    rec.start();
    setListening(true);
  };

  const stop = () => recognition.current?.stop();
  const transcript = `${finalText}${interim ? `${finalText ? " " : ""}${interim}` : ""}`;

  if (supported === false) {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="info" icon={MicOff} title="Voice input isn't supported in this browser">
          Chrome, Edge and Safari support it. You can type the same thing below; it is read the same way.
        </Callout>
        <TextFallback onSubmit={(value) => onSubmit(value, "text")} disabled={disabled} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={lang}
          onChange={(value) => setLang(value)}
          label="Language"
          items={[
            { value: "bn-BD", label: "বাংলা" },
            { value: "en-US", label: "English" },
          ]}
        />
        <p className="text-xs text-muted-foreground">Speech is turned into text by your browser; only the text is sent.</p>
      </div>
      <div className="flex flex-col items-center gap-3 py-4">
        <button
          type="button"
          disabled={disabled || supported === null}
          onClick={listening ? stop : start}
          aria-pressed={listening}
          aria-label={listening ? "Stop listening" : "Start listening"}
          className={cn(
            "relative flex size-20 items-center justify-center rounded-full transition-colors disabled:opacity-50",
            listening ? "bg-red-500 text-white" : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {listening && <span className="absolute inset-0 animate-ping rounded-full bg-red-500/40" />}
          {listening ? <MicOff className="relative size-8" /> : <Mic className="relative size-8" />}
        </button>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {listening
            ? "Listening… say the amount, what it was for and how you paid."
            : finalText
              ? "Check the text, then make the draft."
              : "Tap and speak, e.g. “Foodpanda te 650 taka bKash diye”."}
        </p>
      </div>
      <Textarea
        rows={3}
        value={listening ? transcript : finalText}
        onChange={(e) => setFinalText(e.target.value)}
        readOnly={listening}
        placeholder="Your words appear here"
        aria-label="Transcript"
      />
      {error && <p className="text-sm text-destructive-foreground">{error}</p>}
      <div className="flex justify-end gap-2">
        {finalText && !listening && (
          <Button type="button" variant="outline" onClick={() => setFinalText("")}>
            <RotateCcw className="size-4" /> Clear
          </Button>
        )}
        <Button type="button" disabled={disabled || listening || finalText.trim().length < 2} onClick={() => onSubmit(finalText, "voice")}>
          <Send className="size-4" /> Make a draft
        </Button>
      </div>
    </div>
  );
}

function TextFallback({ onSubmit, disabled }: { onSubmit: (value: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  return <TextCapture value={value} onChange={setValue} onSubmit={() => onSubmit(value)} disabled={disabled} aiAvailable={false} />;
}

function BusyCard({ busy, tick, onRetry, onReset }: { busy: Exclude<Busy, { phase: "idle" }>; tick: number; onRetry: () => void; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-8 text-center sm:flex-row sm:text-left">
      <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
        {busy.preview ? (
          // biome-ignore lint/performance/noImgElement: a local object URL preview
          <img src={busy.preview} alt="" className="size-full object-cover" />
        ) : busy.label.toLowerCase().includes("pdf") ? (
          <FileText className="size-8 text-muted-foreground" />
        ) : (
          <Sparkles className="size-8 text-violet-500" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2" aria-live="polite">
        <p className="truncate text-sm text-muted-foreground">{busy.label}</p>
        {busy.phase === "uploading" && (
          <p className="flex items-center justify-center gap-2 text-base font-medium sm:justify-start">
            <Spinner className="size-4" /> Sending…
          </p>
        )}
        {busy.phase === "reading" && (
          <>
            <p className="flex items-center justify-center gap-2 text-base font-medium sm:justify-start">
              <Spinner className="size-4" /> {PROGRESS[tick % PROGRESS.length]}
            </p>
            <p className="text-xs text-muted-foreground">
              {busy.slow
                ? "Taking a little longer than usual. You can leave this page; the draft will be waiting in Recent captures."
                : "Usually a few seconds."}
            </p>
          </>
        )}
        {busy.phase === "failed" && (
          <>
            <p className="text-base font-medium">Couldn't finish reading this</p>
            <p className="text-sm text-muted-foreground">{busy.message}</p>
            <div className="flex flex-wrap justify-center gap-2 pt-1 sm:justify-start">
              {busy.captureId && busy.retryable && (
                <Button size="sm" onClick={onRetry}>
                  <RotateCcw className="size-3.5" /> Try again
                </Button>
              )}
              {busy.captureId && (
                <Button size="sm" variant="outline" render={<Link href={`/capture/${busy.captureId}`} />}>
                  Enter it by hand
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onReset}>
                Capture something else
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
