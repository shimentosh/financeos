"use client";

import { formatDay } from "@expensewise/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { RANGE_PRESETS } from "./presets";

type RangeSelectProps = {
  preset: string;
  fallback: string;
  range: { from: string | null; to: string };
};

/** Chooses the reporting range through `?preset=`; `fallback` is the page's default. */
export function RangeSelect(props: RangeSelectProps) {
  return (
    <Suspense>
      <LiveRangeSelect {...props} />
    </Suspense>
  );
}

function LiveRangeSelect({ preset, fallback, range }: RangeSelectProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const label = RANGE_PRESETS.find((p) => p.value === preset)?.label ?? "Custom";
  const choose = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete("from");
    next.delete("to");
    if (value === fallback) next.delete("preset");
    else next.set("preset", value);
    startTransition(() =>
      router.push(`${pathname}${next.size ? `?${next}` : ""}`, {
        scroll: false,
      }),
    );
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", pending && "opacity-60")}>
      <Select value={preset} onValueChange={(v) => typeof v === "string" && choose(v)}>
        <SelectTrigger size="sm" className="w-40">
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">
        {range.from ? `${formatDay(range.from)} – ${formatDay(range.to)}` : `Everything up to ${formatDay(range.to)}`}
      </span>
    </div>
  );
}
