import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, authFeatures, authMail } from "../../src/auth/auth.js";
import { closeDb, db } from "../../src/db/index.js";
import { platformAuditLogs, sessions, twoFactors, userSettings, users } from "../../src/db/schema/index.js";
import type { EmailMessage } from "../../src/modules/system/email.service.js";
import { resetDatabase } from "./harness.js";

// Sign-in as a public service runs it: email verification required, password
// reset, two-factor sign-in, changing email, and admin actions in the
// platform audit log. Better Auth is called through `auth.api`, the way its
// HTTP handler calls it; the emails it would send are captured.
// vi.hoisted runs before the imports above, so env.ts sees the variable.
vi.hoisted(() => {
  process.env.REQUIRE_EMAIL_VERIFICATION = "true";
});

const PASSWORD = "correct horse battery staple";
let sent: EmailMessage[] = [];

function cookiesFrom(response: Response, previous = ""): string {
  const jar = new Map<string, string>();
  for (const part of previous.split(/;\s*/).filter(Boolean)) {
    const [name, ...value] = part.split("=");
    if (name) jar.set(name, value.join("="));
  }
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const [name, ...value] = pair.split("=");
    if (!name) continue;
    const text = value.join("=");
    if (!text || /max-age=0/i.test(header)) jar.delete(name);
    else jar.set(name, text);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

const headers = (cookie: string) => new Headers({ cookie });
const lastEmailTo = (to: string) => [...sent].reverse().find((message) => message.to === to);

function linkParams(message: EmailMessage | undefined) {
  if (!message?.action) throw new Error("No email with a link");
  const url = new URL(message.action.url);
  return { url, token: url.searchParams.get("token") ?? "", callbackURL: url.searchParams.get("callbackURL") ?? "" };
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps compute it. */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function signUp(name: string, email: string) {
  const response = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name, callbackURL: "/invite?token=abc" }, asResponse: true });
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { response, user };
}

async function verified(name: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { user } = await signUp(name, email);
  if (!user) throw new Error("not created");
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
  expect(signIn.status).toBe(200);
  return { id: user.id, email, cookie: cookiesFrom(signIn) };
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(() => {
  sent = [];
  vi.spyOn(authMail, "send").mockImplementation(async (message) => {
    sent.push(message);
    return { delivered: true, id: "test" };
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.REQUIRE_EMAIL_VERIFICATION;
  await closeDb();
});

describe("email verification", () => {
  it("signs nobody in at sign-up, sends a verification link, and signs in once it is used", async () => {
    expect(authFeatures.emailVerificationRequired).toBe(true);
    const email = `verify-${Date.now()}@example.test`;
    const { response, user } = await signUp("Vera Verify", email);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token: string | null }).token).toBeNull();
    expect(response.headers.getSetCookie().some((header) => header.includes("session_token=") && !/max-age=0/i.test(header))).toBe(false);
    if (!user) throw new Error("not created");
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id));
    expect(settings?.preferences.onboarded).toBe(false);

    const message = lastEmailTo(email);
    expect(message?.subject).toBe("Verify your email for FinanceOS");
    const link = linkParams(message);
    expect(link.url.pathname).toBe("/api/auth/verify-email");
    // Lands on our page, remembering where sign-up was headed.
    expect(link.callbackURL).toBe(`/verify-email?status=verified&next=${encodeURIComponent("/invite?token=abc")}`);

    const blocked = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");

    // Asking again sends another link.
    await auth.api.sendVerificationEmail({ body: { email } });
    expect(sent.filter((m) => m.to === email)).toHaveLength(2);

    const bad = await auth.api.verifyEmail({ query: { token: "not-a-token", callbackURL: link.callbackURL }, asResponse: true });
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("error=INVALID_TOKEN");

    const confirmed = await auth.api.verifyEmail({ query: { token: link.token, callbackURL: link.callbackURL }, asResponse: true });
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get("location")).toBe(link.callbackURL);
    expect(cookiesFrom(confirmed)).toContain("session_token=");
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after?.emailVerified).toBe(true);

    const signIn = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
    expect(signIn.status).toBe(200);
  });

  it("tells an existing account about a second sign-up instead of revealing it", async () => {
    const person = await verified("Existing Person");
    const { response } = await signUp("Impostor", person.email);
    expect(response.status).toBe(200);
    expect(lastEmailTo(person.email)?.subject).toBe("You already have an FinanceOS account");
  });
});

describe("password reset", () => {
  it("emails a one-hour link to /reset-password, changes the password and signs every device out", async () => {
    const person = await verified("Reset Person");
    await auth.api.requestPasswordReset({ body: { email: person.email, redirectTo: "/reset-password" } });
    const message = lastEmailTo(person.email);
    expect(message?.subject).toBe("Reset your FinanceOS password");
    const url = new URL(message?.action?.url ?? "");
    expect(url.pathname).toBe("/reset-password");
    const token = url.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(10);

    await auth.api.resetPassword({ body: { token, newPassword: "a brand new passphrase" } });
    expect(await db.select().from(sessions).where(eq(sessions.userId, person.id))).toHaveLength(0);
    expect(lastEmailTo(person.email)?.subject).toBe("Your FinanceOS password was changed");
    expect((await auth.api.signInEmail({ body: { email: person.email, password: PASSWORD }, asResponse: true })).status).toBe(401);
    expect((await auth.api.signInEmail({ body: { email: person.email, password: "a brand new passphrase" }, asResponse: true })).status).toBe(200);
    // The link works once.
    await expect(auth.api.resetPassword({ body: { token, newPassword: "yet another passphrase" } })).rejects.toThrow();
  });
});

describe("two-factor sign-in", () => {
  it("enables TOTP after a verified code, then asks for a second factor at sign-in", async () => {
    const person = await verified("Two Factor");
    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: headers(person.cookie), asResponse: true });
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Expense%20Wise:/);
    expect(backupCodes).toHaveLength(10);
    // Not on until a code from the app proves it is set up.
    let [user] = await db.select().from(users).where(eq(users.id, person.id));
    expect(user?.twoFactorEnabled).toBe(false);

    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    const verifiedCode = await auth.api.verifyTOTP({ body: { code: totp(secret) }, headers: headers(person.cookie), asResponse: true });
    expect(verifiedCode.status).toBe(200);
    [user] = await db.select().from(users).where(eq(users.id, person.id));
    expect(user?.twoFactorEnabled).toBe(true);
    const [row] = await db.select().from(twoFactors).where(eq(twoFactors.userId, person.id));
    expect(row?.verified).toBe(true);

    const signIn = await auth.api.signInEmail({ body: { email: person.email, password: PASSWORD }, asResponse: true });
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    const pending = cookiesFrom(signIn);
    expect(pending).toContain("two_factor=");
    expect(pending).not.toContain("session_token=");

    const wrong = await auth.api.verifyBackupCode({ body: { code: "not-a-code" }, headers: headers(pending), asResponse: true });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const second = await auth.api.verifyBackupCode({ body: { code: backupCodes[0] as string }, headers: headers(pending), asResponse: true });
    expect(second.status).toBe(200);
    expect(cookiesFrom(second)).toContain("session_token=");
  });
});

describe("changing email", () => {
  it("asks the current address to approve, then the new address to confirm", async () => {
    const person = await verified("Mover Person");
    const newEmail = `moved-${Date.now()}@example.test`;
    await auth.api.changeEmail({ body: { newEmail, callbackURL: "/settings/profile" }, headers: headers(person.cookie) });

    const approval = lastEmailTo(person.email);
    expect(approval?.subject).toBe("Approve your email change");
    expect(approval?.details).toEqual(expect.arrayContaining([{ label: "New email", value: newEmail }]));
    const first = linkParams(approval);
    expect(first.callbackURL).toBe(`/verify-email?status=change-confirmed&next=${encodeURIComponent("/settings/profile")}`);
    const approved = await auth.api.verifyEmail({
      query: { token: first.token, callbackURL: first.callbackURL },
      headers: headers(person.cookie),
      asResponse: true,
    });
    expect(approved.status).toBe(302);

    const confirmation = lastEmailTo(newEmail);
    expect(confirmation?.subject).toBe("Confirm your new email address");
    const second = linkParams(confirmation);
    expect(second.callbackURL).toBe(`/verify-email?status=email-changed&next=${encodeURIComponent("/settings/profile")}`);
    // Still the old address until the new one confirms.
    let [user] = await db.select().from(users).where(eq(users.id, person.id));
    expect(user?.email).toBe(person.email);
    const done = await auth.api.verifyEmail({
      query: { token: second.token, callbackURL: second.callbackURL },
      headers: headers(person.cookie),
      asResponse: true,
    });
    expect(done.status).toBe(302);
    [user] = await db.select().from(users).where(eq(users.id, person.id));
    expect(user?.email).toBe(newEmail);
    expect(user?.emailVerified).toBe(true);
  });
});

describe("platform admin audit", () => {
  it("records admin actions taken through Better Auth with the actor, target and IP", async () => {
    const adminUser = await verified("Platform Admin");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, adminUser.id));
    const target = await verified("Target Person");
    const other = await verified("Impersonated Person");
    const adminHeaders = new Headers({ cookie: adminUser.cookie, "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

    await auth.api.banUser({ body: { userId: target.id, banReason: "Chargeback fraud" }, headers: adminHeaders });
    await auth.api.setRole({ body: { userId: other.id, role: "user" }, headers: adminHeaders });
    // A failed action is not recorded.
    await expect(auth.api.banUser({ body: { userId: target.id }, headers: headers(other.cookie) })).rejects.toThrow();

    const impersonation = await auth.api.impersonateUser({ body: { userId: other.id }, headers: adminHeaders, asResponse: true });
    expect(impersonation.status).toBe(200);
    const asOther = cookiesFrom(impersonation, adminUser.cookie);
    const stopped = await auth.api.stopImpersonating({ headers: headers(asOther), asResponse: true });
    expect(stopped.status).toBe(200);

    const rows = await db.select().from(platformAuditLogs);
    const byAction = (action: string) => rows.filter((row) => row.action === action);
    expect(byAction("user.banned")).toEqual([
      expect.objectContaining({
        actorId: adminUser.id,
        actorEmail: adminUser.email,
        targetType: "user",
        targetId: target.id,
        ip: "203.0.113.7",
        details: expect.objectContaining({ reason: "Chargeback fraud", targetEmail: target.email }),
      }),
    ]);
    expect(byAction("user.role_changed")).toEqual([
      expect.objectContaining({ actorId: adminUser.id, targetId: other.id, details: expect.objectContaining({ role: "user" }) }),
    ]);
    expect(byAction("user.impersonated")).toEqual([expect.objectContaining({ actorId: adminUser.id, targetId: other.id })]);
    expect(byAction("user.impersonation_stopped")).toEqual([expect.objectContaining({ actorId: adminUser.id, targetId: other.id })]);
    expect(rows.filter((row) => row.actorId === other.id)).toHaveLength(0);
    const [banned] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, target.id), eq(users.banned, true)));
    expect(banned).toBeDefined();
  });
});
