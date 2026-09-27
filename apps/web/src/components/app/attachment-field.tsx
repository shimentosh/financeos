"use client";

import { Copy, FileText, ImageIcon, Loader2, Paperclip, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { ATTACHMENT_ACCEPT, attachmentProblem, deleteFile, fileUrl, IMAGE_ACCEPT, uploadFile } from "@/lib/api/files";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { toast } from "@/lib/toast";

/** A file attached to a record. `isNew` marks one uploaded in this form and not yet saved with it. */
export type Attachment = { id: string; filename: string; contentType: string; size: number; isNew?: boolean; duplicateOf?: string | null };

// Browsers other than Safari can't draw HEIC, so those get an icon instead of a thumbnail.
const drawable = (type: string) => type.startsWith("image/") && !/hei[cf]/.test(type);

/** Deletes files uploaded in a form that was then closed without saving, so they don't linger. */
export function discardNewAttachments(attachments: Attachment[]) {
  for (const file of attachments) if (file.isNew) void deleteFile(file.id).catch(() => undefined);
}

/**
 * Attach invoices, receipts and documents: browse, drop, or paste a
 * screenshot. Files upload as soon as they are chosen, so saving the form is
 * instant; the form sends only their ids.
 */
export function AttachmentField({
  value,
  onChange,
  kind = "receipt",
  max = 10,
  label = "Invoice or receipt",
  hint = "Photos, screenshots or PDFs, up to 12 MB each. You can also paste a screenshot.",
  disabled = false,
  pasteFromClipboard = true,
  imagesOnly = false,
  className,
}: {
  value: Attachment[];
  onChange: (next: Attachment[]) => void;
  kind?: "receipt" | "attachment" | "other";
  max?: number;
  label?: string;
  /** `null` hides it. */
  hint?: string | null;
  disabled?: boolean;
  /** Pick up images pasted anywhere on the page while this field is shown. */
  pasteFromClipboard?: boolean;
  /** Pictures only (no PDFs). */
  imagesOnly?: boolean;
  className?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<Array<{ key: string; name: string }>>([]);
  const [dragging, setDragging] = useState(false);
  // The latest list, for uploads that finish after the user changed it.
  const current = useRef(value);
  current.current = value;

  const add = async (files: File[]) => {
    if (disabled || !files.length) return;
    const room = max - current.current.length - uploading.length;
    if (room <= 0) {
      toast.error(`At most ${max} files`);
      return;
    }
    if (files.length > room) toast.error(`Only the first ${room} file${room === 1 ? "" : "s"} were added (at most ${max})`);
    for (const file of files.slice(0, room)) {
      const problem = attachmentProblem(file, { imagesOnly });
      if (problem) {
        toast.error(problem);
        continue;
      }
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setUploading((list) => [...list, { key, name: file.name }]);
      try {
        const saved = await uploadFile(file, kind);
        current.current = [...current.current, { ...saved, isNew: true }];
        onChange(current.current);
      } catch (error) {
        toast.error(`${file.name}: ${errorMessage(error)}`);
      } finally {
        setUploading((list) => list.filter((item) => item.key !== key));
      }
    }
  };

  const remove = (file: Attachment) => {
    current.current = current.current.filter((f) => f.id !== file.id);
    onChange(current.current);
    // Only a file uploaded here is deleted; one already saved may be referenced elsewhere and is just unlinked.
    if (file.isNew) void deleteFile(file.id).catch(() => undefined);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `add` reads the latest list through a ref
  useEffect(() => {
    if (!pasteFromClipboard || disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (!pasted.length) return;
      event.preventDefault();
      void add(pasted);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pasteFromClipboard, disabled]);

  const full = value.length + uploading.length >= max;

  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="font-medium text-sm">
          {label}
        </label>
        {value.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{value.length} attached</span>}
      </div>

      {(value.length > 0 || uploading.length > 0) && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {value.map((file) => (
            <li key={file.id} className="group relative flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card p-1.5 pe-8">
              <a
                href={fileUrl(file.id)}
                target="_blank"
                rel="noreferrer"
                className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground"
                aria-label={`Open ${file.filename}`}
              >
                {drawable(file.contentType) ? (
                  // biome-ignore lint/performance/noImgElement: authenticated file route, not a static asset
                  <img src={fileUrl(file.id)} alt="" className="size-full object-cover" />
                ) : file.contentType.startsWith("image/") ? (
                  <ImageIcon className="size-4" aria-hidden />
                ) : (
                  <FileText className="size-4" aria-hidden />
                )}
              </a>
              <div className="min-w-0">
                <a href={fileUrl(file.id)} target="_blank" rel="noreferrer" className="block truncate text-sm hover:underline">
                  {file.filename}
                </a>
                <p className="truncate text-xs text-muted-foreground tabular-nums">
                  {formatBytes(file.size)}
                  {file.duplicateOf && (
                    <span
                      className="ms-1 inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400"
                      title="The same file was uploaded before: is this a duplicate?"
                    >
                      <Copy className="size-3" aria-hidden /> uploaded before
                    </span>
                  )}
                </p>
              </div>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(file)}
                  className="absolute end-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`Remove ${file.filename}`}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
          {uploading.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border p-1.5" aria-live="polite">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              </span>
              <span className="min-w-0 truncate text-sm text-muted-foreground">Uploading {item.name}…</span>
            </li>
          ))}
        </ul>
      )}

      {!disabled && !full && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void add([...event.dataTransfer.files]);
          }}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
            dragging ? "border-foreground bg-accent text-foreground" : "border-border",
          )}
        >
          <Paperclip className="size-4" aria-hidden />
          {value.length ? "Attach another file" : "Attach a file — or drop it here"}
        </button>
      )}
      <input
        ref={input}
        id={id}
        type="file"
        accept={imagesOnly ? IMAGE_ACCEPT : ATTACHMENT_ACCEPT}
        multiple={max > 1}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          void add(chosen);
        }}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
