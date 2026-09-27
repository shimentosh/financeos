"use client";

import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Printer, Scale, Sparkles, Trash2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app/app-context";
import { CategoryTile, Delta, EmptyNote, ProgressBar, Section, StatCard } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { clientApi, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { formatDateTime, formatDay } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { Report } from "./types";

const pct = (current: number, previous: number) => (previous ? Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10 : null);

export function ReportDetail({ report }: { report: Report }) {
  const { money, isBusiness } = useApp();
  const router = useRouter();
  const d = report.data;

  const remove = async () => {
    try {
      await clientApi(`/reports/${report.id}`, { method: "DELETE" });
      router.push("/reports?tab=saved");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{report.title}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDay(d.range.from)} – {formatDay(d.range.to)} · generated {formatDateTime(report.createdAt)}
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Printer className="size-3.5" /> Print / PDF
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void remove()}>
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </div>
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="size-3.5" />
          {report.narrativeSource === "ai" ? `Summary written by ${report.model ?? "AI"} from the figures below` : "Summary generated from the figures below"}
        </p>
        <p className="whitespace-pre-line text-sm leading-relaxed">{report.narrative}</p>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={ArrowDownLeft}
          label={isBusiness ? "Revenue" : "Income"}
          value={money(d.income)}
          hint={<Delta value={pct(d.income, d.previous.income)} />}
          href={d.links.income}
        />
        <StatCard
          icon={ArrowUpRight}
          label="Spending"
          value={money(d.expenses)}
          hint={<Delta value={pct(d.expenses, d.previous.expenses)} goodWhen="down" />}
          href={d.links.expenses}
        />
        <StatCard
          icon={TrendingUp}
          label="Net"
          value={money(d.net, undefined, { signed: true })}
          hint={d.rate !== null ? `${d.rate}% ${isBusiness ? "margin" : "saved"}` : undefined}
          tone={d.net < 0 ? "danger" : "good"}
          href={d.links.all}
        />
        <StatCard
          icon={Scale}
          label="Net worth"
          value={d.netWorth ? money(d.netWorth.value, undefined, { compact: true }) : "—"}
          hint={d.netWorth ? d.netWorth.complete ? <Delta value={d.netWorth.changePct} /> : "Some items could not be valued" : "Not tracked yet"}
          href="/wealth/net-worth"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Spending by category" href={d.links.expenses}>
          {d.categories.length ? (
            <ul className="space-y-1">
              {d.categories.map((c) => (
                <li key={c.categoryId ?? "none"}>
                  <Link href={c.href} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/60">
                    <CategoryTile icon={c.icon} color={c.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex justify-between gap-2 text-sm">
                        <span className="truncate">{c.name}</span>
                        <span className="tabular-nums">{money(c.amount)}</span>
                      </span>
                      <ProgressBar value={c.share} className="mt-1 h-1" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyNote>No spending in this period.</EmptyNote>
          )}
        </Section>
        <div className="space-y-4">
          <Section title="Biggest changes" hint="Against the previous period">
            {d.categoryChanges.length ? (
              <ul className="divide-y divide-border">
                {d.categoryChanges.map((c) => (
                  <li key={c.name}>
                    <Link href={c.href} className="flex items-center justify-between gap-3 py-2 hover:opacity-80">
                      <span className="text-sm">{c.name}</span>
                      <span className="text-right">
                        <span className={cn("block text-sm tabular-nums", c.change > 0 ? "text-red-600 dark:text-red-400" : "text-money-in")}>
                          {money(c.change, undefined, { signed: true })}
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {money(c.previous)} → {money(c.current)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyNote>No comparable spending in the previous period.</EmptyNote>
            )}
          </Section>
          <Section title="Cash">
            <p className="text-sm">
              Cash accounts went from <span className="font-medium tabular-nums">{money(d.cashFlow.opening)}</span> to{" "}
              <span className="font-medium tabular-nums">{money(d.cashFlow.closing)}</span>.
            </p>
            <p className="text-xs text-muted-foreground">
              {d.recurringCount} active commitments ≈ {money(d.recurringMonthly)} a month · owed to you {money(d.receivables.outstanding)} · you owe{" "}
              {money(d.payables.outstanding)}
            </p>
          </Section>
        </div>
      </div>

      {d.anomalies.length > 0 && (
        <Section title="Flagged">
          <ul className="space-y-2">
            {d.anomalies.map((a) => (
              <li key={a.title} className="flex gap-2.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <span>
                  <span className="font-medium">{a.title}</span>
                  {a.body && <span className="block text-xs text-muted-foreground">{a.body}</span>}
                  {a.href && (
                    <Link href={a.href} className="text-xs underline-offset-4 hover:underline">
                      View transactions
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {isBusiness && d.projects.length > 0 && (
        <Section title="Projects" href="/business/projects">
          <ul className="divide-y divide-border">
            {d.projects.map((p) => (
              <li key={p.id}>
                <Link href={p.href} className="flex items-center justify-between gap-3 py-2 hover:opacity-80">
                  <span className="text-sm">{p.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {money(p.revenue)} in · {money(p.cost)} out ·{" "}
                    <span className={p.net >= 0 ? "text-money-in" : "text-red-600"}>{money(p.net, undefined, { signed: true })}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
