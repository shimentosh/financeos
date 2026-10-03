"use client";

import { formatDay, minorToInput, today } from "@financeos/core";
import { Car, CircleAlert, Gem, HandCoins, Pencil, Plus, Tag, Trash2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { EmptyState, Facts, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";

import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Asset, AssetDetail, AssetKind, AssetList, SellResult } from "@/lib/api/types/wealth";
import { cn } from "@/lib/cn";
import { percentText } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  AccountSelect,
  ASSET_KIND_LABELS,
  ConfirmDialog,
  CurrencySelect,
  Field,
  FormError,
  KindSelect,
  LinkedTransactions,
  MoneyInput,
  NewParamOpener,
  ParamTabs,
  ProjectSelect,
  SwitchRow,
  toMinor,
  useRefresh,
} from "./shared";
import { ValuationDialog, ValuationHistory } from "./valuations";

// ------------------------------------------------------------------- list

export function AssetsView({ list, status }: { list: AssetList; status: string }) {
  const { money, canWrite, isBusiness } = useApp();
  const [creating, setCreating] = useState(false);
  const [valuing, setValuing] = useState<Asset | null>(null);
  const [selling, setSelling] = useState<Asset | null>(null);
  const openCreate = useCallback(() => setCreating(true), []);
  const { totals } = list;

  const dialogs = (
    <>
      <Suspense>
        <NewParamOpener onNew={openCreate} />
      </Suspense>
      <AssetFormDialog open={creating} onOpenChange={setCreating} />
      {valuing && (
        <ValuationDialog
          open={Boolean(valuing)}
          onOpenChange={(open) => !open && setValuing(null)}
          endpoint={`/assets/${valuing.id}`}
          name={valuing.name}
          currency={valuing.currency}
          currentValue={valuing.currentValue}
        />
      )}
      {selling && <SellDialog open={Boolean(selling)} onOpenChange={(open) => !open && setSelling(null)} asset={selling} />}
    </>
  );

  const tabs = (
    <ParamTabs
      param="status"
      label="Status"
      value={status}
      options={[
        { value: "owned", label: "Owned" },
        { value: "sold", label: "Sold" },
        { value: "disposed", label: "Disposed" },
        { value: "all", label: "All" },
      ]}
    />
  );

  if (list.items.length === 0 && status === "owned") {
    return (
      <>
        {tabs}
        <EmptyState
          icon={Car}
          title="Track what you own"
          description="A car, a laptop, land, gold or business equipment. Record what you paid and what it is worth now; net worth follows every valuation."
          action={
            canWrite ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-3.5" /> Add asset
              </Button>
            ) : undefined
          }
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Gem} label="Current value" value={money(totals.currentValue)} hint={`${totals.count} owned`} tone="good" href="/wealth/net-worth" />
        <StatCard icon={Tag} label="Paid for them" value={money(totals.purchasePrice)} hint="Where the purchase price is known" />
        <StatCard
          icon={TrendingUp}
          label="Gain vs purchase"
          value={money(totals.gain, undefined, { signed: true })}
          hint="Unrealised, owned assets"
          tone={totals.gain < 0 ? "warn" : "default"}
        />
        <StatCard
          icon={HandCoins}
          label="Realised on sales"
          value={money(totals.realizedGain, undefined, { signed: true })}
          hint={status === "owned" ? "See the Sold tab" : "Sold or disposed in this list"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {tabs}
        {totals.byKind.map((k) => (
          <span key={k.kind} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            {ASSET_KIND_LABELS[k.kind]} · {k.count} · <span className="tabular-nums">{money(k.currentValue, undefined, { compact: true })}</span>
          </span>
        ))}
      </div>

      {list.unconvertible.length > 0 && (
        <Link
          href="/settings/currency"
          className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
        >
          <CircleAlert className="size-3.5 shrink-0" />
          {list.unconvertible.map((u) => `${u.name} (${u.currency})`).join(", ")} {list.unconvertible.length === 1 ? "has" : "have"} no exchange rate and{" "}
          {list.unconvertible.length === 1 ? "is" : "are"} left out of the totals. Add a rate.
        </Link>
      )}

      {list.items.length === 0 ? (
        <EmptyState
          icon={Car}
          title={status === "sold" ? "No sold assets" : status === "disposed" ? "No disposed assets" : "No assets here"}
          description="Assets you sell or dispose of move to these tabs, with the gain or loss on each."
          action={
            <Button size="sm" variant="outline" render={<Link href="/wealth/assets" />}>
              View owned assets
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Asset</th>
                <th className="hidden md:table-cell">Bought</th>
                {isBusiness && <th className="hidden lg:table-cell">Project</th>}
                <th className="text-right!">Value</th>
                <th className="hidden text-right! sm:table-cell">Gain</th>
                {canWrite && <th className="hidden w-40 md:table-cell" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.items.map((asset) => (
                <tr key={asset.id} className="[&>td]:px-3 [&>td]:py-2.5">
                  <td className="min-w-0">
                    <Link href={`/wealth/assets/${asset.id}`} className="block hover:underline underline-offset-4">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{asset.name}</span>
                        {asset.status !== "owned" && <StatusBadge status={asset.status === "sold" ? "paid" : "cancelled"} label={asset.status} />}
                      </span>
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[ASSET_KIND_LABELS[asset.kind], asset.owner, asset.currency].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  <td className="hidden text-xs text-muted-foreground md:table-cell">
                    {asset.purchasePrice !== null ? money(asset.purchasePrice, asset.currency) : "—"}
                    {asset.purchaseDate && <span className="block">{formatDay(asset.purchaseDate)}</span>}
                  </td>
                  {isBusiness && <td className="hidden text-xs text-muted-foreground lg:table-cell">{asset.projectName ?? "—"}</td>}
                  <td className="text-right">
                    <span className="block tabular-nums">{money(asset.status === "owned" ? asset.currentValue : (asset.soldAmount ?? 0), asset.currency)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {asset.status === "owned"
                        ? asset.valuedAt
                          ? `valued ${formatDay(asset.valuedAt, "short")}`
                          : "not valued"
                        : `sold ${asset.soldOn ? formatDay(asset.soldOn, "short") : ""}`}
                    </span>
                  </td>
                  <td className="hidden text-right sm:table-cell">
                    {asset.gain === null ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <>
                        <span className={cn("block tabular-nums", asset.gain > 0 ? "text-money-in" : asset.gain < 0 && "text-red-600 dark:text-red-400")}>
                          {money(asset.gain, asset.currency, { signed: true })}
                        </span>
                        <span className="block text-xs text-muted-foreground">{percentText(asset.gainPercent)}</span>
                      </>
                    )}
                  </td>
                  {canWrite && (
                    <td className="hidden text-right md:table-cell">
                      {asset.status === "owned" && (
                        <span className="inline-flex gap-1">
                          <Button size="xs" variant="outline" onClick={() => setValuing(asset)}>
                            Value
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setSelling(asset)}>
                            Sell
                          </Button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialogs}
    </div>
  );
}

export function AddAssetButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add asset
      </Button>
      <AssetFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

// ------------------------------------------------------------------- forms

export function AssetFormDialog({ open, onOpenChange, asset }: { open: boolean; onOpenChange: (open: boolean) => void; asset?: Asset | null }) {
  const id = useId();
  const router = useRouter();
  const refresh = useRefresh();
  const { workspace, isBusiness } = useApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AssetKind>("electronics");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [purchasePrice, setPurchasePrice] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [owner, setOwner] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [recordPayment, setRecordPayment] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(asset?.name ?? "");
    setKind(asset?.kind ?? "electronics");
    setCurrency(asset?.currency ?? workspace.baseCurrency);
    setPurchasePrice(asset?.purchasePrice ? minorToInput(asset.purchasePrice, asset.currency) : "");
    setPurchaseDate(asset?.purchaseDate ?? "");
    setCurrentValue(asset ? minorToInput(asset.currentValue, asset.currency) : "");
    setOwner(asset?.owner ?? "");
    setProjectId(asset?.projectId ?? null);
    setNotes(asset?.notes ?? "");
    setRecordPayment(false);
    setAccountId(null);
    setInvoice([]);
  }, [open, asset, workspace.baseCurrency]);

  const close = (next: boolean) => {
    if (!next) discardNewAttachments(invoice);
    onOpenChange(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const price = purchasePrice ? toMinor(purchasePrice, currency) : null;
    if (purchasePrice && price === null) return setError("Enter the purchase price as a number");
    const value = currentValue ? toMinor(currentValue, currency) : price;
    if (value === null) return setError("Enter what it is worth now (or its purchase price)");
    if (recordPayment && !accountId) return setError("Choose the account it was paid from");
    if (recordPayment && !invoice.length) return setError("Attach the purchase invoice. If a file is still uploading, wait for it to finish.");
    if (recordPayment && !price) return setError("Enter the purchase price to record the payment");
    const common = {
      name: name.trim(),
      kind,
      currency,
      purchasePrice: price,
      purchaseDate: purchaseDate || null,
      owner: owner.trim() || null,
      projectId,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      if (asset) {
        await clientApi(`/assets/${asset.id}`, {
          method: "PATCH",
          body: common,
        });
        toast.success("Asset updated");
        refresh();
      } else {
        const created = await clientApi<AssetDetail>("/assets", {
          method: "POST",
          body: {
            ...common,
            currentValue: value,
            paidFromAccountId: recordPayment ? accountId : null,
            attachmentFileIds: recordPayment && invoice.length ? invoice.map((file) => file.id) : undefined,
          },
        });
        toast.success(recordPayment ? "Asset added and its purchase recorded" : "Asset added");
        refresh();
        router.push(`/wealth/assets/${created.id}`);
        // Linked to the purchase unless the payment was switched off.
        if (!recordPayment) discardNewAttachments(invoice);
        setInvoice([]);
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{asset ? `Edit ${asset.name}` : "Add asset"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Field label="Name" htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Toyota Axio, MacBook Pro, Plot in Purbachal…"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type" htmlFor={`${id}-kind`}>
                <KindSelect id={`${id}-kind`} value={kind} onChange={setKind} labels={ASSET_KIND_LABELS} />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <CurrencySelect id={`${id}-currency`} value={currency} onChange={setCurrency} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Purchase price" htmlFor={`${id}-price`}>
                <MoneyInput id={`${id}-price`} value={purchasePrice} onChange={setPurchasePrice} currency={currency} placeholder="Optional" />
              </Field>
              <Field label="Bought on" htmlFor={`${id}-bought`}>
                <Input id={`${id}-bought`} type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
              </Field>
            </div>
            {!asset && (
              <Field label="Worth now" htmlFor={`${id}-value`} hint="Leave empty to use the purchase price. Later changes go through Update value.">
                <MoneyInput id={`${id}-value`} value={currentValue} onChange={setCurrentValue} currency={currency} />
              </Field>
            )}
            <div className={cn("grid gap-3", isBusiness && "grid-cols-2")}>
              <Field label="Owner" htmlFor={`${id}-owner`}>
                <Input id={`${id}-owner`} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Me, Spouse, Company" />
              </Field>
              {isBusiness && (
                <Field label="Project" htmlFor={`${id}-project`}>
                  <ProjectSelect id={`${id}-project`} value={projectId} onChange={setProjectId} enabled={open} />
                </Field>
              )}
            </div>
            {!asset && (
              <div className="space-y-2 rounded-lg border border-border px-3 py-2">
                <SwitchRow
                  id={`${id}-record`}
                  title="Record the payment"
                  hint="Money leaves the account as an asset purchase — not an expense."
                  checked={recordPayment}
                  onCheckedChange={setRecordPayment}
                />
                {recordPayment && (
                  <>
                    <Field label="Paid from" htmlFor={`${id}-account`}>
                      <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} enabled={open} />
                    </Field>
                    <AttachmentField
                      value={invoice}
                      onChange={setInvoice}
                      label="Purchase invoice (required)"
                      hint="Kept with the purchase transaction — handy for warranty claims."
                    />
                  </>
                )}
              </div>
            )}
            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {asset ? "Save" : "Add asset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function SellDialog({ open, onOpenChange, asset }: { open: boolean; onOpenChange: (open: boolean) => void; asset: Asset }) {
  const id = useId();
  const refresh = useRefresh();
  const { workspace, money } = useApp();
  const [mode, setMode] = useState<"sold" | "disposed">("sold");
  const [date, setDate] = useState(today(workspace.timezone));
  const [amount, setAmount] = useState("");
  const [intoAccount, setIntoAccount] = useState(true);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("sold");
    setDate(today(workspace.timezone));
    setAmount(minorToInput(asset.currentValue, asset.currency));
    setIntoAccount(true);
    setAccountId(null);
    setNote("");
    setError(null);
  }, [open, asset, workspace.timezone]);

  const minor = amount ? toMinor(amount, asset.currency) : 0;
  const gain = asset.purchasePrice !== null && minor !== null ? minor - asset.purchasePrice : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (minor === null) return setError("Enter the amount as a number");
    if (mode === "sold" && !minor) return setError("Enter what it sold for");
    const withProceeds = intoAccount && minor > 0;
    if (withProceeds && !accountId) return setError("Choose the account the money went into");
    setSaving(true);
    setError(null);
    try {
      const result = await clientApi<SellResult>(`/assets/${asset.id}/sell`, {
        method: "POST",
        body: {
          status: mode,
          date,
          amount: minor,
          proceedsAccountId: withProceeds ? accountId : null,
          note: note.trim() || null,
        },
      });
      toast.success(mode === "sold" ? "Sale recorded" : "Marked as disposed", {
        description:
          result.realizedGain !== null ? `${result.realizedGain >= 0 ? "Gain" : "Loss"}: ${money(Math.abs(result.realizedGain), asset.currency)}` : undefined,
      });
      refresh();
      onOpenChange(false);
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
            <DialogTitle>Sell or dispose · {asset.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="flex gap-1.5">
              {(["sold", "disposed"] as const).map((m) => (
                <Button key={m} type="button" size="xs" variant={mode === m ? "default" : "outline"} onClick={() => setMode(m)}>
                  {m === "sold" ? "Sold it" : "Disposed of it"}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={mode === "sold" ? "Sold for" : "Received (if any)"} htmlFor={`${id}-amount`}>
                <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={asset.currency} />
              </Field>
              <Field label="On" htmlFor={`${id}-date`}>
                <Input id={`${id}-date`} type="date" value={date} max={today(workspace.timezone)} onChange={(e) => setDate(e.target.value)} required />
              </Field>
            </div>
            {gain !== null && (
              <p
                className={cn(
                  "rounded-lg px-3 py-2 text-sm",
                  gain >= 0 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                {gain >= 0 ? "Gain" : "Loss"} of {money(Math.abs(gain), asset.currency)} against the {money(asset.purchasePrice, asset.currency)} it cost.
              </p>
            )}
            <div className="space-y-2 rounded-lg border border-border px-3 py-2">
              <SwitchRow
                id={`${id}-proceeds`}
                title="Money went into an account"
                hint="Recorded as sale proceeds (an adjustment), not income."
                checked={intoAccount}
                onCheckedChange={setIntoAccount}
              />
              {intoAccount && (
                <Field label="Account" htmlFor={`${id}-account`}>
                  <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} enabled={open} />
                </Field>
              )}
            </div>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Buyer, reason…" />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {mode === "sold" ? "Record sale" : "Mark disposed"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

export function AssetDetailView({ asset }: { asset: AssetDetail }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [valuing, setValuing] = useState(false);
  const [selling, setSelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reopening, setReopening] = useState(false);
  const owned = asset.status === "owned";
  const linked = asset.transactions.length;

  const remove = async () => {
    try {
      await clientApi(`/assets/${asset.id}`, {
        method: "DELETE",
        query: { voidLinked: linked > 0 },
      });
      toast.success("Asset deleted");
      refresh();
      router.push("/wealth/assets");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const reopen = async () => {
    try {
      await clientApi(`/assets/${asset.id}`, {
        method: "PATCH",
        body: { status: "owned" },
      });
      toast.success("Marked as owned again", {
        description: "Void the sale proceeds transaction too if the sale did not happen.",
      });
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              {ASSET_KIND_LABELS[asset.kind]} · {asset.currency}
              {!owned && <StatusBadge status={asset.status === "sold" ? "paid" : "cancelled"} label={asset.status} />}
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{money(owned ? asset.currentValue : (asset.soldAmount ?? 0), asset.currency)}</p>
            {asset.baseCurrentValue !== null && asset.baseCurrentValue !== asset.currentValue && owned && (
              <p className="text-sm text-muted-foreground">≈ {money(asset.baseCurrentValue)}</p>
            )}
            {asset.baseCurrentValue === null && (
              <Link href="/settings/currency" className="text-xs text-amber-600 hover:underline dark:text-amber-400">
                No {asset.currency} exchange rate — left out of net worth. Add one.
              </Link>
            )}
            {asset.gain !== null && (
              <p className={cn("mt-1 text-sm tabular-nums", asset.gain >= 0 ? "text-money-in" : "text-red-600 dark:text-red-400")}>
                {money(asset.gain, asset.currency, { signed: true })} ({percentText(asset.gainPercent)}) {owned ? "vs purchase price" : "realised"}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {owned
                ? asset.valuedAt
                  ? `Last valued ${formatDay(asset.valuedAt)}${asset.valuationAgeDays && asset.valuationAgeDays > 180 ? " — due for an update" : ""}`
                  : "Not valued yet"
                : `Sold ${asset.soldOn ? formatDay(asset.soldOn) : ""}`}
            </p>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {owned ? (
                <>
                  <Button size="sm" onClick={() => setValuing(true)}>
                    <TrendingUp className="size-3.5" /> Update value
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setSelling(true)}>
                    <HandCoins className="size-3.5" /> Sell
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setReopening(true)}>
                  Mark as owned
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </div>
          )}
        </div>
        <Section title="Value over time" hint="Every valuation, oldest to newest">
          <ValuationHistory endpoint={`/assets/${asset.id}`} valuations={asset.valuations} currency={asset.currency} canEdit={canWrite} />
        </Section>
      </div>

      <Section title="Details">
        <Facts
          items={[
            {
              label: "Purchase price",
              value: asset.purchasePrice !== null ? money(asset.purchasePrice, asset.currency) : "—",
            },
            {
              label: "Bought on",
              value: asset.purchaseDate ? formatDay(asset.purchaseDate) : "—",
            },
            { label: "Owner", value: asset.owner ?? "—" },
            asset.projectName ? { label: "Project", value: asset.projectName } : false,
            !owned && {
              label: "Sold for",
              value: money(asset.soldAmount ?? 0, asset.currency),
            },
            asset.notes ? { label: "Notes", value: asset.notes } : false,
          ]}
        />
      </Section>

      <Section title="Money moved" hint="The purchase and any sale proceeds, linked to this asset">
        <LinkedTransactions items={asset.transactions} empty="No money recorded for this asset. Add it with “Record the payment” when you buy something." />
      </Section>

      <AssetFormDialog open={editing} onOpenChange={setEditing} asset={asset} />
      <ValuationDialog
        open={valuing}
        onOpenChange={setValuing}
        endpoint={`/assets/${asset.id}`}
        name={asset.name}
        currency={asset.currency}
        currentValue={asset.currentValue}
      />
      <SellDialog open={selling} onOpenChange={setSelling} asset={asset} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${asset.name}?`}
        description={
          linked
            ? `Its ${linked} linked transaction${linked === 1 ? " is" : "s are"} voided too, so balances change back. To keep the history, sell or dispose of it instead.`
            : "It and its valuation history are removed. No money moved through it."
        }
        confirmLabel={linked ? "Delete and void" : "Delete"}
        onConfirm={remove}
      />
      <ConfirmDialog
        open={reopening}
        onOpenChange={setReopening}
        title="Mark as owned again?"
        description="The sale date and amount are cleared. Any sale proceeds transaction stays until you void it."
        confirmLabel="Mark as owned"
        destructive={false}
        onConfirm={reopen}
      />
    </div>
  );
}
