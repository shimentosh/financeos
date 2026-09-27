import { z } from "zod";
import type { MemberRole } from "../constants.ts";

/**
 * Workspace teams: people join by invitation only. An invitation is emailed as
 * a single-use link and can be accepted only by a signed-in person whose
 * verified email is the one invited, so nobody can claim a seat by registering
 * an address first.
 */
export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Roles an invitation or a role change can give; ownership moves only by transfer. */
export const ASSIGNABLE_ROLES = ["admin", "member", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const INVITATION_TTL_DAYS = 7;

export const invitationInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  role: z.enum(ASSIGNABLE_ROLES).default("member"),
});
export type InvitationInput = z.input<typeof invitationInput>;

export const memberRoleInput = z.object({ role: z.enum(ASSIGNABLE_ROLES) });
export const acceptInvitationInput = z.object({ token: z.string().min(20).max(200) });
export const invitationLookupQuery = z.object({ token: z.string().min(20).max(200) });
/** Resending an invitation issues a new link; `sendEmail: false` only returns it (to copy and share another way). */
export const resendInvitationInput = z.object({ sendEmail: z.boolean().default(true) });
export const transferOwnershipInput = z.object({ userId: z.string().min(1).max(64) });
/** Deleting a workspace: type its name to confirm. */
export const deleteWorkspaceInput = z.object({ confirmName: z.string().trim().min(1).max(120) });

/**
 * The roles `actor` may give by invitation or role change. The owner may make
 * admins; admins may add and adjust members and viewers only.
 */
export function assignableRolesFor(actor: MemberRole): AssignableRole[] {
  if (actor === "owner") return ["admin", "member", "viewer"];
  if (actor === "admin") return ["member", "viewer"];
  return [];
}

/**
 * Whether `actor` may change the role of, or remove, someone else whose role
 * is `target`. Nobody manages the owner (ownership moves only by transfer),
 * and admins cannot manage other admins. Acting on yourself is a separate
 * rule: you cannot change your own role, and you leave rather than remove.
 */
export function canManageMember(actor: MemberRole, target: MemberRole): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "admin") return target === "member" || target === "viewer";
  return false;
}

/** What each role can do, in one line, for invitations and member lists. */
export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: "Owns the workspace: billing, deleting it and handing it over.",
  admin: "Manages settings, people and every record.",
  member: "Adds and edits records.",
  viewer: "Sees everything, changes nothing.",
};
