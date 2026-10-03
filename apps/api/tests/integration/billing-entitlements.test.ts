import { randomBytes } from "node:crypto";
import { connectInput, UNLIMITED_LIMITS } from "@financeos/core";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import {
  apiKeys,
  billingPayments,
  billingSubscriptions,
  creditTransactions,
  files,
  platformAuditLogs,
  users,
  workspaceInvitations,
} from "../../src/db/schema/index.js";
import { BillingJobs } from "../../src/modules/billing/billing.jobs.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { BillingAdminService } from "../../src/modules/billing/billing-admin.service.js";
import { forgetBillingConfig } from "../../src/modules/billing/billing-config.js";
import { CreditsService } from "../../src/modules/billing/credits.service.js";
import { EntitlementsService } from "../../src/modules/billing/entitlements.service.js";
import { ConnectionsService } from "../../src/modules/integrations/connections.service.js";
import { ApiKeyGuard } from "../../src/modules/integrations/public-api/api-key.guard.js";
import { ApiKeysService } from "../../src/modules/integrations/public-api/api-keys.service.js";
import { StorageService } from "../../src/modules/storage/storage.service.js";
import { enableBilling } from "../fixtures/billing.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

const MB = 1024 ** 2;
const DAY = 86_400_000;

let entitlements: EntitlementsService;
let credits: CreditsService;
let billing: BillingService;
let admin: BillingAdminService;
let storage: StorageService;
let keys: ApiKeysService;
let guard: ApiKeyGuard;
let connections: ConnectionsService;
let jobs: BillingJobs;
let user: TestUser;
let sessionUser: SessionUser;
const actor = { id: "", email: "admin@example.test" };

beforeAll(async () => {
  entitlements = await service(EntitlementsService);
  credits = await service(CreditsService);
  billing = await service(BillingService);
  admin = await service(BillingAdminService);
  storage = await service(StorageService);
  keys = await service(ApiKeysService);
  guard = await service(ApiKeyGuard);
  connections = await service(ConnectionsService);
  jobs = await service(BillingJobs);
});

afterAll(shutdown);

beforeEach(async () => {
  await resetDatabase();
  forgetBillingConfig();
  user = await createUser("Farhana Islam");
  sessionUser = { id: user.userId, name: "Farhana Islam", email: user.email, role: "user" };
  const adminUser = await createUser("Platform Admin");
  actor.id = adminUser.userId;
});

const png = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: randomBytes(1)[0] ?? 0, g: 10, b: 10 } } })
    .png()
    .toBuffer();

async function addFile(workspaceId: string, size: number) {
  await db.insert(files).values({
    workspaceId,
    storageKey: `test/${randomBytes(8).toString("hex")}`,
    filename: "statement.pdf",
    contentType: "application/pdf",
    size,
    sha256: randomBytes(32).toString("hex"),
  });
}

const apiRequest = (key: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ method: "GET", headers: { authorization: `Bearer ${key}` }, ip: "203.0.113.1" }) }) }) as never;

describe("billing off (self-hosted)", () => {
  it("leaves everyone unlimited and enforces nothing", async () => {
    expect(await entitlements.billingEnabled()).toBe(false);
    expect(await entitlements.forUser(user.userId)).toEqual({ plan: "unlimited", status: "active", limits: UNLIMITED_LIMITS, billingEnabled: false });
    expect(await entitlements.forWorkspace(user.business.workspaceId)).toMatchObject({ plan: "unlimited", billingEnabled: false });
    await addFile(user.personal.workspaceId, 900 * MB);
    await expect(entitlements.assertCanCreateWorkspace(user.userId)).resolves.toBeUndefined();
    await expect(entitlements.assertCanAddMember(user.business.workspaceId, 50)).resolves.toBeUndefined();
    await expect(entitlements.assertStorage(user.business.workspaceId, 900 * MB)).resolves.toBeUndefined();
    await expect(entitlements.assertApiAccess(user.business.workspaceId)).resolves.toBeUndefined();
    await expect(entitlements.assertIntegrations(user.business.workspaceId)).resolves.toBeUndefined();
    const created = await keys.create(user.business, { name: "CI", scopes: ["read"] });
    expect(await guard.canActivate(apiRequest(created.key))).toBe(true);

    const overview = await billing.overview(sessionUser);
    expect(overview).toMatchObject({ enabled: false, plan: "unlimited", usage: { workspacesOwned: 2, credits: null } });
    // Looking never creates plan rows on an unbilled installation.
    expect(await db.$count(billingSubscriptions)).toBe(0);
  });
});

describe("plan limits", () => {
  it("Free: workspaces, people (open invitations included), storage, API and connections answer 402 with the limit", async () => {
    const existingKey = (await keys.create(user.business, { name: "Before billing", scopes: ["read"] })).key;
    await enableBilling({ trial: { enabled: false } });
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free", status: "active", billingEnabled: true });

    // Workspaces: the sign-up already made two, Free's limit.
    await expect(entitlements.assertCanCreateWorkspace(user.userId)).rejects.toMatchObject({
      status: 402,
      code: "plan_limit",
      details: { limit: "workspaces", plan: "free", used: 2, allowed: 2 },
    });

    // People: the owner plus one more fits; an open invitation takes the seat.
    await expect(entitlements.assertCanAddMember(user.business.workspaceId)).resolves.toBeUndefined();
    await db.insert(workspaceInvitations).values({
      workspaceId: user.business.workspaceId,
      email: "old@example.test",
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() - DAY),
    });
    await expect(entitlements.assertCanAddMember(user.business.workspaceId)).resolves.toBeUndefined();
    await db.insert(workspaceInvitations).values({
      workspaceId: user.business.workspaceId,
      email: "accountant@example.test",
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 7 * DAY),
    });
    await expect(entitlements.assertCanAddMember(user.business.workspaceId)).rejects.toMatchObject({
      status: 402,
      details: { limit: "membersPerWorkspace", plan: "free", used: 2, allowed: 2 },
    });
    await expect(entitlements.assertCanAddMember(user.personal.workspaceId, 2)).rejects.toMatchObject({ details: { used: 1, allowed: 2 } });

    // Storage counts files across every workspace the user owns.
    await addFile(user.personal.workspaceId, 250 * MB - 1_000);
    await expect(entitlements.assertStorage(user.business.workspaceId, 500)).resolves.toBeUndefined();
    await expect(entitlements.assertStorage(user.business.workspaceId, 5_000)).rejects.toMatchObject({
      status: 402,
      details: { limit: "storageBytes", plan: "free", used: 250 * MB - 1_000, allowed: 250 * MB },
    });
    const image = await png();
    await expect(
      storage.save(user.business, { buffer: Buffer.concat([image, Buffer.alloc(2_000)]), filename: "r.png", contentType: "image/png" }, "receipt"),
    ).rejects.toMatchObject({
      status: 402,
      code: "plan_limit",
    });

    // API keys and MCP.
    await expect(keys.create(user.business, { name: "Agent", scopes: ["read"] })).rejects.toMatchObject({
      status: 402,
      details: { limit: "apiAccess", plan: "free" },
    });
    await expect(guard.canActivate(apiRequest(existingKey))).rejects.toMatchObject({ status: 402, code: "plan_limit" });

    // Bank, wallet and app connections.
    await expect(
      connections.create(user.business, connectInput.parse({ provider: "demo_payments", name: "Demo", trustLevel: "trusted", syncFrequency: "manual" })),
    ).rejects.toMatchObject({ status: 402, details: { limit: "integrations", plan: "free" } });
  });

  it("a plan set by an admin lifts the limits, and the change is audited", async () => {
    await enableBilling({ trial: { enabled: false } });
    const result = await admin.setPlan(user.userId, { plan: "pro", status: "active", note: "Early customer" }, actor);
    expect(result).toMatchObject({ plan: "pro", status: "active", currentPeriodEnd: null });
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "pro", status: "active" });
    await expect(entitlements.assertCanCreateWorkspace(user.userId)).resolves.toBeUndefined();
    await expect(entitlements.assertApiAccess(user.business.workspaceId)).resolves.toBeUndefined();
    const created = await keys.create(user.business, { name: "Agent", scopes: ["read"] });
    expect(await guard.canActivate(apiRequest(created.key))).toBe(true);

    const [audit] = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "billing.plan_set"));
    expect(audit).toMatchObject({ actorId: actor.id, targetType: "user", targetId: user.userId });
    expect(audit?.details).toMatchObject({ before: null, after: { plan: "pro", status: "active" }, note: "Early customer" });

    // A dated plan ends: back to Free after its period.
    await admin.setPlan(user.userId, { plan: "business", status: "active", periodEnd: new Date(Date.now() - 1_000).toISOString() }, actor);
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free", status: "expired" });
    expect(await db.$count(apiKeys)).toBe(1);
  });
});

describe("trials and grace periods", () => {
  it("a new user gets a trial row on first look; it falls back to Free when it ends", async () => {
    await enableBilling();
    const trial = await entitlements.forUser(user.userId);
    expect(trial).toMatchObject({ plan: "pro", status: "trialing" });
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, user.userId));
    const [account] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(row).toMatchObject({ plan: "pro", status: "trialing" });
    expect(row?.trialEndsAt?.getTime()).toBe((account?.createdAt.getTime() ?? 0) + 14 * DAY);
    const overview = await billing.overview(sessionUser);
    expect(overview.trial).toMatchObject({ active: true, daysLeft: 14 });
    expect(overview.usage.credits).toMatchObject({ allowance: 1_000, remainingAllowance: 1_000, balance: 0 });

    await db
      .update(billingSubscriptions)
      .set({ trialEndsAt: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() - DAY) })
      .where(eq(billingSubscriptions.userId, user.userId));
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free", status: "expired" });

    // Someone who signed up long ago has no trial and gets no row.
    const old = await createUser("Old Timer");
    await db
      .update(users)
      .set({ createdAt: new Date(Date.now() - 30 * DAY) })
      .where(eq(users.id, old.userId));
    expect(await entitlements.forUser(old.userId)).toMatchObject({ plan: "free", status: "active" });
    expect(await db.$count(billingSubscriptions, eq(billingSubscriptions.userId, old.userId))).toBe(0);
  });

  it("past due keeps the plan for 7 days; a canceled plan runs to the end of its period", async () => {
    await enableBilling({ trial: { enabled: false } });
    await admin.setPlan(user.userId, { plan: "business", status: "active", periodEnd: new Date(Date.now() + 20 * DAY).toISOString() }, actor);
    const pastDue = (days: number) =>
      db
        .update(billingSubscriptions)
        .set({ status: "past_due", metadata: { pastDueAt: new Date(Date.now() - days * DAY).toISOString() } })
        .where(eq(billingSubscriptions.userId, user.userId));

    await pastDue(3);
    const grace = await entitlements.resolve(user.userId);
    expect(grace).toMatchObject({ plan: "business", status: "past_due" });
    expect(Math.round(((grace.graceEndsAt?.getTime() ?? 0) - Date.now()) / DAY)).toBe(4);
    await pastDue(8);
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free", status: "expired" });

    await db
      .update(billingSubscriptions)
      .set({ status: "canceled", currentPeriodEnd: new Date(Date.now() + 5 * DAY) })
      .where(eq(billingSubscriptions.userId, user.userId));
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "business", status: "canceled" });
    await db
      .update(billingSubscriptions)
      .set({ currentPeriodEnd: new Date(Date.now() - DAY) })
      .where(eq(billingSubscriptions.userId, user.userId));
    expect(await entitlements.forUser(user.userId)).toMatchObject({ plan: "free", status: "canceled" });
  });
});

describe("Admin → Billing", () => {
  it("adds credits (with or without the payment behind them), audited, and reports them", async () => {
    await enableBilling({ trial: { enabled: false } });
    const gift = await admin.addCredits(user.userId, { credits: 300, note: "Launch gift" }, actor);
    expect(gift.credits).toMatchObject({ balance: 300, allowance: 50 });

    const bought = await admin.addCredits(
      user.userId,
      { credits: 500, note: "Paid by bKash", payment: { amount: 60_000, currency: "bdt", reference: "BK8X2Q" } },
      actor,
    );
    expect(bought.credits.balance).toBe(800);
    const [payment] = await db.select().from(billingPayments).where(eq(billingPayments.userId, user.userId));
    expect(payment).toMatchObject({
      provider: "manual",
      providerRef: "BK8X2Q",
      purpose: "credits",
      credits: 500,
      amount: 60_000,
      currency: "BDT",
      status: "paid",
    });
    const [grant] = await db
      .select()
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, user.userId), eq(creditTransactions.kind, "purchase")));
    expect(grant).toMatchObject({ credits: 500, source: "balance", paymentId: payment?.id, createdBy: actor.id });
    await expect(
      admin.addCredits(user.userId, { credits: 500, note: "Again", payment: { amount: 60_000, currency: "BDT", reference: "BK8X2Q" } }, actor),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_reference" });
    expect((await credits.summary(user.userId)).balance).toBe(800);

    expect(await db.$count(platformAuditLogs, eq(platformAuditLogs.action, "billing.credits_added"))).toBe(2);
    const summary = await admin.summary();
    expect(summary.revenue30d).toEqual([{ currency: "BDT", amount: 60_000, payments: 1 }]);
    expect(summary.credits30d).toMatchObject({ sold: 500, granted: 300 });
    const listed = await admin.users({ q: user.email });
    expect(listed).toEqual([expect.objectContaining({ id: user.userId, plan: "free", workspacesOwned: 2, credits: { remainingAllowance: 50, balance: 800 } })]);
    const payments = await admin.paymentsList({ userId: user.userId });
    expect(payments[0]).toMatchObject({ userEmail: user.email, amount: 60_000 });
  });

  it("saves the configuration with secrets encrypted and masked, audited", async () => {
    const view = await admin.view();
    expect(view.enabled).toBe(false);
    const input = {
      enabled: true,
      creditsPerUsd: 120,
      trial: { enabled: true, days: 7, plan: "business" as const },
      plans: {
        free: { limits: view.plans.free.limits, prices: [] },
        pro: { limits: { ...view.plans.pro.limits, workspaces: 6 }, prices: [{ interval: "month" as const, currency: "usd", amount: 700 }] },
        business: { limits: view.plans.business.limits, prices: view.plans.business.prices },
      },
      creditPacks: view.creditPacks,
      providers: {
        stripe: { enabled: true, secretKey: "sk_test_abcdefghijklmnop1234", webhookSecret: "whsec_abcdefghijklmnop5678" },
        sslcommerz: { enabled: true, storeId: "store123", storePassword: "store123@ssl", sandbox: true },
        manual: { enabled: true, instructions: "Send ৳600 to bKash 01700000000 with your email as reference" },
      },
    };
    const saved = await admin.update(input, actor);
    expect(saved).toMatchObject({ enabled: true, creditsPerUsd: 120, trial: { days: 7, plan: "business" } });
    expect(saved.plans.pro).toMatchObject({ limits: { workspaces: 6 }, prices: [{ interval: "month", currency: "USD", amount: 700 }] });
    expect(saved.providers.stripe).toMatchObject({
      enabled: true,
      ready: true,
      secretKey: { set: true, masked: "••••1234" },
      webhookUrl: expect.stringContaining("/api/billing/webhooks/stripe"),
    });
    expect(saved.providers.sslcommerz.storePassword).toMatchObject({ set: true });
    expect(JSON.stringify(saved)).not.toContain("sk_test_abcdefghijklmnop1234");

    // Omitting a secret keeps it; an empty string removes it.
    const again = await admin.update(
      {
        ...input,
        providers: { ...input.providers, stripe: { enabled: true, webhookSecret: "" }, sslcommerz: { enabled: true, storeId: "store123", sandbox: false } },
      },
      actor,
    );
    expect(again.providers.stripe.secretKey.set).toBe(true);
    expect(again.providers.stripe.webhookSecret.set).toBe(false);
    expect(again.providers.sslcommerz).toMatchObject({ sandbox: false, storePassword: { set: true } });

    const plans = await billing.plans();
    expect(plans).toMatchObject({ enabled: true, providers: { stripe: true, sslcommerz: true, manual: true }, trial: { days: 7 } });
    expect(JSON.stringify(plans)).not.toContain("store123@ssl");
    const audits = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "billing.config_updated"));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("sk_test_");
  });
});

describe("daily reminders", () => {
  it("emails once about a trial ending, a prepaid plan ending and credits running low", async () => {
    expect(await jobs.runDaily()).toEqual({ skipped: true });
    await enableBilling({ limits: { pro: { aiCreditsPerMonth: 100 } } });
    const trial = await entitlements.resolve(user.userId);
    expect(trial.status).toBe("trialing");
    await db
      .update(billingSubscriptions)
      .set({ trialEndsAt: new Date(Date.now() + 2 * DAY) })
      .where(eq(billingSubscriptions.userId, user.userId));
    await db
      .insert(creditTransactions)
      .values({ userId: user.userId, workspaceId: user.business.workspaceId, kind: "usage", source: "allowance", credits: -95 });

    const prepaid = await createUser("Prepaid Customer");
    await db
      .update(users)
      .set({ createdAt: new Date(Date.now() - 60 * DAY) })
      .where(eq(users.id, prepaid.userId));
    await admin.setPlan(prepaid.userId, { plan: "pro", status: "active", periodEnd: new Date(Date.now() + 4 * DAY).toISOString() }, actor);

    expect(await jobs.runDaily()).toEqual({ trials: 1, prepaid: 1, lowCredits: 1 });
    expect(await jobs.runDaily()).toEqual({ trials: 0, prepaid: 0, lowCredits: 0 });
    const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.userId, user.userId));
    expect(row?.metadata).toMatchObject({ trialEndingNotified: true, lowCreditsNotifiedFor: expect.any(String) });
  });
});
