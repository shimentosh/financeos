"use client";

import { ACCOUNT_KIND_LABELS, type AccountKind } from "@expensewise/core";
import { Banknote, Bitcoin, CheckCircle2, CircleAlert, CreditCard, Landmark, Plus, Smartphone, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyState, StatCard } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import type { Account } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDay, timeAgo } from "@/lib/format";
import { AccountFormDialog } from "./account-form";

const KIND_ICON: Partial<Record<AccountKind, typeof Wallet>> = {
  bank: Landmark,
  cash: Banknote,
  mobile_wallet: Smartphone,
  card: CreditCard,
  crypto_wallet: Bitcoin,
};

const ORDER: AccountKind[] = ["bank", "mobile_wallet", "cash", "digital_wallet", "payment_processor", "crypto_wallet", "savings", "card", "loan", "other"];

export function AccountsView({ accounts }: { accounts: Account[] }) {
  const { money, canWrite } = useApp();
  const [open, setOpen] = useState(false);

  const assets = accounts.filter((a) => a.includeInNetWorth && (a.baseBalance ?? 0) >= 0);
  const owed = accounts.filter((a) => a.includeInNetWorth && (a.baseBalance ?? 0) < 0);
  const cash = assets.reduce((sum, a) => sum + (a.baseBalance ?? 0), 0);
  const debt = owed.reduce((sum, a) => sum - (a.baseBalance ?? 0), 0);
  const unconverted = accounts.filter((a) => a.baseBalance === null);
  const groups = ORDER.map((kind) => ({ kind, items: accounts.filter((a) => a.kind === kind) })).filter((g) => g.items.length);

  if (accounts.length === 0) {
    return (
      <>
        <EmptyState
          icon={Wallet}
          title="Add the places your money lives"
          description="Bank accounts, bKash and Nagad wallets, cards, cash, Wise or Stripe. Balances then follow every transaction."
          action={
            canWrite ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus className="size-3.5" /> Add account
              </Button>
            ) : undefined
          }
        />
        <AccountFormDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Wallet} label="Cash position" value={money(cash)} hint={`${assets.length} accounts`} tone="good" />
        <StatCard
          icon={CreditCard}
          label="Owed on accounts"
          value={money(debt)}
          hint={owed.length ? `${owed.length} in debt` : "Nothing owed"}
          tone={debt > 0 ? "warn" : "default"}
        />
        <StatCard icon={Landmark} label="Net across accounts" value={money(cash - debt)} />
        <StatCard
          icon={unconverted.length ? CircleAlert : CheckCircle2}
          label="Currencies"
          value={[...new Set(accounts.map((a) => a.currency))].join(" · ")}
          hint={unconverted.length ? `${unconverted.length} without an exchange rate` : "All converted"}
          tone={unconverted.length ? "warn" : "default"}
          href={unconverted.length ? "/settings/currency" : undefined}
        />
      </div>

      {groups.map((group) => (
        <section key={group.kind} className="space-y-2">
          <h2 className="px-1 text-xs font-medium text-muted-foreground">{ACCOUNT_KIND_LABELS[group.kind]}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.items.map((account) => {
              const Icon = KIND_ICON[account.kind] ?? Wallet;
              const negative = account.balance < 0;
              const utilization = account.creditLimit ? Math.min(100, Math.round((Math.abs(Math.min(0, account.balance)) / account.creditLimit) * 100)) : null;
              return (
                <Link
                  key={account.id}
                  href={`/accounts/${account.id}`}
                  className="block rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{account.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[account.institution, account.mask ? `•••• ${account.mask}` : null, account.currency].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    </div>
                    {account.status === "archived" && <span className="text-[11px] text-muted-foreground">Archived</span>}
                  </div>
                  <div className={cn("mt-3 text-xl font-semibold tabular-nums", negative && "text-red-600 dark:text-red-400")}>
                    {money(account.balance, account.currency)}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {account.baseBalance !== null && account.balance !== account.baseBalance
                        ? `≈ ${money(account.baseBalance)}`
                        : `${account.entryCount} ${account.entryCount === 1 ? "transaction" : "transactions"}`}
                    </span>
                    <span className="shrink-0">
                      {account.lastReconciledAt
                        ? `Reconciled ${timeAgo(account.lastReconciledAt)}`
                        : account.lastActivity
                          ? `Last used ${formatDay(account.lastActivity, "short")}`
                          : "No activity yet"}
                    </span>
                  </div>
                  {utilization !== null && (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", utilization > 80 ? "bg-red-500" : utilization > 50 ? "bg-amber-500" : "bg-emerald-500")}
                        style={{ width: `${utilization}%` }}
                      />
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
      <AccountFormDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

export function AddAccountButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add account
      </Button>
      <AccountFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
