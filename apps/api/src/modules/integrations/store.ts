import { and, eq } from "drizzle-orm";
import { contextFor, type WorkspaceContext, type WorkspaceRecord } from "../../common/context.js";
import { assertFound } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { integrationConnections, workspaces } from "../../db/schema/index.js";
import { env } from "../../env.js";
import type { ConnectionInfo } from "./connectors/types.js";
import { decryptJson, decryptSecret, encryptJson, encryptSecret, SecretDecryptionError } from "./crypto.js";

export type ConnectionRow = typeof integrationConnections.$inferSelect;

// The associated data binds each ciphertext to its connection and purpose.
export const credentialsAad = (connectionId: string) => `integration:${connectionId}:credentials`;
export const webhookAad = (connectionId: string) => `integration:${connectionId}:webhook`;

export function sealCredentials(connectionId: string, credentials: Record<string, string>): string | null {
  const present = Object.fromEntries(Object.entries(credentials).filter(([, value]) => typeof value === "string" && value !== ""));
  return Object.keys(present).length ? encryptJson(present, { aad: credentialsAad(connectionId) }) : null;
}

/** Decrypted credentials; `readable: false` when the key changed or the value was tampered with. */
export function openCredentials(row: Pick<ConnectionRow, "id" | "credentialsEncrypted">): { credentials: Record<string, string>; readable: boolean } {
  if (!row.credentialsEncrypted) return { credentials: {}, readable: true };
  try {
    return { credentials: decryptJson(row.credentialsEncrypted, { aad: credentialsAad(row.id) }), readable: true };
  } catch (error) {
    if (error instanceof SecretDecryptionError || error instanceof SyntaxError) return { credentials: {}, readable: false };
    throw error;
  }
}

export function sealWebhookSecret(connectionId: string, secret: string): string {
  return encryptSecret(secret, { aad: webhookAad(connectionId) });
}

export function openWebhookSecret(row: Pick<ConnectionRow, "id" | "webhookSecretEncrypted">): string | null {
  if (!row.webhookSecretEncrypted) return null;
  try {
    return decryptSecret(row.webhookSecretEncrypted, { aad: webhookAad(row.id) });
  } catch {
    return null;
  }
}

/** The public URL providers post to: the web origin proxies /api/* to the API. */
export function webhookUrl(publicId: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/api/webhooks/${publicId}`;
}

export async function loadWorkspace(workspaceId: string, exec: Executor = db): Promise<WorkspaceRecord> {
  const [row] = await exec.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return assertFound(row, "Workspace");
}

/** How integrations act in a workspace: no user, actor type "integration". */
export async function integrationContext(workspaceId: string, exec: Executor = db): Promise<WorkspaceContext> {
  return contextFor(await loadWorkspace(workspaceId, exec), { userId: null, actorType: "integration" });
}

export async function getConnection(ctx: Pick<WorkspaceContext, "workspaceId">, id: string, exec: Executor = db): Promise<ConnectionRow> {
  const [row] = await exec
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.id, id), eq(integrationConnections.workspaceId, ctx.workspaceId)))
    .limit(1);
  return assertFound(row, "Integration");
}

export function connectionInfo(row: ConnectionRow, workspace: Pick<WorkspaceRecord, "timezone" | "baseCurrency">): ConnectionInfo {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    provider: row.provider,
    accountId: row.accountId,
    projectId: row.projectId,
    createdAt: row.createdAt,
    timezone: workspace.timezone,
    baseCurrency: workspace.baseCurrency,
  };
}
