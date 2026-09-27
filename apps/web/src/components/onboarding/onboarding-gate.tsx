"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * Until first-run setup is done, every app page leads to /onboarding, which
 * renders on its own (no sidebar). The layout decides whether setup is
 * pending; this only knows the current path.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const onSetup = pathname === "/onboarding";

  useEffect(() => {
    if (!onSetup) router.replace("/onboarding");
  }, [onSetup, router]);

  if (!onSetup) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-sidebar" role="status" aria-label="Opening setup">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  return children;
}
