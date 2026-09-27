import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import type { SessionUser } from "../../src/common/context.js";
import { db } from "../../src/db/index.js";
import { billingSubscriptions, platformAuditLogs, users, workspaceMembers } from "../../src/db/schema/index.js";
import { AccountService } from "../../src/modules/account/account.service.js";
import { forgetBillingConfig } from "../../src/modules/billing/billing-config.js";
import { BILLING_FETCH } from "../../src/modules/billing/http.js";
import { enableBilling, FakeFetch, jsonResponse } from "../fixtures/billing.js";
import { createUser, resetDatabase, shutdown, type TestUser } from "./harness.js";

const fetcher = new FakeFetch();
let account: AccountService;
let close: () => Promise<void>;
let admin: TestUser;
let adminUser: SessionUser;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BILLING_FETCH)
    .useValue(fetcher.fn)
    .compile();
  await moduleRef.init();
  account = moduleRef.get(AccountService, { strict: false });
  close = () => moduleRef.close();
});
afterAll(async () => {
  await close?.();
  await shutdown();
});

beforeEach(async () => {
  await resetDatabase();
  forgetBillingConfig();
  fetcher.reset();
  admin = await createUser("Platform Admin");
  adminUser = { id: admin.userId, name: "Platform Admin", email: admin.email, role: "admin" };
});

async function payingCustomer(name: string) {
  const user = await createUser(name);
  await db.insert(billingSubscriptions).values({
    userId: user.userId,
    plan: "pro",
    status: "active",
    provider: "stripe",
    providerCustomerId: "cus_123",
    providerSubscriptionId: `sub_${user.userId.slice(0, 8)}`,
    interval: "month",
    currentPeriodStart: new Date(Date.now() - 5 * 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 25 * 86_400_000),
  });
  return user;
}

describe("deleting users", () => {
  it("lets an admin delete a user: card subscription stopped, their own workspaces gone, audited", async () => {
    await enableBilling({ stripe: { secretKey: "sk_test_0123456789abcdef", webhookSecret: "whsec_test" } });
    const customer = await payingCustomer("Leaving Customer");
    fetcher.handler = (call) =>
      call.method === "DELETE" && call.url.includes("/v1/subscriptions/") ? jsonResponse({ id: "sub", status: "canceled" }) : jsonResponse({}, 404);

    const result = await account.adminDelete(customer.userId, adminUser);

    expect(result).toMatchObject({ deleted: true, workspacesDeleted: 2 });
    expect(fetcher.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE https://api.stripe.com/v1/subscriptions/sub_${customer.userId.slice(0, 8)}`]);
    expect(await db.select().from(users).where(eq(users.id, customer.userId))).toHaveLength(0);
    const [entry] = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, "user.deleted_by_admin"));
    expect(entry).toMatchObject({ actorId: admin.userId, targetId: customer.userId });
  });

  it("keeps the account when Stripe can't cancel the subscription", async () => {
    await enableBilling({ stripe: { secretKey: "sk_test_0123456789abcdef", webhookSecret: "whsec_test" } });
    const customer = await payingCustomer("Stuck Customer");
    fetcher.handler = () => jsonResponse({ error: { message: "Stripe is down" } }, 500);

    await expect(account.deleteAccount({ id: customer.userId, name: "Stuck", email: customer.email, role: "user" }, customer.email)).rejects.toMatchObject({
      code: "subscription_cancel_failed",
    });
    expect(await db.select().from(users).where(eq(users.id, customer.userId))).toHaveLength(1);
  });

  it("refuses while the user owns a workspace other people use, and never deletes the admin themselves", async () => {
    const owner = await createUser("Shared Owner");
    const colleague = await createUser("Colleague");
    await db.insert(workspaceMembers).values({ workspaceId: owner.business.workspaceId, userId: colleague.userId, role: "member" });

    await expect(account.adminDelete(owner.userId, adminUser)).rejects.toMatchObject({ code: "workspaces_shared" });
    await expect(account.adminDelete(admin.userId, adminUser)).rejects.toMatchObject({ code: "self_delete" });
    expect(await db.select().from(users).where(eq(users.id, owner.userId))).toHaveLength(1);
  });

  it("deletes a free user without calling any payment provider", async () => {
    const user = await createUser("Free User");
    await account.adminDelete(user.userId, adminUser);
    expect(fetcher.calls).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.id, user.userId))).toHaveLength(0);
  });
});
