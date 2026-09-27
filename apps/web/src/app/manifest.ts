import type { MetadataRoute } from "next";

/** Lets people add Expense Wise to their phone's home screen and open it like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Expense Wise",
    short_name: "Expense Wise",
    description: "Personal and business money in one ledger.",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#0a0a0a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
