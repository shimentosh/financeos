import type { Metadata } from "next";
import { cookies } from "next/headers";
import { InviteCard, InviteNotFound } from "@/components/teams/invite-card";
import type { InvitationLookup } from "@/components/teams/shared";
import { api } from "@/lib/api/server";
import { ApiError } from "@/lib/api/shared";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };
export const dynamic = "force-dynamic";

// Better Auth's session cookie (cookiePrefix "ew"; __Secure- over HTTPS).
const SESSION_COOKIES = ["ew.session_token", "__Secure-ew.session_token"];

/**
 * An emailed invitation link, open to everyone: signed out, it offers sign-in
 * or sign-up with the invited address; signed in, the right account can
 * accept. The lookup is public but shows the invited address masked.
 */
export default async function InvitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const token = (Array.isArray(params.token) ? params.token[0] : params.token)?.trim() ?? "";
  const store = await cookies();
  const signedIn = SESSION_COOKIES.some((name) => store.has(name));
  if (token.length < 20) return <InviteNotFound reason="invalid" signedIn={signedIn} />;

  let invitation: InvitationLookup;
  try {
    invitation = await api<InvitationLookup>("/invitations/lookup", { query: { token } });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return <InviteNotFound reason="invalid" signedIn={signedIn} />;
    if (error instanceof ApiError && error.status === 429) return <InviteNotFound reason="rate_limited" signedIn={signedIn} />;
    throw error;
  }
  return <InviteCard token={token} invitation={invitation} />;
}
