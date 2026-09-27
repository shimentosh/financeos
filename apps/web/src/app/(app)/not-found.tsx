import { Compass } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-20 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Compass className="size-5" />
      </span>
      <h1 className="text-lg font-semibold">Nothing here</h1>
      <p className="text-sm text-muted-foreground">This page does not exist, or the record belongs to another workspace.</p>
      <Button size="sm" render={<Link href="/" />}>
        Back to overview
      </Button>
    </div>
  );
}
