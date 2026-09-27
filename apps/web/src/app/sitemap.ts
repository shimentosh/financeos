import type { MetadataRoute } from "next";

const APP_URL = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/+$/, "");

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    { path: "/welcome", priority: 1 },
    { path: "/pricing", priority: 0.9 },
    { path: "/contact", priority: 0.5 },
    { path: "/terms", priority: 0.3 },
    { path: "/privacy", priority: 0.3 },
  ];
  return pages.map((page) => ({ url: `${APP_URL}${page.path}`, changeFrequency: "monthly", priority: page.priority }));
}
