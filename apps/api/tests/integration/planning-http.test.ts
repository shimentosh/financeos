import type { AddressInfo } from "node:net";
import { addDays, today } from "@financeos/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { auth } from "../../src/auth/auth.js";
import { closeDb } from "../../src/db/index.js";
import { resetDatabase } from "./harness.js";

// The planning routes over real HTTP: session cookie, workspace guard, Zod
// pipes, route order (/upcoming before /:id) and the error shapes the UI reads.

let app: INestApplication;
let base: string;
let cookie: string;
const T = today("Asia/Dhaka");

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  await resetDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  const response = await auth.api.signUpEmail({
    body: { email: `planning-${Date.now()}@example.test`, password: "correct horse battery staple", name: "Http Planner" },
    asResponse: true,
  });
  cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("planning over HTTP", () => {
  it("serves commitments, subscriptions, payments, budgets and goals", async () => {
    const account = await call<{ id: string }>("POST", "/accounts", { name: "USD Card", kind: "card", currency: "USD", openingDate: "2025-01-01" });
    expect(account.status).toBe(201);

    const created = await call<{ id: string; commitmentId: string; nextOccurrenceId: string; renewals: unknown[]; name: string }>("POST", "/subscriptions", {
      provider: "Netflix",
      amount: 2_000,
      currency: "usd",
      billingCycle: "monthly",
      startDate: addDays(T, -30),
      nextRenewalDate: T,
      accountId: account.body.id,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Netflix", renewals: [expect.objectContaining({ dueDate: T, status: "scheduled" })] });

    const listed = await call<{ items: Array<{ id: string }> }>("GET", "/subscriptions?billingCycle=monthly&autoRenew=true&q=net");
    expect(listed.body.items.map((s) => s.id)).toEqual([created.body.id]);
    expect((await call<{ activeCount: number }>("GET", "/subscriptions/analytics")).body.activeCount).toBe(1);
    expect((await call("GET", `/subscriptions/${created.body.id}`)).status).toBe(200);

    const upcoming = await call<{ items: Array<{ commitmentId: string; status: string }>; groups: unknown[] }>(
      "GET",
      "/commitments/upcoming?days=7&includeOverdue=false",
    );
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.items[0]).toMatchObject({ commitmentId: created.body.commitmentId, status: "scheduled" });
    expect((await call("GET", `/commitments/calendar?from=${T}&to=${addDays(T, 60)}&kind=subscription`)).status).toBe(200);
    expect((await call("GET", "/commitments/annual")).status).toBe(200);
    expect((await call("GET", "/commitments?subscriptions=only")).status).toBe(200);
    expect((await call("GET", `/commitments/${created.body.commitmentId}`)).status).toBe(200);

    const invalid = await call<{ error: string }>("GET", `/commitments/calendar?from=${addDays(T, 5)}&to=${T}`);
    expect(invalid).toMatchObject({ status: 400, body: { error: "validation_failed" } });
    expect((await call("GET", "/commitments/not-a-uuid")).status).toBe(400);

    // A matching expense already exists: 409 with the candidates, then link it.
    const existing = await call<{ id: string }>("POST", "/transactions", {
      type: "expense",
      accountId: account.body.id,
      amount: 2_000,
      currency: "USD",
      date: T,
      merchant: "Netflix",
    });
    const occurrenceId = created.body.nextOccurrenceId;
    const matches = await call<{ candidates: Array<{ id: string }> }>("GET", `/occurrences/${occurrenceId}/matches?paidOn=${T}`);
    expect(matches.body.candidates.map((c) => c.id)).toEqual([existing.body.id]);
    const duplicate = await call<{ statusCode: number; error: string; issues: { candidates: Array<{ id: string }> } }>(
      "POST",
      `/occurrences/${occurrenceId}/pay`,
      { paidOn: T },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      statusCode: 409,
      error: "possible_duplicate",
      issues: { candidates: [expect.objectContaining({ id: existing.body.id })] },
    });
    const linked = await call<{ created: boolean; commitment: { nextDueDate: string } }>("POST", `/occurrences/${occurrenceId}/pay`, {
      paidOn: T,
      existingTransactionId: existing.body.id,
    });
    expect(linked).toMatchObject({ status: 200, body: { created: false } });
    const undone = await call("POST", `/occurrences/${occurrenceId}/undo`, {});
    expect(undone).toMatchObject({ status: 200, body: { unlinkedTransactionId: existing.body.id, voidedTransactionId: null } });
    const cancelled = await call("POST", `/subscriptions/${created.body.id}/cancel`, { reason: "Switching" });
    expect(cancelled).toMatchObject({ status: 200, body: { commitmentStatus: "ended" } });

    const categories = await call<Array<{ id: string; name: string }>>("GET", "/categories");
    const food = categories.body.find((c) => c.name === "Food & Dining")?.id;
    const budget = await call<{ id: string; history: unknown[] }>("POST", "/budgets", { name: "Food", amount: 1_000_000, categoryId: food, startDate: T });
    expect(budget.status).toBe(201);
    expect((await call<{ history: unknown[] }>("GET", `/budgets/${budget.body.id}?periods=3`)).body.history).toHaveLength(3);
    expect((await call<{ items: unknown[] }>("GET", "/budgets?active=true")).body.items).toHaveLength(1);

    const goal = await call<{ id: string }>("POST", "/goals", { kind: "dream_asset", name: "Bike", targetAmount: 30_000_000, currency: "BDT" });
    expect(goal.status).toBe(201);
    const contribution = await call<{ goal: { progress: { current: number } } }>("POST", `/goals/${goal.body.id}/contributions`, {
      amount: 5_000_000,
      date: T,
    });
    expect(contribution).toMatchObject({ status: 201, body: { goal: { progress: { current: 5_000_000 } } } });
    expect((await call<{ items: unknown[] }>("GET", "/goals?kind=dream_asset")).body.items).toHaveLength(1);
  });

  it("refuses requests without a session", async () => {
    const response = await fetch(`${base}/commitments/upcoming`);
    expect(response.status).toBe(401);
  });
});
