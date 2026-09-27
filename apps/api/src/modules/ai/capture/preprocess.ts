import sharp from "sharp";

export const MAX_IMAGE_EDGE = 2000;
export const JPEG_QUALITY = 85;
export const MAX_PDF_PAGES = 10;

export type PreparedImage = {
  data: Buffer;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  originalBytes: number;
  bytes: number;
};

/** A file the pipeline cannot read. Not worth retrying: the input itself is the problem. */
export class CaptureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureInputError";
  }
}

/**
 * Normalises a photo or screenshot before it is sent to a model: turned
 * upright from its EXIF orientation, metadata (location, device) dropped,
 * HEIC/PNG/WebP/GIF converted to JPEG on a white background, the long edge
 * at most 2000px, quality 85. Smaller, cheaper and the same for every input.
 */
export async function prepareImage(buffer: Buffer): Promise<PreparedImage> {
  try {
    // sharp writes no metadata unless asked to, so EXIF/GPS never leave the server.
    const { data, info } = await sharp(buffer, {
      failOn: "none",
      animated: false,
    })
      .rotate()
      .resize({
        width: MAX_IMAGE_EDGE,
        height: MAX_IMAGE_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      mimeType: "image/jpeg",
      width: info.width,
      height: info.height,
      originalBytes: buffer.length,
      bytes: data.length,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/heif|heic|compression format/i.test(detail)) {
      throw new CaptureInputError(
        "This HEIC photo could not be converted. Upload a screenshot or a JPEG instead (on iPhone: Settings → Camera → Formats → Most Compatible).",
      );
    }
    throw new CaptureInputError("This image could not be read. Upload a PNG, JPEG or WebP screenshot or photo.");
  }
}

/** A cheap page count from the PDF structure; null when it cannot be told. */
export function countPdfPages(buffer: Buffer): number | null {
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  const text = buffer.toString("latin1");
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return pages > 0 ? pages : null;
}

export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}
