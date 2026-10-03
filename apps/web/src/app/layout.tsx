import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeScript } from "./theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FinanceOS", template: "%s · FinanceOS" },
  description: "Your personal and business finances in one place: capture, connect, understand, act.",
  applicationName: "FinanceOS",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <ToastProvider position="bottom-right">{children}</ToastProvider>
      </body>
    </html>
  );
}
