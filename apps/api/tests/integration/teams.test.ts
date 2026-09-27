import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { auth } from "../../src/auth/auth.js";
import { planLimit } from "../../src/common/errors.js";
import { closeDb, db } from "../../src/db/index.js";
import { auditLogs, platformAuditLogs, userSettings, users, workspaceInvitations, workspaceMembers, workspaces } from "../../src/db/schema/index.js";
import { EntitlementsService } from "../../src/modules/billing/entitlements.service.js";
import { provisionUser } from "../../src/modules/workspaces/provisioning.js";
import { resetDatabase } from "./harness.js";

// Workspace teams over real HTTP: session cookies, the workspace and manage
// guards, and the rules that close the old add-by-email holes (an admin
// demoting the owner; a squatter registering an invited address first).

let app: INestApplication;
let base: string;
let entitlements: EntitlementsService;

type Person = { id: string; name: string; email: string; cookie: string; personal: string; business: string };
type Result<T> = { status: number; body: T; headers: Headers };
type Invited = { invitation: { id: string; email: string; role: string; status: string }; link: string; emailSent: boolean };
type Member = { id: string; userId: string; role: string; email: string; emailVerified: boolean };

/** A signed-up person with a live session (made directly, so it doesn't depend on sign-up settings). */
async function person(name: string, options: { email?: string; verified?: boolean } = {}): Promise<Person> {
  const id = randomUUID().replace(/-/g, "");
  const email = (options.email ?? `${name.toLowerCase().replace(/\W+/g, "")}-${id.slice(0, 6)}@example.test`).toLowerCase();
  await db.insert(users).values({ id, name, email, emailVerified: options.verified ?? true });
  await provisionUser({ id, email, name });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(id);
  const signature = createHmac("sha256", context.secret).update(session.token).digest("base64");
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
  const owned = await db
    .select({ id: workspaces.id, kind: workspaces.kind })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, id))
    .orderBy(asc(workspaces.createdAt));
  const find = (kind: string) => owned.find((w) => w.kind === kind)?.id as string;
  return { id, name, email, cookie, personal: find("personal"), business: find("business") };
}

async function call<T = Record<string, unknown>>(who: Person | null, method: string, path: string, body?: unknown, workspaceId?: string): Promise<Result<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(who ? { cookie: who.cookie } : {}),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T, headers: response.headers };
}

const tokenOf = (link: string) => new URL(link).searchParams.get("token") as string;

async function invite(by: Person, email: string, role: "admin" | "member" | "viewer", workspaceId = by.business) {
  const result = await call<Invited>(by, "POST", "/workspaces/current/invitations", { email, role }, workspaceId);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return { ...result.body, token: tokenOf(result.body.link) };
}

async function join(owner: Person, who: Person, role: "admin" | "member" | "viewer", workspaceId = owner.business) {
  const { token } = await invite(owner, who.email, role, workspaceId);
  const accepted = await call(who, "POST", "/invitations/accept", { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
}

async function memberOf(workspaceId: string, userId: string) {
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row ?? null;
}

async function actions(workspaceId: string) {
  const rows = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  entitlements = app.get(EntitlementsService);
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe("the old add-member holes are closed", () => {
  it("an admin can't demote, re-add or remove the owner", async () => {
    const owner = await person("Olivia Owner");
    const admin = await person("Adam Admin");
    await join(owner, admin, "admin");

    const members = (await call<Member[]>(admin, "GET", "/workspaces/current/members", undefined, owner.business)).body;
    const ownerRow = members.find((m) => m.userId === owner.id) as Member;
    expect(ownerRow.role).toBe("owner");

    // The old route upserted the role; re-adding the owner as a viewer now just says they're a member.
    const readd = await call(admin, "POST", "/workspaces/current/members", { email: owner.email, role: "viewer" }, owner.business);
    expect(readd).toMatchObject({ status: 409, body: { error: "already_member" } });
    const reinvite = await call(admin, "POST", "/workspaces/current/invitations", { email: owner.email.toUpperCase(), role: "viewer" }, owner.business);
    expect(reinvite).toMatchObject({ status: 409, body: { error: "already_member" } });

    expect(await call(admin, "PATCH", `/workspaces/current/members/${ownerRow.id}`, { role: "viewer" }, owner.business)).toMatchObject({
      status: 403,
      body: { error: "owner_protected" },
    });
    expect(await call(admin, "DELETE", `/workspaces/current/members/${ownerRow.id}`, undefined, owner.business)).toMatchObject({
      status: 403,
      body: { error: "owner_protected" },
    });
    // Nor can the owner change their own role.
    expect(await call(owner, "PATCH", `/workspaces/current/members/${ownerRow.id}`, { role: "admin" }, owner.business)).toMatchObject({
      status: 403,
      body: { error: "own_role" },
    });
    expect((await memberOf(owner.business, owner.id))?.role).toBe("owner");
    expect(await db.select().from(workspaceInvitations).where(eq(workspaceInvitations.email, owner.email))).toHaveLength(0);
  });

  it("an address registered first, but not verified, can't take the seat; nor can another signed-in email", async () => {
    const owner = await person("Olivia Owner");
    const { token } = await invite(owner, "Accountant@Company.test", "member");

    const squatter = await person("Squatter", { email: "accountant@company.test", verified: false });
    const lookup = await call<{ email: string; viewer: { matches: boolean; emailVerified: boolean } }>(squatter, "GET", `/invitations/lookup?token=${token}`);
    expect(lookup.body).toMatchObject({ email: "a***@company.test", viewer: { matches: true, emailVerified: false } });
    expect(await call(squatter, "POST", "/invitations/accept", { token })).toMatchObject({ status: 403, body: { error: "email_unverified" } });
    expect(await memberOf(owner.business, squatter.id)).toBeNull();

    const stranger = await person("Stranger");
    const mismatch = await call<{ error: string; message: string }>(stranger, "POST", "/invitations/accept", { token });
    expect(mismatch).toMatchObject({ status: 403, body: { error: "invitation_email_mismatch" } });
    expect(mismatch.body.message).toContain("a***@company.test");
    expect(await memberOf(owner.business, stranger.id)).toBeNull();

    // Once the real owner of the address has verified it, the invitation works — once.
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, squatter.id));
    const accepted = await call<{ workspaceId: string; role: string }>(squatter, "POST", "/invitations/accept", { token });
    expect(accepted).toMatchObject({ status: 200, body: { workspaceId: owner.business, role: "member" } });
    expect(accepted.headers.get("set-cookie")).toContain(`ew_ws=${owner.business}`);
    expect((await memberOf(owner.business, squatter.id))?.role).toBe("member");
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, squatter.id));
    expect(settings?.activeWorkspaceId).toBe(owner.business);
    expect(await call(stranger, "POST", "/invitations/accept", { token })).toMatchObject({ status: 409, body: { error: "invitation_used" } });
    expect(await actions(owner.business)).toEqual(expect.arrayContaining(["invitation.created", "member.joined"]));
  });
});

describe("invitation links", () => {
  it("are single use, can be revoked, expire, and re-inviting replaces the link", async () => {
    const owner = await person("Olivia Owner");
    const guest = await person("Gita Guest");

    const first = await invite(owner, guest.email, "viewer");
    const second = await invite(owner, guest.email, "member");
    const open = await db
      .select()
      .from(workspaceInvitations)
      .where(and(eq(workspaceInvitations.email, guest.email), eq(workspaceInvitations.status, "pending")));
    expect(open).toHaveLength(1);
    expect(open[0]?.tokenHash).not.toContain(second.token);
    expect(await call(guest, "POST", "/invitations/accept", { token: first.token })).toMatchObject({ status: 409, body: { error: "invitation_revoked" } });
    expect((await call(null, "GET", `/invitations/lookup?token=${first.token}`)).body).toMatchObject({ status: "revoked" });

    // Revoked by the owner.
    expect((await call(owner, "DELETE", `/workspaces/current/invitations/${second.invitation.id}`, undefined, owner.business)).status).toBe(200);
    expect(await call(guest, "POST", "/invitations/accept", { token: second.token })).toMatchObject({ status: 409, body: { error: "invitation_revoked" } });

    // Expired: shown as lapsed, can't be accepted, resending issues a fresh link.
    const third = await invite(owner, guest.email, "member");
    await db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(workspaceInvitations.id, third.invitation.id));
    const lookup = await call(null, "GET", `/invitations/lookup?token=${third.token}`);
    expect(lookup).toMatchObject({ status: 200, body: { expired: true, status: "expired", role: "member", inviterName: "Olivia Owner" } });
    expect(await call(guest, "POST", "/invitations/accept", { token: third.token })).toMatchObject({ status: 409, body: { error: "invitation_expired" } });
    const listed = await call<Array<{ id: string; status: string }>>(owner, "GET", "/workspaces/current/invitations", undefined, owner.business);
    expect(listed.body).toEqual([expect.objectContaining({ id: third.invitation.id, status: "expired" })]);

    const resent = await call<Invited>(owner, "POST", `/workspaces/current/invitations/${third.invitation.id}/resend`, {}, owner.business);
    expect(resent).toMatchObject({ status: 200, body: { invitation: { status: "pending" } } });
    const fresh = tokenOf(resent.body.link);
    expect(fresh).not.toBe(third.token);
    expect(await call(guest, "POST", "/invitations/accept", { token: third.token })).toMatchObject({ status: 404 });

    expect(await call(guest, "POST", "/invitations/accept", { token: fresh })).toMatchObject({ status: 200, body: { role: "member" } });
    // A second click by the same person is harmless…
    expect(await call(guest, "POST", "/invitations/accept", { token: fresh })).toMatchObject({ status: 200, body: { alreadyMember: true } });
    // …but the link can't bring them back after they're removed.
    const member = await memberOf(owner.business, guest.id);
    expect((await call(owner, "DELETE", `/workspaces/current/members/${member?.id}`, undefined, owner.business)).status).toBe(200);
    expect(await call(guest, "POST", "/invitations/accept", { token: fresh })).toMatchObject({ status: 409, body: { error: "invitation_used" } });
    expect(await memberOf(owner.business, guest.id)).toBeNull();

    // Accepted invitations drop off the list.
    expect((await call<unknown[]>(owner, "GET", "/workspaces/current/invitations", undefined, owner.business)).body).toEqual([]);
    expect(await actions(owner.business)).toEqual(
      expect.arrayContaining(["invitation.created", "invitation.revoked", "invitation.resent", "member.joined", "member.removed"]),
    );
  });

  it("lookups are public but reveal only a masked address; unknown tokens are 404", async () => {
    const owner = await person("Olivia Owner");
    const { token } = await invite(owner, "rahim.uddin@gmail.test", "viewer");
    const lookup = await call(null, "GET", `/invitations/lookup?token=${token}`);
    expect(lookup).toMatchObject({
      status: 200,
      body: { email: "r***@gmail.test", role: "viewer", status: "pending", expired: false, workspaceKind: "business", viewer: null },
    });
    expect(JSON.stringify(lookup.body)).not.toContain("rahim.uddin");
    expect((await call(null, "GET", `/invitations/lookup?token=${"x".repeat(43)}`)).status).toBe(404);
    // Accepting needs a session.
    expect((await call(null, "POST", "/invitations/accept", { token })).status).toBe(401);
    // Only managers see or send invitations.
    const viewer = await person("Vera Viewer");
    await join(owner, viewer, "viewer");
    expect((await call(viewer, "GET", "/workspaces/current/invitations", undefined, owner.business)).status).toBe(403);
    expect((await call(viewer, "POST", "/workspaces/current/invitations", { email: "x@example.test", role: "viewer" }, owner.business)).status).toBe(403);
  });
});

describe("roles", () => {
  it("follow the matrix: the owner manages everyone, admins only members and viewers", async () => {
    const owner = await person("Olivia Owner");
    const admin = await person("Adam Admin");
    const admin2 = await person("Ada Admin");
    const member = await person("Mina Member");
    const viewer = await person("Vera Viewer");
    await join(owner, admin, "admin");
    await join(owner, admin2, "admin");
    await join(owner, member, "member");
    await join(owner, viewer, "viewer");
    const members = (await call<Member[]>(owner, "GET", "/workspaces/current/members", undefined, owner.business)).body;
    expect(members.map((m) => m.role)).toEqual(["owner", "admin", "admin", "member", "viewer"]);
    const idOf = (who: Person) => (members.find((m) => m.userId === who.id) as Member).id;
    const patch = (by: Person, target: Person, role: string) => call(by, "PATCH", `/workspaces/current/members/${idOf(target)}`, { role }, owner.business);

    // Owner: anything but owner, on anyone else.
    expect(await patch(owner, member, "admin")).toMatchObject({ status: 200, body: { role: "admin" } });
    expect(await patch(owner, member, "member")).toMatchObject({ status: 200, body: { role: "member" } });
    expect((await patch(owner, member, "owner")).status).toBe(400);

    // Admin: members and viewers, to member or viewer only.
    expect(await patch(admin, member, "viewer")).toMatchObject({ status: 200, body: { role: "viewer" } });
    expect(await patch(admin, member, "member")).toMatchObject({ status: 200, body: { role: "member" } });
    expect(await patch(admin, viewer, "member")).toMatchObject({ status: 200, body: { role: "member" } });
    expect(await patch(admin, viewer, "viewer")).toMatchObject({ status: 200 });
    expect(await patch(admin, member, "admin")).toMatchObject({ status: 403, body: { error: "role_not_allowed" } });
    expect(await patch(admin, admin2, "member")).toMatchObject({ status: 403, body: { error: "role_not_allowed" } });
    expect(await patch(admin, admin, "member")).toMatchObject({ status: 403, body: { error: "own_role" } });
    expect(await patch(admin, owner, "admin")).toMatchObject({ status: 403, body: { error: "owner_protected" } });

    // Members and viewers can't manage anyone.
    expect((await patch(member, viewer, "member")).status).toBe(403);
    expect((await patch(viewer, member, "viewer")).status).toBe(403);

    // Invitations follow the same rule.
    expect(await call(admin, "POST", "/workspaces/current/invitations", { email: "new-admin@example.test", role: "admin" }, owner.business)).toMatchObject({
      status: 403,
      body: { error: "role_not_allowed" },
    });
    expect((await call(admin, "POST", "/workspaces/current/invitations", { email: "new-viewer@example.test", role: "viewer" }, owner.business)).status).toBe(
      201,
    );
    const ownerInvite = await invite(owner, "new-admin@example.test", "admin");
    // Admins can't withdraw or re-send the owner's admin invitations either.
    expect((await call(admin, "DELETE", `/workspaces/current/invitations/${ownerInvite.invitation.id}`, undefined, owner.business)).status).toBe(403);
    expect((await call(admin, "POST", `/workspaces/current/invitations/${ownerInvite.invitation.id}/resend`, {}, owner.business)).status).toBe(403);

    // Removal: admins remove members and viewers; nobody removes the owner or themselves.
    const remove = (by: Person, target: Person) => call(by, "DELETE", `/workspaces/current/members/${idOf(target)}`, undefined, owner.business);
    expect(await remove(admin, admin2)).toMatchObject({ status: 403, body: { error: "role_not_allowed" } });
    expect(await remove(admin, owner)).toMatchObject({ status: 403, body: { error: "owner_protected" } });
    expect(await remove(owner, owner)).toMatchObject({ status: 403, body: { error: "use_leave" } });
    expect(await remove(admin, member)).toMatchObject({ status: 200 });
    expect(await remove(owner, admin2)).toMatchObject({ status: 200 });
    expect(await memberOf(owner.business, member.id)).toBeNull();
    expect(await memberOf(owner.business, admin2.id)).toBeNull();
    expect(await actions(owner.business)).toEqual(expect.arrayContaining(["member.role_changed", "member.removed"]));
  });

  it("anyone but the owner can leave, viewers included", async () => {
    const owner = await person("Olivia Owner");
    const viewer = await person("Vera Viewer");
    await join(owner, viewer, "viewer");

    const left = await call<{ workspaceId: string }>(viewer, "POST", "/workspaces/current/leave", {}, owner.business);
    expect(left).toMatchObject({ status: 200, body: { workspaceId: viewer.personal } });
    expect(left.headers.get("set-cookie")).toContain(`ew_ws=${viewer.personal}`);
    expect(await memberOf(owner.business, viewer.id)).toBeNull();
    expect(await actions(owner.business)).toContain("member.left");

    expect(await call(owner, "POST", "/workspaces/current/leave", {}, owner.business)).toMatchObject({ status: 403, body: { error: "owner_cannot_leave" } });
  });
});

describe("ownership", () => {
  it("transfers only from the owner, to a verified member; the old owner becomes an admin", async () => {
    const owner = await person("Olivia Owner");
    const admin = await person("Adam Admin");
    const heir = await person("Hasan Heir");
    const outsider = await person("Omar Outsider");
    await join(owner, admin, "admin");
    await join(owner, heir, "member");
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, heir.id));
    const canCreate = vi.spyOn(entitlements, "assertCanCreateWorkspace");

    expect(await call(admin, "POST", "/workspaces/current/transfer", { userId: heir.id }, owner.business)).toMatchObject({
      status: 403,
      body: { error: "owner_only" },
    });
    expect(await call(heir, "POST", "/workspaces/current/transfer", { userId: heir.id }, owner.business)).toMatchObject({ status: 403 });
    expect(await call(owner, "POST", "/workspaces/current/transfer", { userId: outsider.id }, owner.business)).toMatchObject({ status: 404 });
    expect(await call(owner, "POST", "/workspaces/current/transfer", { userId: heir.id }, owner.business)).toMatchObject({
      status: 403,
      body: { error: "email_unverified" },
    });
    expect(canCreate).not.toHaveBeenCalled();

    // Over the heir's plan: nothing changes.
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, heir.id));
    canCreate.mockRejectedValueOnce(planLimit("Your plan includes 2 workspaces", { limit: "workspaces", plan: "free" }));
    expect(await call(owner, "POST", "/workspaces/current/transfer", { userId: heir.id }, owner.business)).toMatchObject({
      status: 402,
      body: { error: "plan_limit" },
    });
    expect((await memberOf(owner.business, owner.id))?.role).toBe("owner");

    expect(await call(owner, "POST", "/workspaces/current/transfer", { userId: heir.id }, owner.business)).toMatchObject({
      status: 200,
      body: { ownerId: heir.id },
    });
    expect(canCreate).toHaveBeenLastCalledWith(heir.id);
    expect((await memberOf(owner.business, heir.id))?.role).toBe("owner");
    expect((await memberOf(owner.business, owner.id))?.role).toBe("admin");
    const owners = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, owner.business), eq(workspaceMembers.role, "owner")));
    expect(owners).toHaveLength(1);
    expect(await actions(owner.business)).toContain("workspace.ownership_transferred");
    // The former owner is an admin now: they can no longer demote the new owner.
    const heirRow = await memberOf(owner.business, heir.id);
    expect((await call(owner, "PATCH", `/workspaces/current/members/${heirRow?.id}`, { role: "viewer" }, owner.business)).status).toBe(403);
  });
});

describe("deleting a workspace", () => {
  it("is for the owner only, with the exact name, and never the last workspace", async () => {
    const owner = await person("Olivia Owner");
    const admin = await person("Adam Admin");
    await join(owner, admin, "admin");
    const [business] = await db.select().from(workspaces).where(eq(workspaces.id, owner.business));
    const name = business?.name as string;

    expect(await call(admin, "DELETE", "/workspaces/current", { confirmName: name }, owner.business)).toMatchObject({
      status: 403,
      body: { error: "owner_only" },
    });
    expect(await call(owner, "DELETE", "/workspaces/current", { confirmName: name.toUpperCase() }, owner.business)).toMatchObject({
      status: 400,
      body: { error: "confirm_name_mismatch" },
    });
    expect((await call(owner, "DELETE", "/workspaces/current", {}, owner.business)).status).toBe(400);

    const deleted = await call<{ deleted: boolean; workspaceId: string }>(owner, "DELETE", "/workspaces/current", { confirmName: name }, owner.business);
    expect(deleted).toMatchObject({ status: 200, body: { deleted: true, workspaceId: owner.personal } });
    expect(deleted.headers.get("set-cookie")).toContain(`ew_ws=${owner.personal}`);
    expect(await db.select().from(workspaces).where(eq(workspaces.id, owner.business))).toHaveLength(0);
    expect(await memberOf(owner.business, admin.id)).toBeNull();
    const [entry] = await db.select().from(platformAuditLogs).where(eq(platformAuditLogs.targetId, owner.business));
    expect(entry).toMatchObject({ action: "workspace.deleted", actorId: owner.id });
    const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, owner.id));
    expect(settings?.activeWorkspaceId).toBe(owner.personal);

    // The personal workspace is now their only one.
    const [personal] = await db.select().from(workspaces).where(eq(workspaces.id, owner.personal));
    expect(await call(owner, "DELETE", "/workspaces/current", { confirmName: personal?.name }, owner.personal)).toMatchObject({
      status: 409,
      body: { error: "last_workspace" },
    });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, owner.personal))).toHaveLength(1);
  });
});

describe("plan limits", () => {
  it("are checked before inviting, accepting and creating a workspace", async () => {
    const owner = await person("Olivia Owner");
    const guest = await person("Gita Guest");
    const addMember = vi.spyOn(entitlements, "assertCanAddMember");
    const createWorkspace = vi.spyOn(entitlements, "assertCanCreateWorkspace");

    const { token } = await invite(owner, guest.email, "member");
    expect(addMember).toHaveBeenLastCalledWith(owner.business, 1);
    // A re-invite replaces the open invitation: no extra seat.
    const again = await invite(owner, guest.email, "member");
    expect(addMember).toHaveBeenLastCalledWith(owner.business, 0);
    expect(token).not.toBe(again.token);

    // The plan shrank since: the invitation can't be accepted.
    addMember.mockRejectedValueOnce(planLimit("Your plan includes 1 member", { limit: "members", plan: "free" }));
    expect(await call(guest, "POST", "/invitations/accept", { token: again.token })).toMatchObject({ status: 402, body: { error: "plan_limit" } });
    expect(await memberOf(owner.business, guest.id)).toBeNull();
    expect(await call(guest, "POST", "/invitations/accept", { token: again.token })).toMatchObject({ status: 200 });

    addMember.mockRejectedValueOnce(planLimit("Your plan includes 1 member", { limit: "members", plan: "free" }));
    expect(await call(owner, "POST", "/workspaces/current/invitations", { email: "third@example.test", role: "viewer" }, owner.business)).toMatchObject({
      status: 402,
      body: { error: "plan_limit" },
    });
    expect(await db.select().from(workspaceInvitations).where(eq(workspaceInvitations.email, "third@example.test"))).toHaveLength(0);

    createWorkspace.mockRejectedValueOnce(planLimit("Your plan includes 2 workspaces", { limit: "workspaces", plan: "free" }));
    expect(await call(owner, "POST", "/workspaces", { name: "Side Project", kind: "business" })).toMatchObject({ status: 402, body: { error: "plan_limit" } });
    const created = await call<{ id: string }>(owner, "POST", "/workspaces", { name: "Side Project", kind: "business" });
    expect(created.status).toBe(201);
    expect(createWorkspace).toHaveBeenLastCalledWith(owner.id);
    expect((await memberOf(created.body.id, owner.id))?.role).toBe("owner");
    expect(await actions(created.body.id)).toContain("workspace.created");
  });
});
