"use client";

import { formatDay, formatMoney, minorToInput, today } from "@financeos/core";
import { Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote } from "@/components/app/blocks";
import { SERIES, TrendChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Valuation } from "@/lib/api/types/wealth";
import { toast } from "@/lib/toast";
import { Field, FormError, MoneyInput, toMinor, useRefresh } from "./shared";

/**
 * Records what a holding is worth on a day. The newest-dated valuation
 * becomes its current value; an older one only fills in the history.
 */
export function ValuationDialog({
  open,
  onOpenChange,
  endpoint,
  name,
  currency,
  currentValue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `/assets/:id` or `/investments/:id`. */
  endpoint: string;
  name: string;
  currency: string;
  currentValue: number | null;
}) {
  const id = useId();
  const { workspace } = useApp();
  const refresh = useRefresh();
  const [value, setValue] = useState("");
  const [date, setDate] = useState(today(workspace.timezone));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(currentValue === null ? "" : minorToInput(currentValue, currency));
    setDate(today(workspace.timezone));
    setNote("");
    setError(null);
  }, [open, currentValue, currency, workspace.timezone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const minor = toMinor(value, currency);
    if (minor === null) return setError("Enter the value as a number, e.g. 1,50,000");
    setSaving(true);
    setError(null);
    try {
      await clientApi(`${endpoint}/valuations`, {
        method: "POST",
        body: { value: minor, date, note: note.trim() || null },
      });
      toast.success("Value recorded");
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
            <DialogTitle>Update value · {name}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              What it would fetch today, or on the date below. Valuations change net worth, never cash or spending.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Value" htmlFor={`${id}-value`}>
                <MoneyInput id={`${id}-value`} value={value} onChange={setValue} currency={currency} required />
              </Field>
              <Field label="As of" htmlFor={`${id}-date`}>
                <Input id={`${id}-date`} type="date" value={date} max={today(workspace.timezone)} onChange={(e) => setDate(e.target.value)} required />
              </Field>
            </div>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Market price, broker statement, appraisal…" />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              Save value
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Value over time from valuations (oldest first on the chart) with the list below. */
export function ValuationHistory({
  endpoint,
  valuations,
  currency,
  canEdit,
}: {
  endpoint: string;
  valuations: Valuation[];
  currency: string;
  canEdit: boolean;
}) {
  const { money, locale } = useApp();
  const refresh = useRefresh();
  const [removing, setRemoving] = useState<string | null>(null);
  if (!valuations.length) return <EmptyNote>No valuations yet. Record one to see how its value changes.</EmptyNote>;
  const points = [...valuations].sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date)));
  const remove = async (valuationId: string) => {
    setRemoving(valuationId);
    try {
      await clientApi(`${endpoint}/valuations/${valuationId}`, {
        method: "DELETE",
      });
      toast.success("Valuation removed");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(null);
    }
  };
  return (
    <div className="space-y-3">
      {points.length > 1 && (
        <TrendChart
          data={points.map((v) => ({ label: v.date, value: v.value }))}
          series={[{ key: "value", label: "Value", color: SERIES.primary }]}
          format={(v) => money(v, currency)}
          axisFormat={(v) => formatMoney(v, currency, { locale, compact: true })}
          tickFormat={(label) => formatDay(label, "short")}
          labelFormat={(label) => formatDay(label)}
          height={180}
          table={false}
        />
      )}
      <ul className="divide-y divide-border">
        {valuations.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block text-sm tabular-nums">{money(v.value, currency)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {formatDay(v.date)}
                {v.note ? ` · ${v.note}` : ""}
              </span>
            </span>
            {canEdit && (
              <Button variant="ghost" size="icon-sm" aria-label="Remove valuation" loading={removing === v.id} onClick={() => void remove(v.id)}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
