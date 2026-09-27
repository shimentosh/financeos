"use client";

import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth's client. It talks to /api/auth on this origin, which Next
 * proxies to the NestJS API — so the session cookie is first-party.
 * A sign-in that needs a second factor returns `twoFactorRedirect`; the
 * sign-in form sends the person to /two-factor itself.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? (process.env.APP_URL ?? "http://localhost:3100") : window.location.origin,
  basePath: "/api/auth",
  plugins: [adminClient(), twoFactorClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;

/** What the sign-in pages offer on this installation (GET /api/auth-options). */
export type AuthOptions = { signUpEnabled: boolean; googleEnabled: boolean; emailVerificationRequired: boolean };

/** A same-site path to continue to after signing in; anything else becomes "/". */
export function safeNext(next: string | null | undefined): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
