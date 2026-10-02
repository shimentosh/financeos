"use client";

import { COMMON_CURRENCIES, GOAL_KINDS, type GoalKind, minorToInput, parseMoneyInput, today } from "@expensewise/core";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { type Attachment, AttachmentField, discardNewAttachments } from "@/components/app/attachment-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { GoalStatus, GoalView, Priority } from "@/lib/api/types/planning";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache, useApi } from "@/lib/use-api";
import { accountOptions, Field, FormError, fromOption, NONE, OptionSelect, useCatalog } from "./shared";

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  savings: "Savings",
  emergency_fund: "Emergency fund",
  asset_purchase: "Asset purchase",
  business_capital: "Business capital",
  travel: "Travel",
  investment: "Investment",
  education: "Education",
  dream_asset: "Dream asset",
  custom: "Other",
};

export const PRIORITY_LABELS: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };
const STATUS_LABELS: Record<GoalStatus, string> = { active: "Active", paused: "Paused", achieved: "Achieved", archived: "Archived" };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: GoalView | null;
  defaultKind?: GoalKind;
  onSaved?: (id: string) => void;
};

/** Goals, dream assets (a price to reach) and savings plans (a monthly amount). */
export function GoalFormDialog({ open, onOpenChange, goal, defaultKind = "savings", onSaved }: Props) {
  const id = useId();
  const router = useRouter();
  const { workspace, isBusiness } = useApp();
  const { accounts } = useCatalog({ projects: isBusiness });
  const [kind, setKind] = useState<GoalKind>(defaultKind);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [targetDate, setTargetDate] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [monthlyPlan, setMonthlyPlan] = useState("");
  const [starting, setStarting] = useState("");
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState<GoalStatus>("active");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picture, setPicture] = useState<Attachment[]>([]);
  const [pictureTouched, setPictureTouched] = useState(false);
  const savedPicture = useApi<Attachment>(open && goal?.imageFileId ? `/files/${goal.imageFileId}/info` : null);

  useEffect(() => {
    if (!open) return;
    const g = goal;
    setPicture([]);
    setPictureTouched(false);
    setError(null);
    setKind(g?.kind ?? defaultKind);
    setName(g?.name ?? "");
    setTarget(g ? minorToInput(g.targetAmount, g.currency) : "");
    setCurrency(g?.currency ?? workspace.baseCurrency);
    setTargetDate(g?.targetDate ?? "");
    setPriority(g?.priority ?? "medium");
    setMonthlyPlan(g?.monthlyPlan ? minorToInput(g.monthlyPlan, g.currency) : "");
    setStarting(g?.startingAmount ? minorToInput(g.startingAmount, g.currency) : "");
    setLinkedAccountId(g?.linkedAccountId ?? null);
    setStatus(g?.status ?? "active");
    setNotes(g?.notes ?? "");
  }, [open, goal, defaultKind, workspace.baseCurrency]);

  useEffect(() => {
    if (open && !pictureTouched && savedPicture.data) setPicture([savedPicture.data]);
  }, [open, pictureTouched, savedPicture.data]);

  const close = (next: boolean) => {
    if (!next) discardNewAttachments(picture);
    onOpenChange(next);
  };

  const dream = kind === "dream_asset";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const targetAmount = parseMoneyInput(target, currency);
    if (!targetAmount) return setError(dream ? "Enter the price of what you want" : "Enter the target amount");
    // An edit waits until the saved picture has loaded.
    const pictureKnown = !goal?.imageFileId || pictureTouched || Boolean(savedPicture.data || savedPicture.error);
    if (pictureKnown && !picture.length) return setError("Add a picture. If it is still uploading, wait for it to finish.");
    const plan = monthlyPlan ? parseMoneyInput(monthlyPlan, currency) : null;
    if (monthlyPlan && plan === null) return setError("Enter the monthly amount as a number");
    const start = starting ? parseMoneyInput(starting, currency) : 0;
    if (start === null) return setError("Enter what you have already saved as a number");
    const body = {
      kind,
      name: name.trim() || GOAL_KIND_LABELS[kind],
      targetAmount,
      currency,
      targetDate: targetDate || null,
      priority,
      monthlyPlan: plan,
      startingAmount: start,
      linkedAccountId,
      notes: notes.trim() || null,
      ...(!goal || pictureTouched ? { imageFileId: picture[0]?.id ?? null } : {}),
      ...(goal ? { status } : {}),
    };
    setSaving(true);
    try {
      const saved = goal
        ? await clientApi<GoalView>(`/goals/${goal.id}`, { method: "PATCH", body })
        : await clientApi<GoalView>("/goals", { method: "POST", body });
      toast.success(goal ? "Goal updated" : `${saved.name} added`);
      if (!goal && saved.status === "achieved") toast.success("Already reached — congratulations!");
      invalidateApiCache("/goals");
      setPicture([]);
      onOpenChange(false);
      onSaved?.(saved.id);
      router.refresh();
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
            <DialogTitle>{goal ? `Edit ${goal.name}` : dream ? "Add a dream asset" : "Set a goal"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {GOAL_KINDS.map((k) => (
                <Button key={k} type="button" size="xs" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)}>
                  {GOAL_KIND_LABELS[k]}
                </Button>
              ))}
            </div>
            <Field label={dream ? "What is it?" : "Name"} htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={dream ? "A car, a MacBook, a flat…" : "Emergency fund, Hajj, Bali trip…"}
              />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <Field label={dream ? "Price" : "Target amount"} htmlFor={`${id}-target`}>
                <Input id={`${id}-target`} inputMode="decimal" required value={target} onChange={(e) => setTarget(e.target.value)} className="tabular-nums" />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <OptionSelect
                  id={`${id}-currency`}
                  value={currency}
                  onChange={setCurrency}
                  options={[...new Set([currency, ...COMMON_CURRENCIES])].map((code) => ({ value: code, label: code }))}
                  placeholder="Currency"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Target date" htmlFor={`${id}-date`} hint="Optional.">
                <Input id={`${id}-date`} type="date" min={today(workspace.timezone)} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
              </Field>
              <Field label="Priority" htmlFor={`${id}-priority`}>
                <OptionSelect
                  id={`${id}-priority`}
                  value={priority}
                  onChange={(v) => setPriority(v as Priority)}
                  options={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))}
                  placeholder="Priority"
                />
              </Field>
              <Field label="Saving each month" htmlFor={`${id}-plan`} hint="Makes it a savings plan.">
                <Input
                  id={`${id}-plan`}
                  inputMode="decimal"
                  value={monthlyPlan}
                  onChange={(e) => setMonthlyPlan(e.target.value)}
                  placeholder="Optional"
                  className="tabular-nums"
                />
              </Field>
              <Field label="Already saved" htmlFor={`${id}-starting`}>
                <Input
                  id={`${id}-starting`}
                  inputMode="decimal"
                  value={starting}
                  onChange={(e) => setStarting(e.target.value)}
                  placeholder="0"
                  className="tabular-nums"
                  disabled={Boolean(linkedAccountId)}
                />
              </Field>
            </div>
            <Field
              label="Track an account's balance"
              htmlFor={`${id}-account`}
              hint="Progress follows that account (e.g. a savings account or DPS) instead of contributions you log."
            >
              <OptionSelect
                id={`${id}-account`}
                value={linkedAccountId ?? NONE}
                onChange={(v) => setLinkedAccountId(fromOption(v))}
                options={accountOptions(accounts, "No — I'll log contributions")}
                placeholder="No account"
              />
            </Field>
            {goal && (
              <Field label="Status" htmlFor={`${id}-status`}>
                <OptionSelect
                  id={`${id}-status`}
                  value={status}
                  onChange={(v) => setStatus(v as GoalStatus)}
                  options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
                  placeholder="Status"
                />
              </Field>
            )}
            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea
                id={`${id}-notes`}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={dream ? "Model, where to buy, why it matters…" : "Optional"}
              />
            </Field>
            <AttachmentField
              value={picture}
              onChange={(next) => {
                setPicture(next);
                setPictureTouched(true);
              }}
              max={1}
              kind="other"
              imagesOnly
              label="Picture (required)"
              hint={dream ? "A photo of what you're saving for keeps it in sight." : null}
              disabled={Boolean(goal?.imageFileId && !savedPicture.data && !savedPicture.error && !pictureTouched)}
            />
            <FormError message={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {goal ? "Save" : dream ? "Add dream asset" : "Add goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Add money to a goal or take some out, optionally moving it between accounts. */
export function ContributionDialog({ goal, mode, onClose }: { goal: GoalView | null; mode: "add" | "withdraw"; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { money, workspace, isBusiness } = useApp();
  const { accounts } = useCatalog({ projects: isBusiness });
  const [kind, setKind] = useState<"add" | "withdraw">(mode);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today(workspace.timezone));
  const [note, setNote] = useState("");
  const [transfer, setTransfer] = useState(false);
  const [fromAccountId, setFromAccountId] = useState<string | null>(null);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!goal) return;
    setKind(mode);
    setAmount(goal.monthlyPlan && mode === "add" ? minorToInput(goal.monthlyPlan, goal.currency) : "");
    setDate(today(workspace.timezone));
    setNote("");
    setError(null);
    setTransfer(Boolean(goal.linkedAccountId));
    setFromAccountId(mode === "withdraw" ? goal.linkedAccountId : null);
    setToAccountId(mode === "add" ? goal.linkedAccountId : null);
  }, [goal, mode, workspace.timezone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!goal) return;
    setError(null);
    const minor = parseMoneyInput(amount, goal.currency);
    if (!minor) return setError("Enter an amount");
    if (transfer && (!fromAccountId || !toAccountId)) return setError("Choose both accounts for the transfer");
    setSaving(true);
    try {
      const result = await clientApi<{ achieved: boolean }>(`/goals/${goal.id}/contributions`, {
        method: "POST",
        body: {
          amount: kind === "add" ? minor : -minor,
          date,
          note: note.trim() || null,
          transfer: transfer ? { fromAccountId, toAccountId } : null,
        },
      });
      toast.success(kind === "add" ? `${money(minor, goal.currency)} added to ${goal.name}` : `${money(minor, goal.currency)} taken from ${goal.name}`);
      if (result.achieved) toast.success(`${goal.name} reached — well done!`);
      invalidateApiCache("/goals");
      onClose();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const options = accountOptions(accounts, "Choose an account");
  return (
    <Dialog open={goal !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{goal ? `${kind === "add" ? "Add to" : "Withdraw from"} ${goal.name}` : "Contribution"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1" role="radiogroup" aria-label="Direction">
              {(["add", "withdraw"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}
                  className={cn(
                    "flex-1 rounded-md px-2.5 py-1 text-xs transition-colors",
                    kind === value ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
                  )}
                >
                  {value === "add" ? "Add money" : "Withdraw"}
                </button>
              ))}
            </div>
            {goal && (
              <p className="text-sm text-muted-foreground">
                {money(goal.current, goal.currency)} of {money(goal.targetAmount, goal.currency)} saved
                {goal.currentSource === "account" && goal.linkedAccountName ? ` (the balance of ${goal.linkedAccountName})` : ""}.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Amount (${goal?.currency ?? ""})`} htmlFor={`${id}-amount`}>
                <Input id={`${id}-amount`} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
              </Field>
              <Field label="Date" htmlFor={`${id}-date`}>
                <Input id={`${id}-date`} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Also move the money between accounts
                  <span className="block text-xs text-muted-foreground">Records a transfer, e.g. from bKash to your savings account.</span>
                </span>
                <Switch checked={transfer} onCheckedChange={setTransfer} />
              </label>
              {transfer && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From" htmlFor={`${id}-from`}>
                    <OptionSelect
                      id={`${id}-from`}
                      value={fromAccountId ?? NONE}
                      onChange={(v) => setFromAccountId(fromOption(v))}
                      options={options}
                      placeholder="Account"
                    />
                  </Field>
                  <Field label="To" htmlFor={`${id}-to`}>
                    <OptionSelect
                      id={`${id}-to`}
                      value={toAccountId ?? NONE}
                      onChange={(v) => setToAccountId(fromOption(v))}
                      options={options}
                      placeholder="Account"
                    />
                  </Field>
                </div>
              )}
            </div>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </Field>
            <FormError message={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {kind === "add" ? "Add money" : "Withdraw"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
