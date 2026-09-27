import { Spinner } from "@/components/ui/spinner";

export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-sidebar" role="status" aria-label="Loading">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}
