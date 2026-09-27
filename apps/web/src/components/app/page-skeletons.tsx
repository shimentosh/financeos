import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/**
 * Loading states shaped like the pages they stand in for, so the layout
 * doesn't jump when the data arrives: a header strip, then the page's own
 * shape (a table, a detail view, a grid of cards, a settings form, a chat).
 */
function Frame({ children, width = "default" }: { children: ReactNode; width?: "default" | "wide" }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label="Loading">
      <div className="hidden h-10 shrink-0 items-center gap-2 border-border border-b bg-card px-3 md:flex">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className={cn("mx-auto flex w-full flex-col gap-4 p-4 md:p-6", width === "wide" ? "max-w-7xl" : "max-w-5xl")}>{children}</div>
    </div>
  );
}

const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function StatRow({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {KEYS.slice(0, count).map((key) => (
        <Skeleton key={key} className="h-[5.5rem] rounded-xl" />
      ))}
    </div>
  );
}

/** Transactions, accounts, commitments: a toolbar and rows. */
export function ListPageSkeleton({ stats = true }: { stats?: boolean }) {
  return (
    <Frame width="wide">
      <div className="flex items-end justify-between gap-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>
      {stats && <StatRow />}
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-56 rounded-lg" />
        <Skeleton className="h-8 w-36 rounded-lg" />
        <Skeleton className="h-8 w-36 rounded-lg" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        {KEYS.map((key) => (
          <div key={key} className="flex items-center gap-3 border-border border-b px-3 py-3 last:border-b-0">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/5" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** One record: its headline figure, a few stats and its sections. */
export function DetailPageSkeleton() {
  return (
    <Frame>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-4 w-40" />
      </div>
      <StatRow />
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <Skeleton className="h-48 rounded-xl" />
    </Frame>
  );
}

/** Goals, subscriptions, wealth: summary tiles and a grid of cards. */
export function CardsPageSkeleton() {
  return (
    <Frame width="wide">
      <div className="flex items-end justify-between gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-8 w-32 rounded-lg" />
      </div>
      <StatRow />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {KEYS.slice(0, 6).map((key) => (
          <Skeleton key={key} className="h-44 rounded-xl" />
        ))}
      </div>
    </Frame>
  );
}

/** Settings and integration screens: the menu beside stacked sections. */
export function SettingsPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true" aria-label="Loading">
      <div className="hidden h-10 shrink-0 items-center gap-2 border-border border-b bg-card px-3 md:flex">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col md:flex-row">
        <div className="hidden w-56 shrink-0 space-y-2 border-border border-r p-4 md:block">
          {KEYS.map((key) => (
            <Skeleton key={key} className="h-7 w-full rounded-md" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** The copilot: the conversation list beside the chat. */
export function ChatPageSkeleton() {
  return (
    <Frame width="wide">
      <div className="flex min-h-[calc(100dvh-10rem)] gap-6">
        <div className="hidden w-60 shrink-0 space-y-2 lg:block">
          <Skeleton className="h-9 w-full rounded-lg" />
          {KEYS.slice(0, 5).map((key) => (
            <Skeleton key={key} className="h-11 w-full rounded-lg" />
          ))}
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4">
          <Skeleton className="size-12 rounded-2xl" />
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
            {KEYS.slice(0, 4).map((key) => (
              <Skeleton key={key} className="h-12 rounded-xl" />
            ))}
          </div>
          <Skeleton className="mt-auto h-11 w-full rounded-lg" />
        </div>
      </div>
    </Frame>
  );
}
