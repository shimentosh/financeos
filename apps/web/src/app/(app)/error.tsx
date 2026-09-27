"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/client-errors";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportClientError(error, "boundary");
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-20 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
        <TriangleAlert className="size-5" />
      </span>
      <h1 className="text-lg font-semibold">This page could not load</h1>
      <p className="text-sm text-muted-foreground">
        {error.message && !error.message.includes("digest") ? error.message : "Something went wrong while reading your data."} Your records are safe.
      </p>
      <Button size="sm" onClick={retry}>
        <RotateCcw className="size-3.5" /> Try again
      </Button>
      {error.digest && <p className="text-[11px] text-muted-foreground">Reference {error.digest}</p>}
    </div>
  );
}
