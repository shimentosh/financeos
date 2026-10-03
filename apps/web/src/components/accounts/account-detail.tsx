"use client";

import { ACCOUNT_KIND_LABELS, formatMoney, minorToInput, parseMoneyInput, today } from "@financeos/core";
import { Archive, Pencil, Scale } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Section } from "@/components/app/blocks";
import { SERIES, TrendChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { AccountDetail } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatMonth, timeAgo } from "@/lib/format-client";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { AccountFormDialog } from "./account-form";

type ReconcileResult = { bookBalance: number; statementBalance: number; difference: number; reconciled: boolean; adjustmentId: string | null };

export function AccountHeader({ account }: { account: AccountDetail }) {
  const { money, canWrite, locale } = useApp();
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [statement, setStatement] = useState(minorToInput(account.balance, account.currency));
  const [asOf, setAsOf] = useState(today());
  const [adjust, setAdjust] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [busy, setBusy] = useState(false);

  const reconcile = async () => {
    const statementBalance = parseMoneyInput(statement.replace(/^-/, ""), account.currency);
    if (statementBalance === null) return toast.error("Enter the balance your bank or wallet shows");
    setBusy(true);
    try {
      const signed = statement.trim().startsWith("-") ? -statementBalance : statementBalance;
      const data = await clientApi<ReconcileResult>(`/accounts/${account.id}/reconcile`, { method: "POST", body: { statementBalance: signed, asOf, adjust } });
      setResult(data);
      if (data.reconciled) {
        toast.success(data.adjustmentId ? "Adjustment posted; the books now match" : "The books match the statement");
        invalidateApiCache("/accounts");
        router.refresh();
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    try {
      const outcome = await clientApi<{ archived?: boolean; deleted?: boolean }>(`/accounts/${account.id}`, { method: "DELETE" });
      toast.success(outcome.deleted ? "Account deleted" : "Account archived; its history is kept");
      invalidateApiCache("/accounts");
      router.push("/accounts");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const chart = account.history.map((point) => ({ label: point.month, balance: point.balance }));

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="text-xs text-muted-foreground">
              {ACCOUNT_KIND_LABELS[account.kind]} · {account.currency}
              {account.mask ? ` · •••• ${account.mask}` : ""}
            </p>
            <p className={cn("mt-1 text-3xl font-semibold", account.balance < 0 && "text-red-600 dark:text-red-400")}>
              {money(account.balance, account.currency)}
            </p>
            {account.baseBalance !== null && account.currency !== undefined && account.baseBalance !== account.balance && (
              <p className="text-sm text-muted-foreground">≈ {money(account.baseBalance)}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Opening {formatMoney(account.openingBalance, account.currency, { locale })} on {account.openingDate} · {account.entryCount} transactions
            </p>
            <p className="text-xs text-muted-foreground">
              {account.lastReconciledAt
                ? `Reconciled ${timeAgo(account.lastReconciledAt)} at ${money(account.lastReconciledBalance ?? 0, account.currency)}`
                : "Never reconciled against a statement"}
            </p>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setResult(null);
                  setReconciling(true);
                }}
              >
                <Scale className="size-3.5" /> Reconcile
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void archive()}>
                <Archive className="size-3.5" /> {account.entryCount ? "Archive" : "Delete"}
              </Button>
            </div>
          )}
        </div>
        <Section title="Balance" hint="Month-end balance, last 12 months">
          <TrendChart
            data={chart}
            series={[{ key: "balance", label: "Balance", color: SERIES.primary }]}
            format={(v) => money(v, account.currency)}
            axisFormat={(v) => formatMoney(v, account.currency, { locale, compact: true })}
            tickFormat={(label) => formatMonth(label, "en-GB", true)}
            labelFormat={(label) => formatMonth(label)}
            height={180}
            zeroLine
          />
        </Section>
      </div>

      <AccountFormDialog open={editing} onOpenChange={setEditing} account={account} />

      <Dialog open={reconciling} onOpenChange={setReconciling}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reconcile {account.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Enter the balance your bank app, bKash or statement shows. Differences point to missing, duplicated or mistyped transactions.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-statement`}>Statement balance ({account.currency})</Label>
                <Input id={`${id}-statement`} inputMode="decimal" value={statement} onChange={(e) => setStatement(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-asof`}>As of</Label>
                <Input id={`${id}-asof`} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <span>
                Post the difference as an adjustment
                <span className="block text-xs text-muted-foreground">Only once you are sure nothing is missing.</span>
              </span>
              <Switch checked={adjust} onCheckedChange={setAdjust} />
            </label>
            {result && (
              <div
                className={cn(
                  "rounded-lg px-3 py-2 text-sm",
                  result.difference === 0 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                Books {money(result.bookBalance, account.currency)} · Statement {money(result.statementBalance, account.currency)} ·{" "}
                {result.difference === 0
                  ? "They match."
                  : `Difference ${money(result.difference, account.currency, { signed: true })}${result.adjustmentId ? " — adjusted." : "."}`}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setReconciling(false)}>
              Close
            </Button>
            <Button size="sm" loading={busy} onClick={() => void reconcile()}>
              Compare
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
