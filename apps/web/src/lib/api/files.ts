"use client";

import { clientApi } from "./client";

/** A stored file as the API returns it after an upload. */
export type UploadedFile = { id: string; filename: string; contentType: string; size: number; duplicateOf: string | null };

/** Receipts, invoices and documents: images and PDFs (the API refuses anything else). */
export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,application/pdf,.heic,.heif,.pdf";
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.heic,.heif";
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const ACCEPTED = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf)$/;

/** Some systems (Windows with HEIC photos) leave the type empty; the extension still says what it is. */
const typeOf = (file: File) => file.type || (/\.(heic|heif)$/i.test(file.name) ? "image/heic" : /\.pdf$/i.test(file.name) ? "application/pdf" : "");

/** Why a file can't be attached, or null when it can. Checked before uploading to save a round trip. */
export function attachmentProblem(file: File, options: { imagesOnly?: boolean } = {}): string | null {
  const type = typeOf(file);
  if (options.imagesOnly && !type.startsWith("image/")) return `${file.name}: choose a picture (JPG, PNG, WebP or HEIC)`;
  if (!ACCEPTED.test(type)) return `${file.name}: only images (JPG, PNG, WebP, HEIC) and PDFs can be attached`;
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name} is larger than 12 MB`;
  if (!file.size) return `${file.name} is empty`;
  return null;
}

export function uploadFile(file: File, kind: "receipt" | "attachment" | "other" = "attachment", signal?: AbortSignal) {
  const body = new FormData();
  const type = typeOf(file);
  body.append("file", type === file.type ? file : new File([file], file.name, { type }), file.name);
  return clientApi<UploadedFile>("/files", { method: "POST", body, query: { kind }, signal });
}

export function deleteFile(id: string) {
  return clientApi<void>(`/files/${id}`, { method: "DELETE" });
}

export function fileUrl(id: string, options: { download?: boolean } = {}) {
  return `/api/files/${id}${options.download ? "?download=1" : ""}`;
}
