import { type NextRequest, NextResponse } from "next/server";

// For signed-out visitors only: someone signed in goes straight to the app.
const AUTH_PATHS = ["/sign-in", "/sign-up", "/forgot-password"];
// Open to everyone, signed in or not: the public site and links from emails.
const OPEN_PATHS = ["/welcome", "/pricing", "/terms", "/privacy", "/contact", "/reset-password", "/verify-email", "/two-factor", "/invite"];

const matches = (pathname: string, paths: string[]) => paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
// Better Auth's session cookie (cookiePrefix "ew"; __Secure- over HTTPS).
const SESSION_COOKIES = ["ew.session_token", "__Secure-ew.session_token"];
// Its signed session cache (cookieCache), cleared together with the token.
const SESSION_CACHE_COOKIES = ["ew.session_data", "__Secure-ew.session_data"];

/**
 * An optimistic check only: no session cookie means sign in first. The API
 * verifies the session on every request, so a forged cookie gets nothing.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthPage = matches(pathname, AUTH_PATHS);
  const isOpen = matches(pathname, OPEN_PATHS);
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));

  // The API rejected the session (expired, revoked, deleted) and sent us here
  // with ?expired. Drop the dead cookies, or the redirect to "/" below would
  // bounce straight back to a 401 and loop.
  if (isAuthPage && request.nextUrl.searchParams.has("expired")) {
    const url = request.nextUrl.clone();
    url.searchParams.delete("expired");
    const response = NextResponse.redirect(url);
    for (const name of [...SESSION_COOKIES, ...SESSION_CACHE_COOKIES]) {
      response.cookies.set(name, "", { path: "/", maxAge: 0, secure: name.startsWith("__Secure-") });
    }
    return response;
  }
  if (isOpen) return NextResponse.next();
  // Signed-out visitors to the home page see the public site.
  if (!hasSession && pathname === "/") return NextResponse.rewrite(new URL("/welcome", request.url));
  if (!hasSession && !isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  if (hasSession && isAuthPage) {
    // Already signed in: carry on to where the link was going (an invitation, say), if it stays on this site.
    const next = request.nextUrl.searchParams.get("next");
    const safe = next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
    return NextResponse.redirect(new URL(safe, request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except the API proxy, Next internals and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|robots.txt|sitemap.xml|.*\\.(?:png|jpg|svg|webp|ico)$).*)"],
};
