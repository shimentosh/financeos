"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function InviteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-4">
      <span className="flex size-10 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
        <TriangleAlert className="size-5" />
      </span>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">We couldn't open this invitation</h1>
        <p className="text-sm text-muted-foreground">Something went wrong on our side. The invitation itself is fine; try again in a moment.</p>
      </div>
      <Button className="w-full" onClick={reset}>
        <RotateCcw className="size-3.5" /> Try again
      </Button>
      {error.digest && <p className="text-center text-[11px] text-muted-foreground">Reference {error.digest}</p>}
    </div>
  );
}
