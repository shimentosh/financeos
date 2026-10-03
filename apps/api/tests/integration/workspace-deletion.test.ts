import { addMonths, today } from "@financeos/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { auditLogs, files, platformAuditLogs, transactions as transactionsTable, workspaceMembers, workspaces } from "../../src/db/schema/index.js";
import { CopilotService } from "../../src/modules/copilot/copilot.service.js";
import { ApiKeysService } from "../../src/modules/integrations/public-api/api-keys.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { BudgetsService } from "../../src/modules/planning/budgets.service.js";
import { GoalsService } from "../../src/modules/planning/goals.service.js";
import { SubscriptionsService } from "../../src/modules/planning/subscriptions.service.js";
import { StorageService } from "../../src/modules/storage/storage.service.js";
import { LiabilitiesService } from "../../src/modules/wealth/liabilities.service.js";
import { ReceivablesService } from "../../src/modules/wealth/receivables.service.js";
import { WorkspaceDeletionService } from "../../src/modules/workspaces/workspace-deletion.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider } from "../fixtures/ai/fake-provider.js";
import { createUser, resetDatabase, type TestUser } from "./harness.js";

const provider = new FakeProvider();
let app: Awaited<ReturnType<typeof aiApp>>;
let user: TestUser;
const day = today("Asia/Dhaka");

beforeAll(async () => {
  app = await aiApp(provider);
});
afterAll(() => closeAiApp(app));

beforeEach(async () => {
  await resetDatabase();
  provider.reset();
  provider.available = false;
  user = await createUser("Deletion User");
});

describe("workspace deletion", () => {
  it("removes every record and file of the workspace and nothing else", async () => {
    const ctx = user.business;
    const accounts = app.service(AccountsService);
    const transactions = app.service(TransactionsService);
    const storage = app.service(StorageService);
    const bank = await accounts.create(ctx, { name: "City Bank", kind: "bank", currency: "BDT", openingBalance: 10_000_000, openingDate: addMonths(day, -2) });
    const file = await storage.save(ctx, { buffer: Buffer.from("%PDF-1.4 deletion"), filename: "bill.pdf", contentType: "application/pdf" }, "receipt");
    await transactions.create(ctx, {
      type: "expense",
      accountId: bank.id,
      amount: 50_000,
      currency: "BDT",
      date: day,
      merchant: "Office",
      attachmentFileIds: [file.id],
    });
    await app.service(SubscriptionsService).create(ctx, {
      provider: "Figma",
      amount: 150_000,
      currency: "BDT",
      billingCycle: "monthly",
      startDate: addMonths(day, -1),
      nextRenewalDate: addMonths(day, 1),
      accountId: bank.id,
      recordPurchase: { accountId: bank.id, date: addMonths(day, -1) },
    });
    const goal = await app.service(GoalsService).create(ctx, { kind: "savings", name: "Runway", targetAmount: 50_000_000, currency: "BDT" });
    await app.service(GoalsService).addContribution(ctx, goal.id, { amount: 1_000_000, date: day });
    const loan = await app.service(LiabilitiesService).create(ctx, {
      kind: "loan",
      name: "Bank loan",
      counterpartyName: "City Bank",
      principal: 5_000_000,
      currency: "BDT",
      openingOutstanding: 5_000_000,
      receivedIntoAccountId: bank.id,
    });
    await app.service(LiabilitiesService).pay(ctx, loan.id, { amount: 500_000, interest: 50_000, accountId: bank.id, date: day });
    await app
      .service(ReceivablesService)
      .create(ctx, { kind: "invoice", counterpartyName: "Client Co", title: "Invoice 7", amount: 2_000_000, currency: "BDT", issueDate: day });
    await app.service(BudgetsService).create(ctx, { name: "Everything", amount: 1_000_000, startDate: day });
    await app.service(CopilotService).ask(ctx, { message: "How much did we spend this month?" });
    await app.service(ApiKeysService).create(ctx, { name: "ci", scopes: ["read"] });

    const personalBefore = await db.select().from(transactionsTable).where(eq(transactionsTable.workspaceId, user.personal.workspaceId));
    const result = await app.service(WorkspaceDeletionService).delete(ctx.workspaceId, { userId: user.userId, reason: "workspace_deleted" });

    expect(result).toMatchObject({ deleted: true, files: 1, filesRemoved: 1 });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId))).toHaveLength(0);
    expect(await db.select().from(transactionsTable).where(eq(transactionsTable.workspaceId, ctx.workspaceId))).toHaveLength(0);
    expect(await db.select().from(files).where(eq(files.workspaceId, ctx.workspaceId))).toHaveLength(0);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ctx.workspaceId))).toHaveLength(0);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, ctx.workspaceId))).toHaveLength(0);
    // The stored bytes are gone too.
    await expect(storage.read(ctx, file.id)).rejects.toThrow();
    // Recorded outside the workspace.
    const [entry] = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.targetId, ctx.workspaceId));
    expect(entry).toMatchObject({ action: "workspace.deleted", actorId: user.userId });
    expect(entry?.details).toMatchObject({ files: 1 });
    // The user's other workspace is untouched.
    expect(await db.select().from(workspaces).where(eq(workspaces.id, user.personal.workspaceId))).toHaveLength(1);
    expect(await db.select().from(transactionsTable).where(eq(transactionsTable.workspaceId, user.personal.workspaceId))).toHaveLength(personalBefore.length);
  });
});
