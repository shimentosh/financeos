import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/index.js";
import { platformAuditLogs, supportRequests } from "../../src/db/schema/index.js";
import { SupportController } from "../../src/modules/support/support.controller.js";
import { SupportService } from "../../src/modules/support/support.service.js";
import { aiApp, closeAiApp } from "../fixtures/ai/app.js";
import { FakeProvider } from "../fixtures/ai/fake-provider.js";
import { createUser, resetDatabase } from "./harness.js";

let app: Awaited<ReturnType<typeof aiApp>>;
let support: SupportService;

beforeAll(async () => {
  app = await aiApp(new FakeProvider());
  support = app.service(SupportService);
});
afterAll(() => closeAiApp(app));
beforeEach(() => resetDatabase());

const request = { headers: {}, ip: "203.0.113.9" } as never;

describe("support requests", () => {
  it("stores a message from the contact page and lets an admin close it", async () => {
    const controller = app.service(SupportController);
    const sent = await controller.create(
      { email: "Visitor@Example.com", name: "Rina", subject: "Can't import", message: "My CSV from City Bank fails at row 3." },
      request,
    );
    expect(sent.reference).toHaveLength(8);
    const [row] = await db.select().from(supportRequests);
    expect(row).toMatchObject({ email: "visitor@example.com", status: "open", userId: null, subject: "Can't import" });

    const admin = await createUser("Support Admin");
    const listed = await support.list({ status: "open", page: 1, pageSize: 20 });
    expect(listed.total).toBe(1);
    expect(listed.counts.open).toBe(1);

    await support.setStatus([row?.id as string], "closed", { id: admin.userId, email: admin.email });
    expect((await support.list({ status: "open", page: 1, pageSize: 20 })).total).toBe(0);
    const [audit] = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.targetId, row?.id as string));
    expect(audit).toMatchObject({ action: "support.closed", actorId: admin.userId });
  });

  it("silently drops submissions that fill the hidden trap field", async () => {
    const controller = app.service(SupportController);
    const result = await controller.create(
      { email: "bot@spam.test", subject: "Cheap offers", message: "Buy now buy now buy now", website: "http://spam.test" },
      request,
    );
    expect(result.id).toBeNull();
    expect(await db.select().from(supportRequests)).toHaveLength(0);
  });

  it("rejects messages that are too short", async () => {
    await expect(support.create({ email: "a@b.test", subject: "Hi", message: "short" }, { userId: null, workspaceId: null, ip: null })).rejects.toThrow();
  });
});
