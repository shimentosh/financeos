import type { AddressInfo } from "node:net";
import { today } from "@financeos/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, count, eq } from "drizzle-orm";
import Papa from "papaparse";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { auth } from "../../src/auth/auth.js";
import { closeDb, db } from "../../src/db/index.js";
import { financialAccounts, platformAuditLogs, sessions, transactions, userSettings, users, workspaceMembers, workspaces } from "../../src/db/schema/index.js";
import { csvCell } from "../../src/modules/account/account-export.service.js";
import { EmailService } from "../../src/modules/system/email.service.js";
import { resetDatabase } from "./harness.js";

// Data export, account deletion and first-run setup over real HTTP: session
// cookie, workspace guard and role checks, and the files the browser downloads.

let app: INestApplication;
let base: string;
const T = today("Asia/Dhaka");

type Person = { userId: string; email: string; cookie: string; personalId: string; businessId: string };

async function signUp(name: string): Promise<Person> {
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const response = await auth.api.signUpEmail({ body: { email, password: "correct horse battery staple", name }, asResponse: true });
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error("User was not created");
  const owned = await db
    .select({ id: workspaces.id, kind: workspaces.kind })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.id));
  const personalId = owned.find((w) => w.kind === "personal")?.id as string;
  const businessId = owned.find((w) => w.kind === "business")?.id as string;
  return { userId: user.id, email, cookie, personalId, businessId };
}

async function call<T = Record<string, unknown>>(
  who: Person | null,
  method: string,
  path: string,
  options: { body?: unknown; workspaceId?: string } = {},
): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(who ? { cookie: who.cookie } : {}),
      ...(options.workspaceId ? { "x-workspace-id": options.workspaceId } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  // Keep a byte-order mark if there is one (response.text() would drop it).
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body: body as T, text, headers: response.headers };
}

async function addTransaction(who: Person, workspaceId: string, input: Record<string, unknown>) {
  const created = await call<{ id: string }>(who, "POST", "/transactions", { workspaceId, body: { type: "expense", date: T, ...input } });
  expect(created.status).toBe(201);
  return created.body.id;
}

beforeAll(async () => {
  await resetDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("auth options", () => {
  it("tells signed-out visitors what the sign-in pages can offer", async () => {
    const response = await call(null, "GET", "/auth-options");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ signUpEnabled: true, googleEnabled: false, emailVerificationRequired: false });
  });
});

describe("data export", () => {
  it("exports every record of the current workspace, only that workspace, and only for owners and admins", async () => {
    const owner = await signUp("Export Owner");
    const other = await signUp("Export Other");

    const bank = await call<{ id: string }>(owner, "POST", "/accounts", {
      workspaceId: owner.personalId,
      body: { name: 'City "Main", Bank', kind: "bank", currency: "BDT", openingDate: "2025-01-01" },
    });
    const card = await call<{ id: string }>(owner, "POST", "/accounts", {
      workspaceId: owner.personalId,
      body: { name: "USD Card", kind: "card", currency: "USD", openingDate: "2025-01-01" },
    });
    expect(bank.status).toBe(201);
    const tricky = await addTransaction(owner, owner.personalId, {
      accountId: bank.body.id,
      amount: 123_450,
      currency: "BDT",
      merchant: 'Coffee, "Beans"\nShop',
      description: "=HYPERLINK(1)",
    });
    const dollars = await addTransaction(owner, owner.personalId, { accountId: card.body.id, amount: 1_234, currency: "USD", merchant: "Figma" });
    // Another person's records, and the same owner's other workspace, stay out.
    const otherBank = await call<{ id: string }>(other, "POST", "/accounts", {
      workspaceId: other.personalId,
      body: { name: "Other Bank", kind: "bank", currency: "BDT", openingDate: "2025-01-01" },
    });
    const foreign = await addTransaction(other, other.personalId, {
      accountId: otherBank.body.id,
      amount: 5_000,
      currency: "BDT",
      merchant: "B-secret-merchant",
    });

    const exported = await call<{
      format: string;
      workspace: { id: string; name: string };
      counts: Record<string, number>;
      data: {
        transactions: Array<{ id: string; workspaceId: string }>;
        ledgerEntries: Array<{ transactionId: string; workspaceId: string }>;
        accounts: Array<{ id: string; workspaceId: string }>;
        members: Array<{ userId: string; role: string }>;
        files: Array<Record<string, unknown>>;
        categories: Array<{ workspaceId: string }>;
        auditLog: Array<{ workspaceId: string }>;
      };
    }>(owner, "GET", "/account/export", { workspaceId: owner.personalId });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("application/json");
    expect(exported.headers.get("content-disposition")).toMatch(/^attachment; filename="financeos-personal-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(exported.body.format).toBe("financeos-export");
    expect(exported.body.workspace.id).toBe(owner.personalId);
    expect(exported.body.data.transactions.map((t) => t.id).sort()).toEqual([tricky, dollars].sort());
    expect(exported.body.data.ledgerEntries.length).toBeGreaterThanOrEqual(2);
    expect(exported.body.counts.transactions).toBe(2);
    expect(exported.body.data.members).toEqual([expect.objectContaining({ userId: owner.userId, role: "owner" })]);
    for (const key of ["transactions", "ledgerEntries", "accounts", "categories", "auditLog"] as const) {
      expect(exported.body.data[key].every((row) => row.workspaceId === owner.personalId)).toBe(true);
    }
    expect(exported.body.data.accounts.map((a) => a.id)).toEqual(expect.arrayContaining([bank.body.id, card.body.id]));
    expect(exported.text).not.toContain(foreign);
    expect(exported.text).not.toContain("B-secret-merchant");
    expect(exported.text).not.toContain(owner.businessId);

    // The profile export belongs to the person, not a workspace.
    const profile = await call<{ profile: { email: string }; memberships: Array<{ workspaceId: string }>; sessions: Array<Record<string, unknown>> }>(
      owner,
      "GET",
      "/account/me/export",
    );
    expect(profile.status).toBe(200);
    expect(profile.body.profile.email).toBe(owner.email);
    expect(profile.body.memberships.map((m) => m.workspaceId).sort()).toEqual([owner.personalId, owner.businessId].sort());
    expect(profile.text).not.toMatch(/"token"|"password"/);

    // Members and viewers cannot export a workspace; admins can.
    await db.insert(workspaceMembers).values({ workspaceId: owner.personalId, userId: other.userId, role: "member" });
    expect((await call(other, "GET", "/account/export", { workspaceId: owner.personalId })).status).toBe(403);
    expect((await call(other, "GET", "/account/export/transactions.csv", { workspaceId: owner.personalId })).status).toBe(403);
    await db
      .update(workspaceMembers)
      .set({ role: "admin" })
      .where(and(eq(workspaceMembers.workspaceId, owner.personalId), eq(workspaceMembers.userId, other.userId)));
    const asAdmin = await call<{ workspace: { id: string } }>(other, "GET", "/account/export", { workspaceId: owner.personalId });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.workspace.id).toBe(owner.personalId);
    // Without a cookie, nothing.
    expect((await call(null, "GET", "/account/export")).status).toBe(401);
  });

  it("writes transactions as escaped CSV with decimal amounts in their original and base currencies", async () => {
    const owner = await signUp("Csv Owner");
    const bank = await call<{ id: string }>(owner, "POST", "/accounts", {
      workspaceId: owner.personalId,
      body: { name: 'City "Main", Bank', kind: "bank", currency: "BDT", openingDate: "2025-01-01" },
    });
    const card = await call<{ id: string }>(owner, "POST", "/accounts", {
      workspaceId: owner.personalId,
      body: { name: "USD Card", kind: "card", currency: "USD", openingDate: "2025-01-01" },
    });
    await addTransaction(owner, owner.personalId, {
      accountId: bank.body.id,
      amount: 123_450,
      currency: "BDT",
      merchant: 'Coffee, "Beans"\nShop',
      description: "=HYPERLINK(1)",
    });
    await addTransaction(owner, owner.personalId, { accountId: card.body.id, amount: 1_234, currency: "USD", merchant: "Figma" });

    const response = await call(owner, "GET", "/account/export/transactions.csv", { workspaceId: owner.personalId });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="financeos-personal-transactions-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.text.startsWith("﻿")).toBe(true);
    // The raw text: quotes doubled, fields with commas, quotes or newlines quoted.
    expect(response.text).toContain('"Coffee, ""Beans""\nShop"');
    expect(response.text).toContain('"City ""Main"", Bank"');
    expect(response.text).toContain("'=HYPERLINK(1)");

    const parsed = Papa.parse<Record<string, string>>(response.text.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toHaveLength(2);
    const coffee = parsed.data.find((row) => row.merchant?.startsWith("Coffee"));
    expect(coffee).toMatchObject({
      merchant: 'Coffee, "Beans"\nShop',
      account: 'City "Main", Bank',
      description: "'=HYPERLINK(1)",
      amount: "1234.5",
      currency: "BDT",
      account_amount: "1234.5",
      account_currency: "BDT",
      base_amount: "1234.5",
      base_currency: "BDT",
      type: "expense",
      status: "posted",
    });
    const figma = parsed.data.find((row) => row.merchant === "Figma");
    expect(figma).toMatchObject({ amount: "12.34", currency: "USD", account_amount: "12.34", account_currency: "USD", base_currency: "BDT" });
    expect(Number(figma?.base_amount)).toBeGreaterThan(12.34);
    expect(figma?.fx_rate).toMatch(/^\d+(\.\d+)?$/);
  });

  it("escapes cells by RFC 4180 and neutralises spreadsheet formulas in text only", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\r\nbreak")).toBe('"line\r\nbreak"');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("+1,5")).toBe(`"'+1,5"`);
    expect(csvCell("-12.5", "numeric")).toBe("-12.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("account deletion", () => {
  it("is refused while the account owns a workspace other people use", async () => {
    const owner = await signUp("Shared Owner");
    const teammate = await signUp("Shared Teammate");
    await db.insert(workspaceMembers).values({ workspaceId: owner.businessId, userId: teammate.userId, role: "member" });

    const check = await call<{ canDelete: boolean; blocking: Array<{ id: string; otherMembers: number }>; deletes: Array<{ id: string }> }>(
      owner,
      "GET",
      "/account/deletion-check",
    );
    expect(check.status).toBe(200);
    expect(check.body.canDelete).toBe(false);
    expect(check.body.blocking).toEqual([expect.objectContaining({ id: owner.businessId, otherMembers: 1 })]);
    expect(check.body.deletes.map((w) => w.id)).toEqual([owner.personalId]);

    const refused = await call<{ error: string; issues: { workspaces: Array<{ id: string }> } }>(owner, "DELETE", "/account", {
      body: { confirmEmail: owner.email },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("workspaces_shared");
    expect(refused.body.issues.workspaces.map((w) => w.id)).toEqual([owner.businessId]);
    // Nothing was deleted.
    expect(await db.select().from(users).where(eq(users.id, owner.userId))).toHaveLength(1);
    expect(await db.select().from(workspaces).where(eq(workspaces.id, owner.personalId))).toHaveLength(1);
  });

  it("deletes the workspaces owned alone and the user, leaves shared ones and touches nobody else's data", async () => {
    const leaving = await signUp("Leaving User");
    const staying = await signUp("Staying User");
    // The leaving user is also a member of someone else's workspace.
    await db.insert(workspaceMembers).values({ workspaceId: staying.personalId, userId: leaving.userId, role: "member" });
    const stayingBank = await call<{ id: string }>(staying, "POST", "/accounts", {
      workspaceId: staying.personalId,
      body: { name: "Staying Bank", kind: "bank", currency: "BDT", openingDate: "2025-01-01" },
    });
    await addTransaction(staying, staying.personalId, { accountId: stayingBank.body.id, amount: 7_700, currency: "BDT", merchant: "Groceries" });
    const leavingBank = await call<{ id: string }>(leaving, "POST", "/accounts", {
      workspaceId: leaving.personalId,
      body: { name: "Leaving Bank", kind: "bank", currency: "BDT", openingDate: "2025-01-01" },
    });
    await addTransaction(leaving, leaving.personalId, { accountId: leavingBank.body.id, amount: 1_000, currency: "BDT", merchant: "Tea" });

    const emails = vi.spyOn(EmailService.prototype, "send");
    const mismatch = await call<{ error: string }>(leaving, "DELETE", "/account", { body: { confirmEmail: "someone-else@example.test" } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe("confirmation_mismatch");
    expect((await call(leaving, "DELETE", "/account", { body: {} })).status).toBe(400);

    const deleted = await call<{ deleted: boolean; workspacesDeleted: number; workspacesLeft: number }>(leaving, "DELETE", "/account", {
      body: { confirmEmail: leaving.email.toUpperCase() },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, workspacesDeleted: 2, workspacesLeft: 1 });

    expect(await db.select().from(users).where(eq(users.id, leaving.userId))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, leaving.userId))).toHaveLength(0);
    expect(await db.select().from(userSettings).where(eq(userSettings.userId, leaving.userId))).toHaveLength(0);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, leaving.userId))).toHaveLength(0);
    for (const id of [leaving.personalId, leaving.businessId]) {
      expect(await db.select().from(workspaces).where(eq(workspaces.id, id))).toHaveLength(0);
      expect(await db.select().from(transactions).where(eq(transactions.workspaceId, id))).toHaveLength(0);
    }
    // The other person's workspace, and their records in it, are untouched.
    expect(await db.select().from(workspaces).where(eq(workspaces.id, staying.personalId))).toHaveLength(1);
    const [{ value: stayingTransactions } = { value: 0 }] = await db
      .select({ value: count() })
      .from(transactions)
      .where(eq(transactions.workspaceId, staying.personalId));
    expect(stayingTransactions).toBe(1);
    expect(await db.select().from(users).where(eq(users.id, staying.userId))).toHaveLength(1);

    const audit = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.actorId, leaving.userId));
    expect(audit.map((row) => row.action).sort()).toEqual(["account.deleted", "workspace.deleted", "workspace.deleted"]);
    expect(audit.find((row) => row.action === "account.deleted")).toMatchObject({ targetType: "user", targetId: leaving.userId, actorEmail: leaving.email });
    expect(audit.filter((row) => row.action === "workspace.deleted").every((row) => row.details.reason === "account_deleted")).toBe(true);
    expect(emails).toHaveBeenCalledWith(expect.objectContaining({ to: leaving.email, subject: "Your FinanceOS account was deleted" }));
    emails.mockRestore();

    // The old session no longer works.
    expect((await call(leaving, "GET", "/me")).status).toBe(401);
  });
});

describe("first-run setup", () => {
  it("marks new sign-ups as not onboarded and applies currency, timezone and a personal-only start", async () => {
    const person = await signUp("New Person");
    const me = await call<{ preferences: { onboarded?: boolean } }>(person, "GET", "/me");
    expect(me.body.preferences.onboarded).toBe(false);

    const result = await call<{
      onboarded: boolean;
      businessDeleted: boolean;
      workspaces: Array<{ id: string; baseCurrency: string; currencyApplied: boolean }>;
    }>(person, "POST", "/account/onboarding", { body: { baseCurrency: "usd", timezone: "Europe/London", keepBusiness: false } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ onboarded: true, businessDeleted: true });
    expect(result.body.workspaces).toEqual([expect.objectContaining({ id: person.personalId, baseCurrency: "USD", currencyApplied: true })]);

    const [personal] = await db.select().from(workspaces).where(eq(workspaces.id, person.personalId));
    expect(personal).toMatchObject({ baseCurrency: "USD", timezone: "Europe/London" });
    const cash = await db.select().from(financialAccounts).where(eq(financialAccounts.workspaceId, person.personalId));
    expect(cash.map((account) => account.currency)).toEqual(["USD"]);
    expect(await db.select().from(workspaces).where(eq(workspaces.id, person.businessId))).toHaveLength(0);
    const after = await call<{ preferences: { onboarded?: boolean; theme?: string } }>(person, "GET", "/me");
    expect(after.body.preferences).toMatchObject({ onboarded: true, theme: "system" });
  });

  it("keeps the currency of workspaces that already have records and names the business", async () => {
    const person = await signUp("Busy Person");
    const cash = await db.select().from(financialAccounts).where(eq(financialAccounts.workspaceId, person.personalId));
    await addTransaction(person, person.personalId, { accountId: cash[0]?.id, amount: 2_500, currency: "BDT", merchant: "Rickshaw" });

    const result = await call<{
      businessDeleted: boolean;
      businessKeptReason: string | null;
      workspaces: Array<{ id: string; name: string; currencyApplied: boolean }>;
    }>(person, "POST", "/account/onboarding", { body: { baseCurrency: "EUR", timezone: "Asia/Dubai", keepBusiness: true, businessName: "Busy Trading" } });
    expect(result.status).toBe(200);
    expect(result.body.businessDeleted).toBe(false);
    const byId = Object.fromEntries(result.body.workspaces.map((w) => [w.id, w]));
    expect(byId[person.personalId]).toMatchObject({ currencyApplied: false });
    expect(byId[person.businessId]).toMatchObject({ currencyApplied: true, name: "Busy Trading" });
    const [personal] = await db.select().from(workspaces).where(eq(workspaces.id, person.personalId));
    const [business] = await db.select().from(workspaces).where(eq(workspaces.id, person.businessId));
    expect(personal).toMatchObject({ baseCurrency: "BDT", timezone: "Asia/Dubai" });
    expect(business).toMatchObject({ baseCurrency: "EUR", timezone: "Asia/Dubai", name: "Busy Trading" });

    // A business with records is never removed by setup.
    const bizCash = await call<{ id: string }>(person, "POST", "/accounts", {
      workspaceId: person.businessId,
      body: { name: "Biz Bank", kind: "bank", currency: "EUR", openingDate: "2025-01-01" },
    });
    await addTransaction(person, person.businessId, { accountId: bizCash.body.id, amount: 900, currency: "EUR", merchant: "Supplies" });
    const again = await call<{ businessDeleted: boolean; businessKeptReason: string | null }>(person, "POST", "/account/onboarding", {
      body: { baseCurrency: "EUR", timezone: "Asia/Dubai", keepBusiness: false },
    });
    expect(again.body).toMatchObject({ businessDeleted: false, businessKeptReason: "It already has records." });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, person.businessId))).toHaveLength(1);
  });

  it("only changes workspaces the person owns and rejects unknown timezones", async () => {
    const owner = await signUp("Tz Owner");
    const guest = await signUp("Tz Guest");
    await db.insert(workspaceMembers).values({ workspaceId: owner.personalId, userId: guest.userId, role: "admin" });

    expect((await call(guest, "POST", "/account/onboarding", { body: { baseCurrency: "USD", timezone: "Mars/Olympus", keepBusiness: true } })).status).toBe(
      400,
    );
    expect((await call(guest, "POST", "/account/onboarding", { body: { baseCurrency: "US", timezone: "UTC", keepBusiness: true } })).status).toBe(400);
    const done = await call(guest, "POST", "/account/onboarding", { body: { baseCurrency: "USD", timezone: "UTC", keepBusiness: true } });
    expect(done.status).toBe(200);
    const [ownersWorkspace] = await db.select().from(workspaces).where(eq(workspaces.id, owner.personalId));
    expect(ownersWorkspace).toMatchObject({ baseCurrency: "BDT", timezone: "Asia/Dhaka" });
  });
});
