import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { authAccounts, authRateLimits, sessions, twoFactors, userSettings, users, verifications } from "../db/schema/index.js";
import { env, requireEmailVerification } from "../env.js";
import { appLink, type EmailMessage, sendEmail } from "../modules/system/email.service.js";
import { PlatformAuditService } from "../modules/system/platform-audit.service.js";
import { provisionUser } from "../modules/workspaces/provisioning.js";

/** What the sign-in and sign-up pages should offer; served by GET /api/auth-options. */
export const authFeatures = {
  signUpEnabled: env.ALLOW_SIGN_UP,
  googleEnabled: Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()),
  emailVerificationRequired: requireEmailVerification,
} as const;

/** Every email Better Auth sends goes through here, so tests can capture them. */
export const authMail = { send: (message: EmailMessage) => sendEmail(message) };

const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;
const RESET_TTL_SECONDS = 60 * 60;

const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "there";
const isSafePath = (path: string | null | undefined): path is string => Boolean(path?.startsWith("/") && !path.startsWith("//"));

/** The claims of a Better Auth email token (a JWT): which kind of link it is. */
function tokenClaims(token: string): { email?: string; updateTo?: string; requestType?: string } {
  try {
    const payload = token.split(".")[1];
    return payload ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Better Auth's email links verify at /api/auth/verify-email and then redirect
 * to their callbackURL. Every link lands on our /verify-email page with a
 * status saying what happened; where the person was headed is kept as `next`.
 * On failure Better Auth appends `error=` to the same URL.
 */
function landOn(url: string, status: "verified" | "change-confirmed" | "email-changed") {
  const link = new URL(url);
  const original = link.searchParams.get("callbackURL");
  // A second link in a chain (change email) already points at our page: keep its `next`.
  const next = original?.startsWith("/verify-email") ? new URL(original, env.APP_URL).searchParams.get("next") : original;
  const target = new URLSearchParams({ status });
  if (isSafePath(next) && next !== "/") target.set("next", next);
  link.searchParams.set("callbackURL", `/verify-email?${target.toString()}`);
  return link.toString();
}

function clientIp(headers: Headers | undefined | null): string | null {
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers?.get("x-real-ip") || null;
}

// Platform admin actions taken through Better Auth's admin plugin, recorded in
// the platform audit log after they succeed.
const ADMIN_ACTIONS: Record<string, string> = {
  "/admin/ban-user": "user.banned",
  "/admin/unban-user": "user.unbanned",
  "/admin/set-role": "user.role_changed",
  "/admin/impersonate-user": "user.impersonated",
  "/admin/stop-impersonating": "user.impersonation_stopped",
  "/admin/revoke-user-sessions": "user.sessions_revoked",
  "/admin/revoke-user-session": "user.session_revoked",
  "/admin/remove-user": "user.removed",
  "/admin/set-user-password": "user.password_set",
  "/admin/update-user": "user.updated",
  "/admin/create-user": "user.created",
};

const platformAudit = new PlatformAuditService();

type SessionLike = { user: { id: string; email: string }; session: { impersonatedBy?: string | null } } | null | undefined;

async function recordAdminAction(input: {
  path: string;
  body: Record<string, unknown> | undefined;
  session: SessionLike;
  returned: unknown;
  headers: Headers | undefined | null;
}) {
  const action = ADMIN_ACTIONS[input.path];
  if (!action || !input.returned || input.returned instanceof Error) return;
  const body = input.body ?? {};
  const returnedUser = (input.returned as { user?: { id?: string; email?: string } }).user;
  let actorId = input.session?.user.id ?? null;
  let actorEmail = input.session?.user.email ?? null;
  let targetId = typeof body.userId === "string" ? body.userId : (returnedUser?.id ?? null);
  if (input.path === "/admin/stop-impersonating") {
    // The session here is the impersonation one: its user is the target, the admin is the actor.
    targetId = input.session?.user.id ?? null;
    actorId = input.session?.session.impersonatedBy ?? returnedUser?.id ?? null;
    actorEmail = returnedUser?.email ?? null;
  }
  const details: Record<string, unknown> = {};
  if (input.path === "/admin/ban-user") Object.assign(details, { reason: body.banReason ?? null, expiresInSeconds: body.banExpiresIn ?? null });
  if (input.path === "/admin/set-role") details.role = body.role;
  if (input.path === "/admin/update-user" && body.data && typeof body.data === "object") details.fields = Object.keys(body.data);
  if (input.path === "/admin/create-user") details.role = body.role ?? "user";
  if (targetId && input.path !== "/admin/remove-user") {
    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetId));
    if (target) details.targetEmail = target.email;
  }
  try {
    await platformAudit.record({ actorId, actorEmail, action, targetType: "user", targetId, details, ip: clientIp(input.headers) });
  } catch (error) {
    // The action already happened; a missing audit row must not turn it into an error.
    console.error(`Could not record platform audit "${action}":`, error);
  }
}

/** New accounts see the first-run setup; accounts from before it existed are never sent there. */
async function markOnboardingPending(userId: string) {
  await db
    .update(userSettings)
    .set({ preferences: sql`${userSettings.preferences} || '{"onboarded": false}'::jsonb` })
    .where(eq(userSettings.userId, userId));
}

/**
 * Better Auth runs inside the Nest process at /api/auth/*. The web app proxies
 * /api to this server, so the session cookie is first-party on the app origin.
 */
export const auth = betterAuth({
  appName: "FinanceOS",
  baseURL: env.APP_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: authAccounts,
      verification: verifications,
      twoFactor: twoFactors,
      rateLimit: authRateLimits,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // With verification required Better Auth skips this: sign-up ends at "check your email".
    autoSignIn: true,
    disableSignUp: !env.ALLOW_SIGN_UP,
    requireEmailVerification,
    resetPasswordTokenExpiresIn: RESET_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, token }) => {
      await authMail.send({
        to: user.email,
        subject: "Reset your FinanceOS password",
        preview: "Choose a new password for your account.",
        heading: "Reset your password",
        paragraphs: [
          `Hi ${firstName(user.name)},`,
          "We got a request to reset the password of your FinanceOS account. Choose a new one with the button below.",
        ],
        action: { label: "Choose a new password", url: appLink(`/reset-password?token=${encodeURIComponent(token)}`) },
        footnote: "This link works once and expires in 1 hour. If you did not ask for a reset, ignore this email: your password stays the same.",
      });
    },
    onPasswordReset: async ({ user }) => {
      await authMail.send({
        to: user.email,
        subject: "Your FinanceOS password was changed",
        heading: "Your password was changed",
        paragraphs: [
          `Hi ${firstName(user.name)},`,
          "The password of your FinanceOS account was just reset, and every device was signed out.",
          "If this was not you, reset your password again right away and tell us.",
        ],
        action: { label: "Sign in", url: appLink("/sign-in") },
        ...(env.SUPPORT_EMAIL ? { footnote: `Questions? Write to ${env.SUPPORT_EMAIL}.` } : {}),
      });
    },
    onExistingUserSignUp: async ({ user }) => {
      await authMail.send({
        to: user.email,
        subject: "You already have an FinanceOS account",
        heading: "You already have an account",
        paragraphs: [
          "Someone tried to create an FinanceOS account with this email address, but it already has one.",
          "If that was you, sign in instead, or reset your password if you have forgotten it.",
        ],
        action: { label: "Sign in", url: appLink("/sign-in") },
        footnote: "If this was not you, you can ignore this email. Nothing has changed.",
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: VERIFICATION_TTL_SECONDS,
    sendVerificationEmail: async ({ user, url, token }) => {
      const claims = tokenClaims(token);
      if (claims.updateTo && claims.requestType === "change-email-verification") {
        await authMail.send({
          to: claims.updateTo,
          subject: "Confirm your new email address",
          heading: "Confirm your new email address",
          paragraphs: [`Confirm ${claims.updateTo} as the new sign-in address of your FinanceOS account.`],
          action: { label: "Confirm new email", url: landOn(url, "email-changed") },
          footnote: "This link expires in 24 hours. Until you confirm, you keep signing in with your current address.",
        });
        return;
      }
      await authMail.send({
        to: user.email,
        subject: "Verify your email for FinanceOS",
        preview: "One click to finish setting up your account.",
        heading: "Confirm your email address",
        paragraphs: [`Hi ${firstName(user.name)},`, "Confirm this is your email address to finish setting up FinanceOS."],
        action: { label: "Verify email", url: landOn(url, "verified") },
        footnote: "This link expires in 24 hours. If you did not create an FinanceOS account, you can ignore this email.",
      });
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      // A verified address approves the change first; the new address then confirms it.
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
        await authMail.send({
          to: user.email,
          subject: "Approve your email change",
          heading: "Approve your email change",
          paragraphs: [
            `Hi ${firstName(user.name)},`,
            "Someone, hopefully you, asked to change the sign-in email of your FinanceOS account. If this was you, approve it below and we will send a last link to the new address.",
          ],
          details: [
            { label: "Current email", value: user.email },
            { label: "New email", value: newEmail },
          ],
          action: { label: "Approve the change", url: landOn(url, "change-confirmed") },
          footnote: "If you did not ask for this, ignore this email and consider changing your password. Your email stays the same.",
        });
      },
    },
  },
  socialProviders: authFeatures.googleEnabled
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID as string,
          clientSecret: env.GOOGLE_CLIENT_SECRET as string,
          disableSignUp: !env.ALLOW_SIGN_UP,
        },
      }
    : {},
  session: {
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },
  rateLimit: {
    enabled: true,
    // Shared by every API instance, not per process.
    storage: "database",
    modelName: "rateLimit",
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 15 * 60, max: 5 },
      "/forget-password": { window: 15 * 60, max: 5 },
      "/reset-password": { window: 15 * 60, max: 10 },
      "/send-verification-email": { window: 5 * 60, max: 3 },
      "/change-email": { window: 15 * 60, max: 5 },
      "/two-factor/*": { window: 60, max: 6 },
    },
  },
  advanced: {
    cookiePrefix: "ew",
    useSecureCookies: env.NODE_ENV === "production",
  },
  plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), twoFactor({ issuer: "FinanceOS" })],
  hooks: {
    // Deleting a user must also stop their paid plan and delete the workspaces they own alone:
    // that happens in DELETE /api/admin/users/:id, not in the plugin's bare delete.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/admin/remove-user") {
        throw new APIError("FORBIDDEN", {
          message: "Delete users from Admin → Users (DELETE /api/admin/users/:id), which also cleans up their workspaces and plan.",
        });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (!ADMIN_ACTIONS[ctx.path]) return;
      await recordAdminAction({
        path: ctx.path,
        body: ctx.body as Record<string, unknown> | undefined,
        session: ctx.context.session as SessionLike,
        returned: ctx.context.returned,
        headers: ctx.headers ?? ctx.request?.headers,
      });
    }),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await provisionUser({ id: user.id, email: user.email, name: user.name });
          await markOnboardingPending(user.id);
        },
      },
    },
  },
});

export type Auth = typeof auth;
