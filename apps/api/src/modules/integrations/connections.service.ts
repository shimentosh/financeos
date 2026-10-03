import { type connectInput, uuidv7 } from "@financeos/core";
import type { connectionPatch, connectionRecordsQuery } from "@financeos/core/contracts/integrations-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { badRequest, conflict, DomainError, unprocessable } from "../../common/errors.js";
import { db } from "../../db/index.js";
import { categories, counterparties, financialAccounts, integrationConnections, projects, receivables, syncRuns, transactions } from "../../db/schema/index.js";
import { env } from "../../env.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { type AccountRow, AccountsService } from "../ledger/accounts.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { AuditService } from "../system/audit.service.js";
import { InboxService } from "../system/notify.service.js";
import { defaultHttpClient, type HttpClient, privateNetworkAllowed } from "./connectors/http.js";
import { type CatalogEntry, ConnectorRegistry } from "./connectors/registry.js";
import type { AnyConnector, ValidateResult } from "./connectors/types.js";
import { maskSecret, randomBase62 } from "./crypto.js";
import { recordErrorMessage } from "./pipeline.service.js";
import { type ConnectionRow, connectionInfo, getConnection, loadWorkspace, openCredentials, sealCredentials, sealWebhookSecret, webhookUrl } from "./store.js";
import { runDetail, runSummary, SyncService } from "./sync.service.js";
import { WebhooksService, webhookEventView } from "./webhooks.service.js";

type ConnectInput = z.output<typeof connectInput>;
type Deps = { http?: HttpClient; now?: Date };

export type ConnectionHealth = "healthy" | "syncing" | "pending" | "stale" | "degraded" | "failing" | "disconnected";

/** Shown once, when a webhook endpoint is created or rotated. */
export type WebhookSecretReveal = { url: string; secret: string; secretSource: "generated" | "provider"; signatureHeader: string | null };

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: "credentials" | "config"): T {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new DomainError(
    400,
    `Invalid ${label}: ${result.error.issues[0]?.path.join(".") || label} ${result.error.issues[0]?.message ?? ""}`.trim(),
    "validation_failed",
    result.error.issues.map((issue) => ({ path: [label, ...issue.path].join("."), message: issue.message })),
  );
}

function newWebhookEndpoint() {
  return { publicId: `wh_${randomBase62(24)}`, secret: `whsec_${randomBase62(32)}` };
}

/** Shallow merge where `null` removes a key. */
function mergeConfig(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function healthOf(row: ConnectionRow, connector: AnyConnector | null, readable: boolean, now = Date.now()): ConnectionHealth {
  if (row.status === "disconnected") return "disconnected";
  if (!readable || row.status === "needs_attention") return "failing";
  if (row.status === "syncing") return "syncing";
  if (row.status === "error") return "degraded";
  const syncs = Boolean(connector?.capabilities.sync);
  if (syncs && !row.lastSyncedAt) return "pending";
  if (syncs && row.lastSuccessAt && row.syncFrequency !== "manual") {
    const limit = row.syncFrequency === "hourly" ? 6 * 3600_000 : 3 * 86_400_000;
    if (now - row.lastSuccessAt.getTime() > limit) return "stale";
  }
  if (row.errorMessage) return "degraded";
  return "healthy";
}

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(ConnectorRegistry) private readonly registry: ConnectorRegistry,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(WebhooksService) private readonly webhooks: WebhooksService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  catalog(): CatalogEntry[] {
    return this.registry.catalog();
  }

  /** The public shape of a connection. Credentials appear only as "set" flags with a mask. */
  view(row: ConnectionRow, names: { accountName?: string | null; accountCurrency?: string | null; projectName?: string | null } = {}) {
    const connector = this.registry.get(row.provider);
    const { credentials, readable } = openCredentials(row);
    const fields = connector?.credentialFields ?? [];
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      displayName: connector?.displayName ?? row.provider,
      category: connector?.category ?? "custom",
      icon: connector?.icon ?? "plug",
      status: row.status,
      health: healthOf(row, connector, readable),
      capabilities: connector?.capabilities ?? { sync: false, webhook: false, import: false, testConnection: false },
      accountId: row.accountId,
      accountName: names.accountName ?? null,
      accountCurrency: names.accountCurrency ?? null,
      projectId: row.projectId,
      projectName: names.projectName ?? null,
      syncFrequency: row.syncFrequency,
      trustLevel: row.trustLevel,
      config: row.config ?? {},
      credentials: fields.map((field) => {
        const value = credentials[field.key];
        return { key: field.key, label: field.label, set: Boolean(value), masked: value ? maskSecret(value) : null };
      }),
      credentialsReadable: readable,
      webhook:
        connector?.capabilities.webhook && row.status !== "disconnected"
          ? {
              url: row.webhookPublicId ? webhookUrl(row.webhookPublicId) : null,
              hasSecret: Boolean(row.webhookSecretEncrypted),
              secretSource: connector.webhookSecretCredential ? ("provider" as const) : ("generated" as const),
              providerSecretSet: connector.webhookSecretCredential ? Boolean(credentials[connector.webhookSecretCredential]) : null,
              signatureHeader: connector.webhookDocs?.signatureHeader ?? null,
              scheme: connector.webhookDocs?.scheme ?? null,
              events: connector.webhookDocs?.events ?? [],
              supportsTestEvent: Boolean(connector.buildTestEvent),
            }
          : null,
      lastSyncedAt: row.lastSyncedAt,
      lastSuccessAt: row.lastSuccessAt,
      lastErrorAt: row.lastErrorAt,
      errorMessage: row.errorMessage,
      consecutiveFailures: row.consecutiveFailures,
      recordsTotal: row.recordsTotal,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async withNames(ctx: WorkspaceContext, where?: SQL) {
    return db
      .select({
        connection: integrationConnections,
        accountName: financialAccounts.name,
        accountCurrency: financialAccounts.currency,
        projectName: projects.name,
      })
      .from(integrationConnections)
      .leftJoin(financialAccounts, eq(financialAccounts.id, integrationConnections.accountId))
      .leftJoin(projects, eq(projects.id, integrationConnections.projectId))
      .where(and(eq(integrationConnections.workspaceId, ctx.workspaceId), where))
      .orderBy(asc(integrationConnections.createdAt));
  }

  private async viewById(ctx: WorkspaceContext, id: string) {
    const [row] = await this.withNames(ctx, eq(integrationConnections.id, id));
    if (!row) return this.view(await getConnection(ctx, id));
    return this.view(row.connection, row);
  }

  async list(ctx: WorkspaceContext) {
    const rows = await this.withNames(ctx);
    return rows.map((row) => this.view(row.connection, row));
  }

  /** Account and project ids anywhere in the request must belong to this workspace. */
  private async checkReferences(
    ctx: WorkspaceContext,
    connector: AnyConnector,
    config: Record<string, unknown>,
    accountId: string | null | undefined,
    projectId: string | null | undefined,
  ) {
    const accountIds: Array<string | null | undefined> = [accountId];
    for (const field of connector.configFields) {
      if (field.type === "account" && typeof config[field.key] === "string") accountIds.push(config[field.key] as string);
    }
    if (config.accountMap !== undefined) {
      const map = config.accountMap;
      if (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some((value) => typeof value !== "string")) {
        throw badRequest("accountMap must map source account names to account ids", "validation_failed");
      }
      accountIds.push(...(Object.values(map) as string[]));
    }
    const ids = accountIds.filter((id): id is string => Boolean(id));
    if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw badRequest("Account not found in this workspace", "invalid_reference");
    await assertInWorkspace(db, financialAccounts, ctx.workspaceId, ids, "Account");
    await assertInWorkspace(db, projects, ctx.workspaceId, [projectId], "Project");
  }

  private async runValidation(
    connector: AnyConnector,
    credentials: unknown,
    config: Record<string, unknown>,
    deps: Deps,
    row?: ConnectionRow,
    ctx?: WorkspaceContext,
  ): Promise<ValidateResult | undefined> {
    if (!connector.capabilities.testConnection || !connector.validate) return undefined;
    const workspace = row ? await loadWorkspace(row.workspaceId) : null;
    try {
      return await connector.validate({
        credentials,
        config,
        http: deps.http ?? defaultHttpClient,
        now: deps.now ?? new Date(),
        allowPrivateNetwork: privateNetworkAllowed(config, env.NODE_ENV),
        connection:
          row && workspace
            ? connectionInfo(row, workspace)
            : ctx
              ? {
                  id: "new",
                  workspaceId: ctx.workspaceId,
                  name: connector.displayName,
                  provider: connector.id,
                  accountId: null,
                  projectId: null,
                  createdAt: new Date(),
                  timezone: ctx.timezone,
                  baseCurrency: ctx.baseCurrency,
                }
              : undefined,
      });
    } catch (error) {
      return { ok: false, message: recordErrorMessage(error) };
    }
  }

  async create(ctx: WorkspaceContext, input: ConnectInput, deps: Deps = {}) {
    const connector = this.registry.require(input.provider);
    // Connections come with the workspace owner's plan (HTTP 402 otherwise).
    await this.entitlements.assertIntegrations(ctx.workspaceId);
    const credentials = parseWith(connector.credentialsSchema, input.credentials, "credentials");
    const config = parseWith(connector.configSchema, input.config, "config") as Record<string, unknown>;
    await this.checkReferences(ctx, connector, config, input.accountId, input.projectId);

    const validation = await this.runValidation(connector, credentials, config, deps, undefined, ctx);
    if (validation && !validation.ok) throw unprocessable(`Could not connect to ${connector.displayName}: ${validation.message}`, "connection_failed");

    let accountId = input.accountId ?? null;
    let createdAccount: AccountRow | null = null;
    if (!accountId && connector.requiresAccount) {
      const suggestion = connector.suggestAccount?.({ credentials, config, validation, baseCurrency: ctx.baseCurrency, today: todayFor(ctx) });
      if (!suggestion) throw badRequest(`Choose the account ${connector.displayName} records land in`, "account_required");
      createdAccount = await this.accounts.create(ctx, {
        name: suggestion.name,
        kind: suggestion.kind,
        currency: suggestion.currency,
        provider: suggestion.provider,
        openingBalance: suggestion.openingBalance ?? 0,
        openingDate: suggestion.openingDate ?? todayFor(ctx),
      });
      accountId = createdAccount.id;
    }

    const id = uuidv7();
    const endpoint = connector.capabilities.webhook ? newWebhookEndpoint() : null;
    let row: ConnectionRow;
    try {
      row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(integrationConnections)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            provider: connector.id,
            name: input.name,
            status: "connected",
            credentialsEncrypted: sealCredentials(id, credentials as Record<string, string>),
            config,
            accountId,
            projectId: input.projectId ?? null,
            syncFrequency: connector.capabilities.sync ? input.syncFrequency : "manual",
            trustLevel: input.trustLevel,
            webhookPublicId: endpoint?.publicId ?? null,
            webhookSecretEncrypted: endpoint ? sealWebhookSecret(id, endpoint.secret) : null,
            createdBy: ctx.userId,
          })
          .returning();
        const created = inserted as ConnectionRow;
        await this.audit.record(tx, ctx, {
          action: "integration.connected",
          entityType: "integration_connection",
          entityId: id,
          after: {
            provider: created.provider,
            name: created.name,
            accountId,
            projectId: created.projectId,
            syncFrequency: created.syncFrequency,
            trustLevel: created.trustLevel,
            config,
          },
        });
        return created;
      });
    } catch (error) {
      if (createdAccount) await this.accounts.remove(ctx, createdAccount.id).catch(() => undefined);
      throw error;
    }

    const initial = connector.capabilities.sync && connector.fetch ? await this.sync.start(ctx, id, "initial") : null;
    return {
      connection: await this.viewById(ctx, row.id),
      webhook: endpoint ? this.reveal(connector, endpoint.publicId, endpoint.secret) : null,
      initialSyncRunId: initial?.runId ?? null,
      createdAccount: createdAccount ? { id: createdAccount.id, name: createdAccount.name, currency: createdAccount.currency } : null,
      validation: validation ? { ok: validation.ok, message: validation.message } : null,
    };
  }

  private reveal(connector: AnyConnector, publicId: string, secret: string): WebhookSecretReveal {
    return {
      url: webhookUrl(publicId),
      secret,
      secretSource: connector.webhookSecretCredential ? "provider" : "generated",
      signatureHeader: connector.webhookDocs?.signatureHeader ?? null,
    };
  }

  async detail(ctx: WorkspaceContext, id: string) {
    const connection = await this.viewById(ctx, id);
    const [byStatus, receivableCount, runs, events] = await Promise.all([
      db
        .select({ status: transactions.status, value: count() })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.connectionId, id)))
        .groupBy(transactions.status),
      db.$count(receivables, and(eq(receivables.workspaceId, ctx.workspaceId), eq(receivables.connectionId, id))),
      db
        .select()
        .from(syncRuns)
        .where(and(eq(syncRuns.workspaceId, ctx.workspaceId), eq(syncRuns.connectionId, id)))
        .orderBy(desc(syncRuns.startedAt))
        .limit(20),
      this.webhooks.recent(ctx.workspaceId, id, 10),
    ]);
    const statusCounts = { posted: 0, draft: 0, pending: 0, void: 0 } as Record<"posted" | "draft" | "pending" | "void", number>;
    for (const row of byStatus) statusCounts[row.status] = row.value;
    const withBalances = runs.find((run) => (run.errorDetails ?? []).some((d) => (d as { kind?: string }).kind === "balance"));
    return {
      ...connection,
      stats: {
        transactions: { total: Object.values(statusCounts).reduce((a, b) => a + b, 0), ...statusCounts },
        receivables: receivableCount,
      },
      latestBalances: withBalances ? runDetail(withBalances).balances : [],
      recentRuns: runs.map((run) => runSummary({ ...run, connectionName: connection.name, provider: connection.provider })),
      recentWebhookEvents: events.map(webhookEventView),
    };
  }

  async update(ctx: WorkspaceContext, id: string, patch: z.output<typeof connectionPatch>, deps: Deps = {}) {
    const before = await getConnection(ctx, id);
    const connector = this.registry.require(before.provider);
    const rawConfig = patch.config ? mergeConfig(before.config ?? {}, patch.config) : (before.config ?? {});
    const config = parseWith(connector.configSchema, rawConfig, "config") as Record<string, unknown>;
    const credentialsChanged = patch.credentials !== undefined;
    let credentials: unknown;
    if (credentialsChanged) credentials = parseWith(connector.credentialsSchema, patch.credentials, "credentials");
    else {
      const stored = openCredentials(before);
      credentials = stored.readable ? connector.credentialsSchema.safeParse(stored.credentials).data : undefined;
    }
    await this.checkReferences(ctx, connector, config, patch.accountId, patch.projectId);
    if ((credentialsChanged || patch.config) && credentials !== undefined) {
      const validation = await this.runValidation(connector, credentials, config, deps, before);
      if (validation && !validation.ok) throw unprocessable(`Could not connect to ${connector.displayName}: ${validation.message}`, "connection_failed");
    }

    const reconnecting = before.status === "disconnected" && credentialsChanged;
    const endpoint = reconnecting && connector.capabilities.webhook ? newWebhookEndpoint() : null;
    const changes: Partial<typeof integrationConnections.$inferInsert> = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config } : {}),
      ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.syncFrequency !== undefined ? { syncFrequency: connector.capabilities.sync ? patch.syncFrequency : "manual" } : {}),
      ...(patch.trustLevel !== undefined ? { trustLevel: patch.trustLevel } : {}),
      ...(credentialsChanged
        ? { credentialsEncrypted: sealCredentials(id, credentials as Record<string, string>), consecutiveFailures: 0, errorMessage: null }
        : {}),
      ...(reconnecting ? { status: "connected" as const } : {}),
      ...(endpoint ? { webhookPublicId: endpoint.publicId, webhookSecretEncrypted: sealWebhookSecret(id, endpoint.secret) } : {}),
    };
    if (Object.keys(changes).length) {
      await db.transaction(async (tx) => {
        await tx
          .update(integrationConnections)
          .set(changes)
          .where(and(eq(integrationConnections.id, id), eq(integrationConnections.workspaceId, ctx.workspaceId)));
        await this.audit.record(tx, ctx, {
          action: reconnecting ? "integration.reconnected" : "integration.updated",
          entityType: "integration_connection",
          entityId: id,
          before: {
            name: before.name,
            config: before.config,
            accountId: before.accountId,
            projectId: before.projectId,
            syncFrequency: before.syncFrequency,
            trustLevel: before.trustLevel,
            status: before.status,
          },
          after: { ...patch, credentials: credentialsChanged ? "[replaced]" : undefined, config: patch.config ? config : undefined },
        });
      });
    }
    return { connection: await this.viewById(ctx, id), webhook: endpoint ? this.reveal(connector, endpoint.publicId, endpoint.secret) : null };
  }

  async test(ctx: WorkspaceContext, id: string, deps: Deps = {}) {
    const row = await getConnection(ctx, id);
    const connector = this.registry.require(row.provider);
    const checkedAt = new Date();
    if (row.status === "disconnected")
      return { ok: false, message: "This integration is disconnected. Reconnect it with new credentials.", details: null, checkedAt };
    if (!connector.capabilities.testConnection || !connector.validate) {
      return {
        ok: true,
        message: `${connector.displayName} has nothing to test: it receives signed webhooks. Send a test event instead.`,
        details: null,
        checkedAt,
      };
    }
    const stored = openCredentials(row);
    if (!stored.readable) return { ok: false, message: "The stored credentials cannot be decrypted. Reconnect this integration.", details: null, checkedAt };
    const credentials = connector.credentialsSchema.safeParse(stored.credentials);
    if (!credentials.success)
      return { ok: false, message: `The saved credentials are incomplete: ${recordErrorMessage(credentials.error)}`, details: null, checkedAt };
    const config = connector.configSchema.safeParse(row.config ?? {});
    if (!config.success) return { ok: false, message: `The configuration is invalid: ${recordErrorMessage(config.error)}`, details: null, checkedAt };
    const result = await this.runValidation(connector, credentials.data, config.data as Record<string, unknown>, deps, row);
    return { ok: result?.ok ?? true, message: result?.message ?? "OK", details: result?.ok ? (result.details ?? null) : null, checkedAt };
  }

  /** Stops syncing and forgets the credentials and webhook endpoint; history stays. */
  async disconnect(ctx: WorkspaceContext, id: string) {
    const before = await getConnection(ctx, id);
    if (before.status !== "disconnected") {
      await db.transaction(async (tx) => {
        await tx
          .update(integrationConnections)
          .set({
            status: "disconnected",
            credentialsEncrypted: null,
            webhookPublicId: null,
            webhookSecretEncrypted: null,
            errorMessage: null,
            consecutiveFailures: 0,
          })
          .where(eq(integrationConnections.id, id));
        await this.inbox.resolveForEntity(ctx.workspaceId, id, ["integration_error"], ctx.userId, tx);
        await this.audit.record(tx, ctx, {
          action: "integration.disconnected",
          entityType: "integration_connection",
          entityId: id,
          before: { status: before.status, name: before.name },
        });
      });
    }
    return this.viewById(ctx, id);
  }

  /** Deletes a connection that never imported anything; otherwise disconnects it so the history keeps its source. */
  async remove(ctx: WorkspaceContext, id: string) {
    const before = await getConnection(ctx, id);
    const imported = await db.$count(transactions, and(eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.connectionId, id)));
    if (imported > 0) {
      const connection = await this.disconnect(ctx, id);
      return { deleted: false, disconnected: true, reason: `${imported} imported transactions keep their link to this integration`, connection };
    }
    await db.transaction(async (tx) => {
      await tx.delete(integrationConnections).where(and(eq(integrationConnections.id, id), eq(integrationConnections.workspaceId, ctx.workspaceId)));
      await this.inbox.resolveForEntity(ctx.workspaceId, id, ["integration_error"], ctx.userId, tx);
      await this.audit.record(tx, ctx, {
        action: "integration.deleted",
        entityType: "integration_connection",
        entityId: id,
        before: { provider: before.provider, name: before.name },
      });
    });
    return { deleted: true, disconnected: false, reason: null, connection: null };
  }

  /** New URL and secret; the old URL stops working immediately. */
  async rotateWebhook(ctx: WorkspaceContext, id: string) {
    const before = await getConnection(ctx, id);
    const connector = this.registry.require(before.provider);
    if (!connector.capabilities.webhook) throw badRequest(`${connector.displayName} does not use webhooks`, "webhook_unsupported");
    if (before.status === "disconnected") throw conflict("Reconnect this integration first", "disconnected");
    const endpoint = newWebhookEndpoint();
    await db.transaction(async (tx) => {
      await tx
        .update(integrationConnections)
        .set({ webhookPublicId: endpoint.publicId, webhookSecretEncrypted: sealWebhookSecret(id, endpoint.secret) })
        .where(eq(integrationConnections.id, id));
      await this.audit.record(tx, ctx, { action: "integration.webhook_rotated", entityType: "integration_connection", entityId: id });
    });
    return this.reveal(connector, endpoint.publicId, endpoint.secret);
  }

  /**
   * Signs a realistic event with the connection's secret and delivers it to
   * its own webhook endpoint (the same code path as a real delivery), then
   * processes it straight away so the result is visible.
   */
  async sendTestWebhook(ctx: WorkspaceContext, id: string, eventType?: string) {
    const row = await getConnection(ctx, id);
    const connector = this.registry.require(row.provider);
    if (!connector.buildTestEvent) throw badRequest(`${connector.displayName} cannot send test events`, "test_event_unsupported");
    if (row.status === "disconnected" || !row.webhookPublicId) throw conflict("Reconnect this integration first", "disconnected");
    const secret = this.webhooks.signingSecret(row, connector);
    if (!secret) throw conflict("This connection has no webhook secret; rotate the webhook to create one", "no_secret");
    const config = parseWith(connector.configSchema, row.config ?? {}, "config");
    const workspace = await loadWorkspace(row.workspaceId);
    const now = new Date();
    const event = connector.buildTestEvent({ connection: { ...connectionInfo(row, workspace), config }, secret, now, eventType });
    const receipt = await this.webhooks.receive(row.webhookPublicId, event.headers, event.rawBody, now);
    const processed = receipt.webhookEventId ? await this.webhooks.process(receipt.webhookEventId) : null;
    return {
      eventType: event.eventType,
      delivery: receipt,
      processing: processed
        ? { status: processed.status, run: processed.run ? runDetail({ ...processed.run, connectionName: row.name, provider: row.provider }) : null }
        : null,
    };
  }

  async webhookEvents(ctx: WorkspaceContext, id: string, limit = 50) {
    await getConnection(ctx, id);
    return (await this.webhooks.recent(ctx.workspaceId, id, limit)).map(webhookEventView);
  }

  /** Transactions this connection imported, newest first. */
  async records(ctx: WorkspaceContext, id: string, query: z.output<typeof connectionRecordsQuery>) {
    await getConnection(ctx, id);
    const where: SQL[] = [eq(transactions.workspaceId, ctx.workspaceId), eq(transactions.connectionId, id)];
    if (query.status?.length) where.push(inArray(transactions.status, query.status));
    if (query.type?.length) where.push(inArray(transactions.type, query.type));
    if (query.from) where.push(gte(transactions.date, query.from));
    if (query.to) where.push(lte(transactions.date, query.to));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      where.push(
        or(
          ilike(transactions.merchant, needle),
          ilike(transactions.description, needle),
          ilike(transactions.reference, needle),
          ilike(transactions.externalId, needle),
        ) as SQL,
      );
    }
    const toAccount = alias(financialAccounts, "to_account");
    const condition = and(...where);
    const [rows, [total]] = await Promise.all([
      db
        .select({
          transaction: transactions,
          accountName: financialAccounts.name,
          accountCurrency: financialAccounts.currency,
          toAccountName: toAccount.name,
          categoryName: categories.name,
          categoryIcon: categories.icon,
          categoryColor: categories.color,
          projectName: projects.name,
          projectColor: projects.color,
          counterpartyName: counterparties.name,
        })
        .from(transactions)
        .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
        .leftJoin(toAccount, eq(toAccount.id, transactions.toAccountId))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .leftJoin(projects, eq(projects.id, transactions.projectId))
        .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
        .where(condition)
        .orderBy(desc(transactions.date), desc(transactions.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(transactions).where(condition),
    ]);
    return {
      items: rows.map((row) => ({
        ...row.transaction,
        accountName: row.accountName,
        accountCurrency: row.accountCurrency,
        toAccountName: row.toAccountName,
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        categoryColor: row.categoryColor,
        projectName: row.projectName,
        projectColor: row.projectColor,
        counterpartyName: row.counterpartyName,
      })),
      total: total?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

export type ConnectionView = ReturnType<ConnectionsService["view"]>;
