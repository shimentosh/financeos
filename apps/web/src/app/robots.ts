import type { MetadataRoute } from "next";

const APP_URL = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/+$/, "");

/** Search engines may read the public site; the app and the API stay out of their index. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/welcome", "/pricing", "/terms", "/privacy", "/contact", "/sign-up", "/sign-in"], disallow: ["/api/", "/"] }],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
