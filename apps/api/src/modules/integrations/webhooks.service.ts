import { uuidv7 } from "@financeos/core";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { badRequest, DomainError, notFound, tooManyRequests, unauthorized } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { integrationConnections, webhookEvents } from "../../db/schema/index.js";
import { JobsService } from "../system/jobs.service.js";
import { hit } from "../system/rate-limit.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import type { AnyConnector, ParsedWebhook } from "./connectors/types.js";
import { sha256Hex } from "./crypto.js";
import { recordErrorMessage } from "./pipeline.service.js";
import { type ConnectionRow, openCredentials, openWebhookSecret } from "./store.js";
import { type SyncRunRow, SyncService } from "./sync.service.js";

export const WEBHOOK_JOB = "integrations.webhook";
/** Per webhook URL, per minute. Providers retry on 429. */
const WEBHOOK_RATE_LIMIT = 300;

export type WebhookReceipt = { status: "received" | "duplicate"; eventId: string; webhookEventId: string | null };
export type WebhookEventRow = typeof webhookEvents.$inferSelect;

function lowerHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  return out;
}

/** What the UI shows for an event: never the payload of an unverified request. */
export function webhookEventView(row: WebhookEventRow) {
  return {
    id: row.id,
    providerEventId: row.signatureValid ? row.providerEventId : null,
    eventType: row.eventType,
    signatureValid: row.signatureValid,
    status: row.status,
    error: row.error,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

/**
 * Inbound webhooks: find the connection by its unguessable URL id, verify the
 * signature with its connector (an unverified request is recorded and
 * refused), store the event once per provider event id, and hand processing
 * to a job that runs the same pipeline as a sync.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger("Webhooks");

  constructor(
    @Inject(ConnectorRegistry) private readonly registry: ConnectorRegistry,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register(WEBHOOK_JOB, async (payload) => {
      const result = await this.process(String(payload.webhookEventId));
      return { status: result.status, runId: result.run?.id ?? null };
    });
  }

  /** The signing secret for a connection: the provider's (e.g. Stripe's whsec_) or the generated one. */
  signingSecret(connection: ConnectionRow, connector: AnyConnector): string | null {
    if (connector.webhookSecretCredential) {
      const provided = openCredentials(connection).credentials[connector.webhookSecretCredential];
      if (provided) return provided;
    }
    return openWebhookSecret(connection);
  }

  async receive(
    publicId: string,
    rawHeaders: Record<string, string | string[] | undefined>,
    rawBody: Buffer | undefined,
    now = new Date(),
  ): Promise<WebhookReceipt> {
    if (!/^wh_[A-Za-z0-9]{20,64}$/.test(publicId)) throw notFound("Webhook");
    const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.webhookPublicId, publicId)).limit(1);
    const connector = connection ? this.registry.get(connection.provider) : null;
    if (!connection || !connector?.verifyWebhook || !connector.parseWebhook || connection.status === "disconnected") throw notFound("Webhook");
    // Counted only for real endpoints, so guessing ids cannot fill the table.
    if (!(await hit(`webhook:${publicId}`, WEBHOOK_RATE_LIMIT, 60))) throw tooManyRequests();
    if (!rawBody?.length) throw badRequest("Send the event as a JSON body (Content-Type: application/json)", "empty_body");

    const headers = lowerHeaders(rawHeaders);
    const secret = this.signingSecret(connection, connector);
    let verified = false;
    try {
      verified = Boolean(secret) && connector.verifyWebhook({ headers, rawBody, secret: secret ?? "", now });
    } catch {
      verified = false;
    }
    if (!verified) {
      // Recorded for the user to see, under an id nobody can collide with, so
      // a forged request can never block the real event later.
      let claimedType = "unknown";
      try {
        claimedType = String((JSON.parse(rawBody.toString("utf8")) as { type?: unknown }).type ?? "unknown").slice(0, 60);
      } catch {
        // Not JSON: nothing to report.
      }
      await db.insert(webhookEvents).values({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        providerEventId: `unverified:${uuidv7()}`,
        eventType: claimedType,
        signatureValid: false,
        status: "failed",
        error: secret ? "Signature verification failed" : "No signing secret is configured for this connection",
        payload: null,
      });
      throw unauthorized("Invalid webhook signature");
    }

    let parsed: ParsedWebhook;
    try {
      parsed = connector.parseWebhook(rawBody, headers);
    } catch (error) {
      const message = recordErrorMessage(error, this.logger);
      await db
        .insert(webhookEvents)
        .values({
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          providerEventId: `malformed:${sha256Hex(rawBody)}`,
          eventType: "malformed",
          signatureValid: true,
          status: "failed",
          error: message.slice(0, 500),
          payload: null,
        })
        .onConflictDoNothing();
      throw new DomainError(400, message, "invalid_event");
    }

    const [row] = await db
      .insert(webhookEvents)
      .values({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        providerEventId: parsed.eventId.slice(0, 200),
        eventType: parsed.eventType.slice(0, 100),
        signatureValid: true,
        status: "received",
        payload: JSON.parse(rawBody.toString("utf8")) as object,
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!row) return { status: "duplicate", eventId: parsed.eventId, webhookEventId: null };

    await this.jobs.enqueue(WEBHOOK_JOB, { webhookEventId: row.id }, { workspaceId: connection.workspaceId, dedupeKey: `webhook:${row.id}` });
    return { status: "received", eventId: parsed.eventId, webhookEventId: row.id };
  }

  /** Imports a stored event. Idempotent: an event is processed once. */
  async process(webhookEventId: string): Promise<{ status: WebhookEventRow["status"]; run: SyncRunRow | null }> {
    const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).limit(1);
    if (!event) return { status: "failed", run: null };
    if (event.status !== "received") return { status: event.status, run: null };
    const finish = async (status: WebhookEventRow["status"], error: string | null) => {
      await db.update(webhookEvents).set({ status, error, processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
    };

    const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, event.connectionId)).limit(1);
    const connector = connection ? this.registry.get(connection.provider) : null;
    if (!connection || connection.status === "disconnected" || !connector?.parseWebhook) {
      await finish("ignored", "The integration is disconnected");
      return { status: "ignored", run: null };
    }
    let records: ParsedWebhook["records"];
    try {
      records = connector.parseWebhook(Buffer.from(JSON.stringify(event.payload ?? {})), {}).records;
    } catch (error) {
      const message = recordErrorMessage(error, this.logger);
      await finish("failed", message);
      return { status: "failed", run: null };
    }
    if (!records.length) {
      await finish("ignored", `${event.eventType} events are not imported`);
      return { status: "ignored", run: null };
    }
    const run = await this.sync.ingestPushed(connection, connector, records, `webhook:${event.providerEventId}`.slice(0, 200));
    const failed = run?.status === "failed";
    const firstError = (run?.errorDetails ?? []).find((d) => (d as { kind?: string }).kind === "error")?.message ?? null;
    await finish(failed ? "failed" : "processed", failed ? firstError : null);
    return { status: failed ? "failed" : "processed", run };
  }

  recent(workspaceId: string, connectionId: string, limit = 20) {
    return db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.workspaceId, workspaceId), eq(webhookEvents.connectionId, connectionId)))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(limit);
  }
}
