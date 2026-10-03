"use client";

import { formatDay, minorToInput, today } from "@financeos/core";
import { ArrowDownLeft, ArrowUpRight, ChartLine, CircleAlert, Coins, Pencil, Percent, Plus, Trash2, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { EmptyNote, EmptyState, Facts, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Investment, InvestmentDetail, InvestmentKind, InvestmentList } from "@/lib/api/types/wealth";
import { cn } from "@/lib/cn";
import { percentText } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  AccountSelect,
  ConfirmDialog,
  CurrencySelect,
  Field,
  FormError,
  INVESTMENT_KIND_LABELS,
  KindSelect,
  LinkedTransactions,
  MoneyInput,
  NewParamOpener,
  ParamTabs,
  toMinor,
  useRefresh,
} from "./shared";
import { ValuationDialog, ValuationHistory } from "./valuations";

function GainText({ value, currency, className }: { value: number | null; currency?: string; className?: string }) {
  const { money } = useApp();
  if (value === null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span className={cn("tabular-nums", value > 0 ? "text-money-in" : value < 0 && "text-red-600 dark:text-red-400", className)}>
      {money(value, currency, { signed: true })}
    </span>
  );
}

// ------------------------------------------------------------------- list

export function InvestmentsView({ list, status }: { list: InvestmentList; status: string }) {
  const { money, canWrite } = useApp();
  const [creating, setCreating] = useState(false);
  const [flow, setFlow] = useState<{
    investment: Investment;
    direction: "out" | "in";
  } | null>(null);
  const [valuing, setValuing] = useState<Investment | null>(null);
  const openCreate = useCallback(() => setCreating(true), []);
  const { totals } = list;

  const dialogs = (
    <>
      <Suspense>
        <NewParamOpener onNew={openCreate} />
      </Suspense>
      <InvestmentFormDialog open={creating} onOpenChange={setCreating} />
      {flow && <FlowDialog open onOpenChange={(open) => !open && setFlow(null)} investment={flow.investment} direction={flow.direction} />}
      {valuing && (
        <ValuationDialog
          open
          onOpenChange={(open) => !open && setValuing(null)}
          endpoint={`/investments/${valuing.id}`}
          name={valuing.name}
          currency={valuing.currency}
          currentValue={valuing.currentValue ?? valuing.metrics.costBasis}
        />
      )}
    </>
  );

  const tabs = (
    <ParamTabs
      param="status"
      label="Status"
      value={status}
      options={[
        { value: "active", label: "Active" },
        { value: "closed", label: "Closed" },
        { value: "all", label: "All" },
      ]}
    />
  );

  if (list.items.length === 0 && status === "active") {
    return (
      <>
        {tabs}
        <EmptyState
          icon={ChartLine}
          title="Keep investments apart from spending"
          description="Sanchayapatra, DPS, FDRs, stocks, gold or crypto. Money you put in is a contribution, never an expense; returns show once you record a value."
          action={
            canWrite ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-3.5" /> Add investment
              </Button>
            ) : undefined
          }
        />
        {dialogs}
      </>
    );
  }

  const unvalued = totals.count - totals.valuedCount;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Portfolio value"
          value={money(totals.value)}
          hint={unvalued ? `${unvalued} counted at cost (no valuation)` : `${totals.count} holdings`}
          tone={unvalued ? "warn" : "good"}
          href="/wealth/net-worth"
        />
        <StatCard icon={Coins} label="Put in" value={money(totals.contributed)} hint={`${money(totals.withdrawn)} taken out`} />
        <StatCard
          icon={TrendingUp}
          label="Gains"
          value={<GainText value={totals.unrealizedGain + totals.realizedGain} />}
          hint={`${money(totals.realizedGain, undefined, { signed: true })} realised`}
        />
        <StatCard
          icon={Percent}
          label="Return (ROI)"
          value={totals.roi === null ? "—" : percentText(totals.roi)}
          hint={totals.valuedCount ? `Over ${totals.valuedCount} valued holdings` : "Record a value to see returns"}
        />
      </div>

      {list.byKind.length > 0 && (
        <Section title="By kind" hint="Base currency; returns over valued holdings only">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">
                  <th>Kind</th>
                  <th className="text-right!">Value</th>
                  <th className="hidden text-right! sm:table-cell">Cost basis</th>
                  <th className="hidden text-right! md:table-cell">Unrealised</th>
                  <th className="hidden text-right! md:table-cell">Realised</th>
                  <th className="text-right!">ROI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.byKind.map((k) => (
                  <tr key={k.kind} className="[&>td]:px-2 [&>td]:py-1.5">
                    <td>
                      {INVESTMENT_KIND_LABELS[k.kind]} <span className="text-xs text-muted-foreground">· {k.count}</span>
                    </td>
                    <td className="text-right tabular-nums">{money(k.value)}</td>
                    <td className="hidden text-right tabular-nums sm:table-cell">{money(k.costBasis)}</td>
                    <td className="hidden text-right md:table-cell">
                      <GainText value={k.valuedCount ? k.unrealizedGain : null} />
                    </td>
                    <td className="hidden text-right md:table-cell">
                      <GainText value={k.realizedGain} />
                    </td>
                    <td className="text-right tabular-nums">{percentText(k.roi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {tabs}

      {list.unconvertible.length > 0 && (
        <Link
          href="/settings/currency"
          className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
        >
          <CircleAlert className="size-3.5 shrink-0" />
          {list.unconvertible.map((u) => `${u.name} (${u.currency})`).join(", ")} — no exchange rate, left out of the totals. Add a rate.
        </Link>
      )}

      {list.items.length === 0 ? (
        <EmptyState
          icon={ChartLine}
          title="No closed investments"
          description="Close an investment once everything has been withdrawn; its history and realised gain stay here."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Investment</th>
                <th className="text-right!">Value</th>
                <th className="hidden text-right! md:table-cell">Cost basis</th>
                <th className="hidden text-right! sm:table-cell">Gain</th>
                <th className="hidden text-right! md:table-cell">ROI</th>
                {canWrite && <th className="hidden w-52 lg:table-cell" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.items.map((inv) => (
                <tr key={inv.id} className="[&>td]:px-3 [&>td]:py-2.5">
                  <td className="min-w-0">
                    <Link href={`/wealth/investments/${inv.id}`} className="flex items-center gap-2 hover:underline underline-offset-4">
                      <span className="truncate font-medium">{inv.name}</span>
                      {inv.status === "closed" && <StatusBadge status="cancelled" label="closed" />}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[INVESTMENT_KIND_LABELS[inv.kind], inv.institution, inv.currency].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  <td className="text-right">
                    <span className="block tabular-nums">{money(inv.value, inv.currency)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {inv.valueSource === "cost_basis" ? (
                        <Badge variant="warning" size="sm">
                          at cost · no valuation
                        </Badge>
                      ) : inv.valuationOutdated ? (
                        "money moved since last value"
                      ) : inv.valuedAt ? (
                        `valued ${formatDay(inv.valuedAt, "short")}`
                      ) : null}
                    </span>
                  </td>
                  <td className="hidden text-right tabular-nums md:table-cell">{money(inv.metrics.costBasis, inv.currency)}</td>
                  <td className="hidden text-right sm:table-cell">
                    <GainText value={inv.metrics.unrealizedGain} currency={inv.currency} className="block" />
                    {inv.metrics.realizedGain !== 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {money(inv.metrics.realizedGain, inv.currency, {
                          signed: true,
                        })}{" "}
                        realised
                      </span>
                    )}
                  </td>
                  <td className="hidden text-right tabular-nums md:table-cell">{percentText(inv.metrics.roi)}</td>
                  {canWrite && (
                    <td className="hidden text-right lg:table-cell">
                      {inv.status === "active" && (
                        <span className="inline-flex gap-1">
                          <Button size="xs" variant="outline" onClick={() => setFlow({ investment: inv, direction: "out" })}>
                            Add money
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setFlow({ investment: inv, direction: "in" })}>
                            Withdraw
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setValuing(inv)}>
                            Value
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

export function AddInvestmentButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Add investment
      </Button>
      <InvestmentFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

// ------------------------------------------------------------------- forms

export function InvestmentFormDialog({
  open,
  onOpenChange,
  investment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  investment?: Investment | null;
}) {
  const id = useId();
  const router = useRouter();
  const refresh = useRefresh();
  const { workspace } = useApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<InvestmentKind>("savings_certificate");
  const [institution, setInstitution] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [openedOn, setOpenedOn] = useState("");
  const [maturityDate, setMaturityDate] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [openingCost, setOpeningCost] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(investment?.name ?? "");
    setKind(investment?.kind ?? "savings_certificate");
    setInstitution(investment?.institution ?? "");
    setCurrency(investment?.currency ?? workspace.baseCurrency);
    setOpenedOn(investment?.openedOn ?? "");
    setMaturityDate(investment?.maturityDate ?? "");
    setInterestRate(investment?.interestRate ? String(Number(investment.interestRate)) : "");
    setOpeningCost(investment?.openingCostBasis ? minorToInput(investment.openingCostBasis, investment.currency) : "");
    setCurrentValue("");
    setNotes(investment?.notes ?? "");
  }, [open, investment, workspace.baseCurrency]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const opening = openingCost ? toMinor(openingCost, currency) : 0;
    if (opening === null) return setError("Enter the amount already invested as a number");
    const value = currentValue ? toMinor(currentValue, currency) : null;
    if (currentValue && value === null) return setError("Enter the current value as a number");
    if (interestRate && !/^\d+(\.\d+)?$/.test(interestRate.trim())) return setError("Enter the interest rate as a percentage, e.g. 11.28");
    const body = {
      name: name.trim(),
      kind,
      institution: institution.trim() || null,
      currency,
      openedOn: openedOn || null,
      maturityDate: maturityDate || null,
      interestRate: interestRate.trim() || null,
      openingCostBasis: opening,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      if (investment) {
        await clientApi(`/investments/${investment.id}`, {
          method: "PATCH",
          body,
        });
        toast.success("Investment updated");
        refresh();
      } else {
        const created = await clientApi<InvestmentDetail>("/investments", {
          method: "POST",
          body: { ...body, currentValue: value },
        });
        toast.success("Investment added", {
          description: "Record money you put in with “Add money”.",
        });
        refresh();
        router.push(`/wealth/investments/${created.id}`);
      }
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
            <DialogTitle>{investment ? `Edit ${investment.name}` : "Add investment"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Field label="Name" htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="5-year Sanchayapatra, BRAC DPS, DSE portfolio…"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind" htmlFor={`${id}-kind`}>
                <KindSelect id={`${id}-kind`} value={kind} onChange={setKind} labels={INVESTMENT_KIND_LABELS} />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <CurrencySelect id={`${id}-currency`} value={currency} onChange={setCurrency} />
              </Field>
            </div>
            <Field label="Institution" htmlFor={`${id}-institution`}>
              <Input
                id={`${id}-institution`}
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                placeholder="Bangladesh Bank, BRAC Bank, broker…"
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Opened" htmlFor={`${id}-opened`}>
                <Input id={`${id}-opened`} type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
              </Field>
              <Field label="Matures" htmlFor={`${id}-maturity`}>
                <Input id={`${id}-maturity`} type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
              </Field>
              <Field label="Rate %" htmlFor={`${id}-rate`}>
                <Input id={`${id}-rate`} inputMode="decimal" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} placeholder="11.28" />
              </Field>
            </div>
            <Field
              label="Already invested before tracking"
              htmlFor={`${id}-opening`}
              hint="Its cost basis. New money goes in through “Add money”, which moves it out of an account."
            >
              <MoneyInput id={`${id}-opening`} value={openingCost} onChange={setOpeningCost} currency={currency} placeholder="0" />
            </Field>
            {!investment && (
              <Field label="Worth now" htmlFor={`${id}-value`} hint="Optional. Without a value it counts at cost, and net worth says so.">
                <MoneyInput id={`${id}-value`} value={currentValue} onChange={setCurrentValue} currency={currency} placeholder="Optional" />
              </Field>
            )}
            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {investment ? "Save" : "Add investment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Money into the holding (contribution) or back out (withdrawal / sale). */
export function FlowDialog({
  open,
  onOpenChange,
  investment,
  direction: initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  investment: Investment;
  direction: "out" | "in";
}) {
  const id = useId();
  const refresh = useRefresh();
  const { workspace, money } = useApp();
  const [direction, setDirection] = useState(initial);
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [date, setDate] = useState(today(workspace.timezone));
  const [costBasis, setCostBasis] = useState("");
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDirection(initial);
    setAmount("");
    setAccountId(null);
    setDate(today(workspace.timezone));
    setCostBasis("");
    setNote("");
    setAttachments([]);
    setError(null);
  }, [open, initial, workspace.timezone]);

  const minor = toMinor(amount, investment.currency);
  const basis = costBasis ? toMinor(costBasis, investment.currency) : null;

  // Receipts uploaded for something that was never recorded are removed again.
  const close = (next: boolean) => {
    if (!next) discardNewAttachments(attachments);
    onOpenChange(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!minor) return setError("Enter the amount");
    if (!accountId) return setError(direction === "out" ? "Choose the account the money came from" : "Choose the account the money went into");
    if (costBasis && basis === null) return setError("Enter the cost basis as a number");
    if (!attachments.length) return setError("Attach the statement or receipt. If a file is still uploading, wait for it to finish.");
    setSaving(true);
    setError(null);
    try {
      await clientApi(`/investments/${investment.id}/flows`, {
        method: "POST",
        body: {
          direction,
          amount: minor,
          accountId,
          date,
          costBasis: direction === "in" ? basis : null,
          note: note.trim() || null,
          attachmentFileIds: attachments.length ? attachments.map((file) => file.id) : undefined,
        },
      });
      toast.success(direction === "out" ? "Contribution recorded" : "Withdrawal recorded");
      refresh();
      setAttachments([]);
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
            <DialogTitle>{investment.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="flex gap-1.5">
              <Button type="button" size="xs" variant={direction === "out" ? "default" : "outline"} onClick={() => setDirection("out")}>
                <ArrowUpRight className="size-3.5" /> Add money
              </Button>
              <Button type="button" size="xs" variant={direction === "in" ? "default" : "outline"} onClick={() => setDirection("in")}>
                <ArrowDownLeft className="size-3.5" /> Withdraw / sell
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {direction === "out"
                ? "Moves money from an account into this investment. It is not spending."
                : "Moves money back to an account. The part above what you put in is a realised gain."}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount" htmlFor={`${id}-amount`}>
                <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} currency={investment.currency} required />
              </Field>
              <Field label="Date" htmlFor={`${id}-date`}>
                <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </Field>
            </div>
            <Field label={direction === "out" ? "From account" : "Into account"} htmlFor={`${id}-account`}>
              <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} enabled={open} />
            </Field>
            {direction === "in" && (
              <Field
                label="Cost of what you took out"
                htmlFor={`${id}-basis`}
                hint={`Optional. ${money(investment.metrics.costBasis, investment.currency)} is still invested. Leave empty to treat it all as your own money coming back.`}
              >
                <MoneyInput id={`${id}-basis`} value={costBasis} onChange={setCostBasis} currency={investment.currency} placeholder="Optional" />
              </Field>
            )}
            {direction === "in" && minor && basis !== null && (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm">
                Realised {minor - basis >= 0 ? "gain" : "loss"}: <span className="tabular-nums">{money(Math.abs(minor - basis), investment.currency)}</span>
              </p>
            )}
            <Field label="Note" htmlFor={`${id}-note`}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <AttachmentField value={attachments} onChange={setAttachments} label="Statement or receipt (required)" hint="Saved with the transaction." />
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {direction === "out" ? "Record contribution" : "Record withdrawal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

export function InvestmentDetailView({ investment }: { investment: InvestmentDetail }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [flow, setFlow] = useState<"out" | "in" | null>(null);
  const [valuing, setValuing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const m = investment.metrics;
  const active = investment.status === "active";
  const linked = investment.flows.length;

  const remove = async () => {
    try {
      await clientApi(`/investments/${investment.id}`, {
        method: "DELETE",
        query: { voidLinked: linked > 0 },
      });
      toast.success("Investment deleted");
      refresh();
      router.push("/wealth/investments");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const setStatus = async (status: "active" | "closed") => {
    try {
      await clientApi(`/investments/${investment.id}`, {
        method: "PATCH",
        body: { status },
      });
      toast.success(status === "closed" ? "Investment closed" : "Investment reopened");
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
              {[INVESTMENT_KIND_LABELS[investment.kind], investment.institution, investment.currency].filter(Boolean).join(" · ")}
              {!active && <StatusBadge status="cancelled" label="closed" />}
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{money(investment.value, investment.currency)}</p>
            {investment.valueSource === "cost_basis" ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">No valuation yet — counted at its cost basis. Record a value to see returns.</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Valued {investment.valuedAt ? formatDay(investment.valuedAt) : "—"}
                {investment.valuationOutdated ? " · money moved since then" : ""}
              </p>
            )}
            {investment.base === null && (
              <Link href="/settings/currency" className="text-xs text-amber-600 hover:underline dark:text-amber-400">
                No {investment.currency} exchange rate — left out of net worth.
              </Link>
            )}
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {active && (
                <>
                  <Button size="sm" onClick={() => setFlow("out")}>
                    <ArrowUpRight className="size-3.5" /> Add money
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setFlow("in")}>
                    <ArrowDownLeft className="size-3.5" /> Withdraw
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setValuing(true)}>
                    <TrendingUp className="size-3.5" /> Update value
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void setStatus(active ? "closed" : "active")}>
                {active ? "Close" : "Reopen"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </div>
          )}
        </div>
        <Section title="Value over time">
          <ValuationHistory endpoint={`/investments/${investment.id}`} valuations={investment.valuations} currency={investment.currency} canEdit={canWrite} />
        </Section>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={Coins}
          label="Put in"
          value={money(m.contributed, investment.currency)}
          hint={investment.openingCostBasis ? `incl. ${money(investment.openingCostBasis, investment.currency)} before tracking` : undefined}
        />
        <StatCard
          icon={ArrowDownLeft}
          label="Taken out"
          value={money(m.withdrawn, investment.currency)}
          hint={`${money(m.costBasis, investment.currency)} still invested`}
        />
        <StatCard
          icon={TrendingUp}
          label="Unrealised gain"
          value={<GainText value={m.unrealizedGain} currency={investment.currency} />}
          hint={`${money(m.realizedGain, investment.currency, { signed: true })} realised`}
        />
        <StatCard icon={Percent} label="Return (ROI)" value={percentText(m.roi)} hint="Value + withdrawn − put in, over put in" />
      </div>

      <Section title="Details">
        <Facts
          items={[
            {
              label: "Opened",
              value: investment.openedOn ? formatDay(investment.openedOn) : "—",
            },
            {
              label: "Matures",
              value: investment.maturityDate ? formatDay(investment.maturityDate) : "—",
            },
            {
              label: "Interest rate",
              value: investment.interestRate ? `${Number(investment.interestRate)}%` : "—",
            },
            {
              label: "Cost basis",
              value: money(m.costBasis, investment.currency),
            },
            investment.unconvertedFlows > 0 && {
              label: "Not converted",
              value: `${investment.unconvertedFlows} transactions without an exchange rate`,
            },
            investment.notes ? { label: "Notes", value: investment.notes } : false,
          ]}
        />
      </Section>

      <Section title="Contributions and withdrawals" hint="Investment transactions — kept out of income and spending">
        {linked ? (
          <LinkedTransactions items={investment.flows} empty="" />
        ) : (
          <EmptyNote
            action={
              canWrite && active ? (
                <Button size="xs" variant="outline" onClick={() => setFlow("out")}>
                  <Plus className="size-3.5" /> Add money
                </Button>
              ) : undefined
            }
          >
            No money has moved in or out yet.
          </EmptyNote>
        )}
      </Section>

      <InvestmentFormDialog open={editing} onOpenChange={setEditing} investment={investment} />
      {flow && <FlowDialog open onOpenChange={(open) => !open && setFlow(null)} investment={investment} direction={flow} />}
      <ValuationDialog
        open={valuing}
        onOpenChange={setValuing}
        endpoint={`/investments/${investment.id}`}
        name={investment.name}
        currency={investment.currency}
        currentValue={investment.currentValue ?? m.costBasis}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${investment.name}?`}
        description={
          linked
            ? `Its ${linked} contribution${linked === 1 ? "" : "s"} and withdrawals are voided too, so account balances change back. To keep the history, close it instead.`
            : "It and its valuations are removed."
        }
        confirmLabel={linked ? "Delete and void" : "Delete"}
        onConfirm={remove}
      />
    </div>
  );
}
