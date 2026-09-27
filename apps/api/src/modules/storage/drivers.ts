import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface Driver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class LocalDriver implements Driver {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(process.cwd(), dir);
  }

  private path(key: string) {
    const target = resolve(this.root, key);
    // Keys are generated here, but never let one escape the storage root.
    if (!target.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return target;
  }

  async put(key: string, body: Buffer) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

/** One S3-compatible bucket: AWS S3, Cloudflare R2, MinIO, B2, Wasabi… */
export type S3Settings = {
  /** Empty for AWS S3 itself. */
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
  /** Ask for SSE-S3. AWS honours it; R2 encrypts everything at rest anyway and some stores reject the header. */
  serverSideEncryption: boolean;
};

const TIMEOUT_MS = 20_000;

export class S3Driver implements Driver {
  private readonly client: S3Client;

  constructor(private readonly settings: S3Settings) {
    this.client = new S3Client({
      region: settings.region,
      endpoint: settings.endpoint || undefined,
      forcePathStyle: settings.forcePathStyle,
      credentials:
        settings.accessKeyId && settings.secretAccessKey ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey } : undefined,
      // Newer SDKs add CRC checksums to every request; not every S3-compatible store accepts them.
      ...(settings.endpoint ? { requestChecksumCalculation: "WHEN_REQUIRED" as const, responseChecksumValidation: "WHEN_REQUIRED" as const } : {}),
      maxAttempts: 3,
    });
  }

  get bucket() {
    return this.settings.bucket;
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.settings.serverSideEncryption ? { ServerSideEncryption: "AES256" as const } : {}),
      }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
  }

  async get(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    return Buffer.from(await (result.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  destroy() {
    this.client.destroy();
  }
}

/** What went wrong talking to a bucket, in words an admin can act on. */
export function describeStorageError(error: unknown, settings: Pick<S3Settings, "bucket" | "endpoint"> & { provider?: "r2" | "s3" }): string {
  const e = error as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number }; cause?: { code?: string } };
  const name = e?.name ?? "";
  const code = e?.code ?? e?.cause?.code ?? "";
  const status = e?.$metadata?.httpStatusCode;
  const where = settings.endpoint ?? "AWS S3";
  const r2 = settings.provider === "r2";
  if (name === "NoSuchBucket")
    return `There's no bucket called "${settings.bucket}"${r2 ? " in this Cloudflare account" : ""}. Check the name, or create it first.`;
  if (name === "InvalidAccessKeyId") return "The access key ID isn't recognised. Copy it again from the API token page.";
  if (name === "SignatureDoesNotMatch") return "The secret access key doesn't belong to this access key ID.";
  if (name === "AccessDenied" || status === 403) {
    return r2
      ? `The token isn't allowed to use "${settings.bucket}". In Cloudflare → R2 → Manage API tokens, give it Object Read & Write on this bucket.`
      : `The key isn't allowed to use "${settings.bucket}". It needs s3:PutObject, s3:GetObject and s3:DeleteObject on the bucket.`;
  }
  if (status === 401 || name === "Unauthorized") return "The storage service rejected the credentials.";
  if (name === "NoSuchKey") return "The file isn't in the bucket any more.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Can't find ${where}.${r2 ? " Check the account ID." : " Check the endpoint URL."}`;
  if (code === "ECONNREFUSED") return `Nothing is answering at ${where}.`;
  if (name === "TimeoutError" || name === "AbortError") return `${where} didn't answer within ${TIMEOUT_MS / 1000} seconds.`;
  if (code === "ENOENT") return "The file isn't on this server's disk any more.";
  return e?.message || String(error);
}
