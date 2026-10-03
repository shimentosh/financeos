"use client";

import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS, type AccountKind, minorToInput, parseMoneyInput, SELECTABLE_CURRENCIES, today } from "@expensewise/core";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Account } from "@/lib/api/types";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";

/** Presets for the providers people in Bangladesh actually use. */
export const PROVIDERS: Array<{ value: string; label: string; kind: AccountKind; currency?: string }> = [
  { value: "bkash", label: "bKash", kind: "mobile_wallet" },
  { value: "nagad", label: "Nagad", kind: "mobile_wallet" },
  { value: "rocket", label: "Rocket", kind: "mobile_wallet" },
  { value: "upay", label: "Upay", kind: "mobile_wallet" },
  { value: "bank", label: "Bank account", kind: "bank" },
  { value: "card", label: "Credit card", kind: "card" },
  { value: "cash", label: "Cash", kind: "cash" },
  { value: "wise", label: "Wise", kind: "digital_wallet", currency: "USD" },
  { value: "payoneer", label: "Payoneer", kind: "digital_wallet", currency: "USD" },
  { value: "paypal", label: "PayPal", kind: "digital_wallet", currency: "USD" },
  { value: "stripe", label: "Stripe", kind: "payment_processor", currency: "USD" },
  { value: "binance", label: "Binance", kind: "crypto_wallet", currency: "USDT" },
  { value: "crypto", label: "Crypto wallet", kind: "crypto_wallet", currency: "BTC" },
  { value: "other", label: "Other", kind: "other" },
];

export function AccountFormDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (open: boolean) => void; account?: Account | null }) {
  const id = useId();
  const router = useRouter();
  const { workspace } = useApp();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("bkash");
  const [kind, setKind] = useState<AccountKind>("mobile_wallet");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [opening, setOpening] = useState("0");
  const [openingDate, setOpeningDate] = useState(today(workspace.timezone));
  const [institution, setInstitution] = useState("");
  const [mask, setMask] = useState("");
  const [creditLimit, setCreditLimit] = useState("");
  const [includeInNetWorth, setIncludeInNetWorth] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(account?.name ?? "");
    setProvider(account?.provider ?? "bkash");
    setKind(account?.kind ?? "mobile_wallet");
    setCurrency(account?.currency ?? workspace.baseCurrency);
    setOpening(account ? minorToInput(Math.abs(account.openingBalance), account.currency) : "0");
    setOpeningDate(account?.openingDate ?? today(workspace.timezone));
    setInstitution(account?.institution ?? "");
    setMask(account?.mask ?? "");
    setCreditLimit(account?.creditLimit ? minorToInput(account.creditLimit, account.currency) : "");
    setIncludeInNetWorth(account?.includeInNetWorth ?? true);
    setNotes(account?.notes ?? "");
  }, [open, account, workspace.baseCurrency, workspace.timezone]);

  const chooseProvider = (value: string) => {
    setProvider(value);
    const preset = PROVIDERS.find((p) => p.value === value);
    if (!preset) return;
    setKind(preset.kind);
    if (preset.currency && !account) setCurrency(preset.currency);
    if (!name || PROVIDERS.some((p) => p.label === name)) setName(preset.label);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const openingMinor = parseMoneyInput(opening || "0", currency);
    if (openingMinor === null) return setError("Enter the opening balance as a number, e.g. 25,000");
    const limit = creditLimit ? parseMoneyInput(creditLimit, currency) : null;
    const isLiability = kind === "card";
    const body = {
      name: name.trim(),
      kind,
      provider,
      institution: institution.trim() || null,
      mask: mask.trim() || null,
      currency,
      // A card's opening balance is what was owed: stored negative.
      openingBalance: isLiability ? -openingMinor : openingMinor,
      openingDate,
      creditLimit: limit,
      isLiability,
      includeInNetWorth,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      if (account) await clientApi(`/accounts/${account.id}`, { method: "PATCH", body });
      else await clientApi("/accounts", { method: "POST", body });
      toast.success(account ? "Account updated" : "Account added");
      invalidateApiCache("/accounts");
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{account ? `Edit ${account.name}` : "Add account"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {PROVIDERS.map((p) => (
                <Button key={p.value} type="button" size="xs" variant={provider === p.value ? "default" : "outline"} onClick={() => chooseProvider(p.value)}>
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input id={`${id}-name`} required value={name} onChange={(e) => setName(e.target.value)} placeholder="BRAC Bank savings, Personal bKash…" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-kind`}>Type</Label>
                <Select value={kind} onValueChange={(v) => typeof v === "string" && setKind(v as AccountKind)}>
                  <SelectTrigger id={`${id}-kind`}>
                    <SelectValue>{ACCOUNT_KIND_LABELS[kind]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {ACCOUNT_KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-currency`}>Currency</Label>
                <Select value={currency} onValueChange={(v) => typeof v === "string" && setCurrency(v)}>
                  <SelectTrigger id={`${id}-currency`}>
                    <SelectValue>{currency}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([currency, ...SELECTABLE_CURRENCIES])].map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-opening`}>{kind === "card" ? "Amount owed on" : "Balance on"}</Label>
                <Input id={`${id}-opening`} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-date`}>Date</Label>
                <Input id={`${id}-date`} type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${id}-institution`}>Institution</Label>
                <Input id={`${id}-institution`} value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="City Bank" />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-mask`}>Last digits</Label>
                <Input id={`${id}-mask`} maxLength={8} value={mask} onChange={(e) => setMask(e.target.value)} placeholder="4321" />
              </div>
            </div>
            {kind === "card" && (
              <div className="space-y-1">
                <Label htmlFor={`${id}-limit`}>Credit limit</Label>
                <Input id={`${id}-limit`} inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
              </div>
            )}
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <span>
                Count in net worth
                <span className="block text-xs text-muted-foreground">Turn off for accounts that hold money that is not yours.</span>
              </span>
              <Switch checked={includeInNetWorth} onCheckedChange={setIncludeInNetWorth} />
            </label>
            <div className="space-y-1">
              <Label htmlFor={`${id}-notes`}>Notes</Label>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {account ? "Save" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
