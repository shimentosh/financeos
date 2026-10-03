import { resolve } from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// One .env at the monorepo root, shared with the API.
config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const apiUrl = (process.env.API_INTERNAL_URL ?? "http://localhost:4100").replace(/\/+$/, "");
const isProduction = process.env.NODE_ENV === "production";

// Production only: `next dev` needs eval for Fast Refresh. Next's own inline
// scripts (hydration data, the theme script in layout.tsx) need
// 'unsafe-inline'; fonts are self-hosted (@fontsource), files and images come
// from this origin's /api, capture previews are blob: URLs.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera for scanning receipts, microphone for voice entry.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=()" },
  ...(isProduction
    ? [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Next allows one dev server per build directory; a second instance (other
  // ports) sets NEXT_DIST_DIR to build somewhere else.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // A self-contained server (`node apps/web/server.js`) for the Docker image;
  // tracing starts at the monorepo root so workspace packages are included.
  output: "standalone",
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@financeos/core"],
  env: {
    API_INTERNAL_URL: apiUrl,
  },
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
  // The browser only ever talks to this origin: /api/* is proxied to the
  // NestJS API, so Better Auth's session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
