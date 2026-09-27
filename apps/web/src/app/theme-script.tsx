"use client";

// Applies the saved theme before the first paint, so dark mode never flashes.
const themeScript = `(() => {
  try {
    const saved = localStorage.getItem("ew-theme");
    const dark = saved === "dark" || ((!saved || saved === "system") && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;

// A Client Component so `typeof window` really differs: the server HTML gets an executable
// script, while a client render (e.g. error recovery) makes an inert text/plain data block,
// which React doesn't warn about.
export function ThemeScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static, first-paint theme script
      dangerouslySetInnerHTML={{ __html: themeScript }}
    />
  );
}
