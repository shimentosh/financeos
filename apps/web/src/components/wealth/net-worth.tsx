"use client";

import { formatDay, formatMoney } from "@financeos/core";
import { ArrowRight, Car, ChartLine, CircleAlert, CircleCheck, HandCoins, Landmark, Plus, Scale, Wallet } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Delta, EmptyState, ProgressBar, Section } from "@/components/app/blocks";
import { SERIES, TrendChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import type { NetWorthCurrent, NetWorthHistory, NetWorthWarning } from "@/lib/api/types/wealth";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format-client";
import { ASSET_KIND_LABELS, INVESTMENT_KIND_LABELS, LIABILITY_KIND_LABELS } from "./shared";

/** Where to fix each warning: the record behind it, or the currency settings. */
function fixFor(warning: NetWorthWarning, current: NetWorthCurrent): { href: string; label: string } {
  const { components } = current;
  const id = warning.entityId;
  if (warning.code === "no_accounts") return { href: "/accounts", label: "Add an account" };
  if (warning.code === "missing_rate") return { href: "/settings/currency", label: "Add an exchange rate" };
  if (id && components.investments.some((i) => i.id === id))
    return {
      href: `/wealth/investments/${id}`,
      label: warning.code === "stale_valuation" ? "Update its value" : "Record a value",
    };
  if (id && components.assets.some((a) => a.id === id)) return { href: `/wealth/assets/${id}`, label: "Update its value" };
  if (id && components.accounts.some((a) => a.id === id)) return { href: `/accounts/${id}`, label: "Open account" };
  return { href: "/wealth/investments", label: "Review" };
}

function Row({
  href,
  label,
  hint,
  value,
  share,
  tone,
}: {
  href: string;
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  share: number;
  tone?: "good" | "danger";
}) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/60">
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm">{label}</span>
            <span className="shrink-0 text-sm tabular-nums">{value}</span>
          </span>
          <span className="mt-1 flex items-center gap-2">
            <ProgressBar value={share} tone={tone} className="h-1" />
            <span className="w-24 shrink-0 truncate text-right text-[11px] text-muted-foreground">{hint}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}

export function NetWorthView({ current, history }: { current: NetWorthCurrent; history: NetWorthHistory }) {
  const { money, locale, canWrite } = useApp();
  const [showAll, setShowAll] = useState(false);
  const { assets, liabilities, components } = current;
  const compact = (v: number) => formatMoney(v, current.currency, { locale, compact: true });

  const empty =
    !components.accounts.some((a) => a.balance !== 0) &&
    !components.assets.length &&
    !components.investments.length &&
    !components.receivables.length &&
    !components.liabilities.length;

  if (empty) {
    return (
      <EmptyState
        icon={Scale}
        title="Your net worth starts with what you have"
        description="Add your accounts with their balances, then what you own and owe. Net worth is everything you own minus everything you owe — and it says so when something cannot be valued."
        action={
          canWrite ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" render={<Link href="/accounts" />}>
                <Wallet className="size-3.5" /> Add accounts
              </Button>
              <Button size="sm" variant="outline" render={<Link href="/wealth/assets?new=1" />}>
                <Car className="size-3.5" /> Add an asset
              </Button>
              <Button size="sm" variant="outline" render={<Link href="/wealth/investments?new=1" />}>
                <ChartLine className="size-3.5" /> Add an investment
              </Button>
            </div>
          ) : undefined
        }
      />
    );
  }

  const blocking = current.warnings.filter((w) => w.code === "missing_rate" || w.code === "no_valuation");
  const advisory = current.warnings.filter((w) => w.code !== "missing_rate" && w.code !== "no_valuation");
  const incompleteMonths = history.points.filter((p) => !p.complete).length;
  const ownTotal = Math.max(1, assets.total);
  const oweTotal = Math.max(1, liabilities.total);
  const accountsWithDebt = components.accounts.filter((a) => (a.baseBalance ?? 0) < 0);
  const shown = showAll ? current.warnings : current.warnings.slice(0, 4);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              Net worth · {formatDay(current.asOf)}
              {current.complete ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CircleCheck className="size-3" /> complete
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <CircleAlert className="size-3" /> incomplete
                </span>
              )}
            </p>
            <p className={cn("mt-1 text-3xl font-semibold tabular-nums", current.netWorth < 0 && "text-red-600 dark:text-red-400")}>
              {money(current.netWorth)}
            </p>
            {current.change !== null && current.previous !== null ? (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <span className={cn("tabular-nums", current.change > 0 ? "text-money-in" : current.change < 0 && "text-red-600 dark:text-red-400")}>
                  {money(current.change, undefined, { signed: true })}
                </span>
                <Delta value={current.changePercent} />
                <span className="text-xs text-muted-foreground">
                  since {formatMonth(current.previousMonth.month)} ({money(current.previous)})
                </span>
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Nothing was tracked at the end of last month, so there is no change to show yet.</p>
            )}
            {!current.complete && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Some holdings are left out or counted at cost. The figure is lower-bound until they are fixed below.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">You own</p>
              <p className="font-semibold tabular-nums">{money(assets.total)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">You owe</p>
              <p className="font-semibold tabular-nums">{money(liabilities.total)}</p>
            </div>
          </div>
        </div>

        <Section
          title="Net worth over time"
          hint={`Month-end values, last ${history.points.length} months${incompleteMonths ? ` · ${incompleteMonths} incomplete` : ""}`}
        >
          <TrendChart
            data={history.points.map((p) => ({
              label: p.month,
              netWorth: p.netWorth,
            }))}
            series={[{ key: "netWorth", label: "Net worth", color: SERIES.primary }]}
            format={(v) => money(v)}
            axisFormat={compact}
            tickFormat={(label) => formatMonth(label, "en-GB", true).split(" ")[0] ?? label}
            labelFormat={(label) => formatMonth(label)}
            height={200}
            zeroLine
          />
        </Section>
      </div>

      {current.warnings.length > 0 && (
        <section
          className={cn("space-y-2 rounded-xl border p-4", blocking.length ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card")}
          aria-label="What is missing"
        >
          <div className="flex items-center gap-2">
            <CircleAlert className={cn("size-4", blocking.length ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
            <h2 className="text-sm font-semibold">
              {blocking.length ? `${blocking.length} ${blocking.length === 1 ? "item needs" : "items need"} attention before this is complete` : "Worth a look"}
            </h2>
          </div>
          <ul className="divide-y divide-border/60">
            {shown.map((warning, index) => {
              const fix = fixFor(warning, current);
              return (
                <li key={`${warning.code}-${warning.entityId ?? index}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 text-sm">
                    {warning.message}
                    {advisory.includes(warning) && <span className="ms-1 text-xs text-muted-foreground">(still counted)</span>}
                  </span>
                  <Link href={fix.href} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium hover:underline underline-offset-4">
                    {fix.label} <ArrowRight className="size-3" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {current.warnings.length > 4 && (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${current.warnings.length}`}
            </button>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="What you own" hint={money(assets.total)}>
          <ul className="space-y-1">
            <Row
              href="/accounts"
              label="Cash in accounts"
              value={money(assets.cash)}
              share={(assets.cash / ownTotal) * 100}
              hint={`${components.accounts.length} accounts`}
              tone="good"
            />
            <Row
              href="/wealth/investments"
              label="Investments"
              value={money(assets.investments)}
              share={(assets.investments / ownTotal) * 100}
              hint={`${components.investments.length} holdings`}
              tone="good"
            />
            <Row
              href="/wealth/assets"
              label="Assets"
              value={money(assets.assets)}
              share={(assets.assets / ownTotal) * 100}
              hint={`${components.assets.length} items`}
              tone="good"
            />
            <Row
              href="/wealth/receivables"
              label="Owed to you"
              value={money(assets.receivables)}
              share={(assets.receivables / ownTotal) * 100}
              hint={`${components.receivables.length} open`}
              tone="good"
            />
          </ul>
        </Section>
        <Section title="What you owe" hint={money(liabilities.total)}>
          {liabilities.total === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Nothing owed. Debts, bills and overdrawn accounts would show here.</p>
          ) : (
            <ul className="space-y-1">
              {Object.entries(liabilities.byKind)
                .filter(([, value]) => (value ?? 0) > 0)
                .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                .map(([kind, value]) => (
                  <Row
                    key={kind}
                    href={kind === "accounts" ? "/accounts" : "/wealth/liabilities"}
                    label={kind === "accounts" ? "Cards and overdrawn accounts" : (LIABILITY_KIND_LABELS[kind] ?? kind)}
                    value={money(value ?? 0)}
                    share={((value ?? 0) / oweTotal) * 100}
                    hint={kind === "accounts" ? `${accountsWithDebt.length} accounts` : `${components.liabilities.filter((l) => l.kind === kind).length} debts`}
                    tone="danger"
                  />
                ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Everything counted" hint="Values in their own currency, converted at today's rate">
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          <ComponentList
            title="Accounts"
            icon={Wallet}
            rows={components.accounts.map((a) => ({
              id: a.id,
              href: `/accounts/${a.id}`,
              name: a.name,
              own: `${money(a.balance, a.currency)}`,
              base: a.baseBalance,
            }))}
          />
          <ComponentList
            title="Investments"
            icon={ChartLine}
            rows={components.investments.map((i) => ({
              id: i.id,
              href: `/wealth/investments/${i.id}`,
              name: i.name,
              detail: `${INVESTMENT_KIND_LABELS[i.kind]}${i.source === "cost_basis" ? " · at cost" : ""}`,
              own: money(i.value, i.currency),
              base: i.baseValue,
            }))}
          />
          <ComponentList
            title="Assets"
            icon={Car}
            rows={components.assets.map((a) => ({
              id: a.id,
              href: `/wealth/assets/${a.id}`,
              name: a.name,
              detail: ASSET_KIND_LABELS[a.kind],
              own: money(a.value, a.currency),
              base: a.baseValue,
            }))}
          />
          <ComponentList
            title="Owed to you"
            icon={HandCoins}
            rows={components.receivables.map((r) => ({
              id: r.id,
              href: `/wealth/receivables/${r.id}`,
              name: r.counterpartyName,
              detail: r.title,
              own: money(r.remaining, r.currency),
              base: r.baseRemaining,
            }))}
          />
          <ComponentList
            title="Debts"
            icon={Landmark}
            negative
            rows={components.liabilities.map((l) => ({
              id: l.id,
              href: `/wealth/liabilities/${l.id}`,
              name: l.name,
              detail: LIABILITY_KIND_LABELS[l.kind],
              own: money(l.outstanding, l.currency),
              base: l.baseOutstanding,
            }))}
          />
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="xs" variant="outline" render={<Link href="/wealth/assets?new=1" />}>
              <Plus className="size-3.5" /> Asset
            </Button>
            <Button size="xs" variant="outline" render={<Link href="/wealth/investments?new=1" />}>
              <Plus className="size-3.5" /> Investment
            </Button>
            <Button size="xs" variant="outline" render={<Link href="/wealth/liabilities?new=1" />}>
              <Plus className="size-3.5" /> Debt
            </Button>
            <Button size="xs" variant="outline" render={<Link href="/wealth/receivables?new=1" />}>
              <Plus className="size-3.5" /> Receivable
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}

function ComponentList({
  title,
  icon: Icon,
  rows,
  negative,
}: {
  title: string;
  icon: typeof Wallet;
  rows: Array<{
    id: string;
    href: string;
    name: string;
    detail?: string;
    own: string;
    base: number | null;
  }>;
  negative?: boolean;
}) {
  const { money } = useApp();
  if (!rows.length) return null;
  return (
    <div className="min-w-0">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" /> {title}
      </h3>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={row.href} className="flex items-center justify-between gap-3 py-1.5 hover:opacity-80">
              <span className="min-w-0">
                <span className="block truncate text-sm">{row.name}</span>
                {row.detail && <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>}
              </span>
              <span className="shrink-0 text-right">
                <span className={cn("block text-sm tabular-nums", negative && "text-red-600 dark:text-red-400")}>
                  {row.base === null ? row.own : money(negative ? -row.base : row.base)}
                </span>
                {row.base === null ? (
                  <span className="block text-[11px] text-amber-600 dark:text-amber-400">no exchange rate</span>
                ) : (
                  row.own !== money(row.base) && <span className="block text-[11px] text-muted-foreground tabular-nums">{row.own}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
