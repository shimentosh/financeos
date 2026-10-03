"use client";

import { parseMoneyInput } from "@financeos/core";
import { CalendarClock, Coins, CreditCard, Search, Sparkles, TrendingUp, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EmptyNote, Section, StatCard } from "@/components/app/blocks";
import { OptionSelect } from "@/components/planning/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { AdminBillingPayment, AdminBillingSummary, AdminBillingUser, AdminCreditsInput, AdminPlanInput, PlanId } from "@/lib/api/types/billing";
import { money } from "@/lib/format";
import { toast } from "@/lib/toast";
import { AdminTable } from "../admin/admin-page";
import { dateText } from "./billing-view";

const PLAN_NAMES: Record<PlanId, string> = { free: "Free", pro: "Pro", business: "Business" };
const STATUS_VARIANT: Record<string, "success" | "info" | "warning" | "error" | "secondary"> = {
  active: "success",
  trialing: "info",
  past_due: "error",
  canceled: "warning",
  expired: "secondary",
};

const amounts = (rows: Array<{ currency: string; amount: number }>) =>
  rows.length ? rows.map((r) => money(r.amount, r.currency, { trimZeroFraction: true })).join(" · ") : "—";

export function AdminBillingSummaryCards({ summary }: { summary: AdminBillingSummary }) {
  const paid = summary.subscriptions.pro + summary.subscriptions.business;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <StatCard
        icon={Users}
        label="Paying"
        value={paid.toLocaleString()}
        hint={`${summary.subscriptions.pro} Pro · ${summary.subscriptions.business} Business`}
        tone="good"
      />
      <StatCard
        icon={CalendarClock}
        label="Trials"
        value={summary.subscriptions.trialing.toLocaleString()}
        hint={`${summary.subscriptions.free.toLocaleString()} on Free`}
        tone="info"
      />
      <StatCard
        icon={TrendingUp}
        label="Monthly recurring (est.)"
        value={amounts(summary.mrr)}
        hint={summary.subscriptions.pastDue ? `${summary.subscriptions.pastDue} past due` : "Yearly plans ÷ 12"}
      />
      <StatCard
        icon={CreditCard}
        label="Revenue, 30 days"
        value={amounts(summary.revenue30d)}
        hint={`${summary.revenue30d.reduce((n, r) => n + r.payments, 0)} payments`}
      />
      <StatCard
        icon={Sparkles}
        label="AI credits, 30 days"
        value={summary.credits30d.used.toLocaleString()}
        hint={`used · ${summary.credits30d.sold.toLocaleString()} sold · ${summary.credits30d.granted.toLocaleString()} granted`}
      />
    </div>
  );
}

function ManualPayment({
  on,
  setOn,
  amount,
  setAmount,
  currency,
  setCurrency,
  reference,
  setReference,
}: {
  on: boolean;
  setOn: (v: boolean) => void;
  amount: string;
  setAmount: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  reference: string;
  setReference: (v: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Record a payment
          <span className="block text-xs text-muted-foreground">A transfer or bKash payment received outside the app. The user gets a receipt.</span>
        </span>
        <Switch checked={on} onCheckedChange={setOn} />
      </label>
      {on && (
        <div className="grid grid-cols-[5rem_1fr] gap-2">
          <Input aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          <Input aria-label="Amount" inputMode="decimal" placeholder="600" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input
            className="col-span-2"
            aria-label="Reference"
            placeholder="Transaction ID or reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

function paymentFrom(on: boolean, amount: string, currency: string, reference: string) {
  if (!on) return null;
  const code = currency.trim().toUpperCase();
  const minor = /^[A-Z]{3}$/.test(code) ? parseMoneyInput(amount, code) : null;
  if (minor === null || minor <= 0) throw new Error("Enter the amount received and its currency");
  if (!reference.trim()) throw new Error("Enter the payment's reference");
  return { amount: minor, currency: code, reference: reference.trim() };
}

function PlanDialog({ user, onClose }: { user: AdminBillingUser | null; onClose: (changed: boolean) => void }) {
  const [plan, setPlan] = useState<PlanId>("pro");
  const [status, setStatus] = useState<"active" | "trialing" | "canceled">("active");
  const [interval, setBillingPeriod] = useState<"none" | "month" | "year">("month");
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [paid, setPaid] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setPlan(user.plan === "free" ? "pro" : user.plan);
    setStatus("active");
    setBillingPeriod("month");
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1);
    setUntil(next.toISOString().slice(0, 10));
    setNote("");
    setPaid(false);
    setAmount("");
    setReference("");
  }, [user]);

  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const body: AdminPlanInput = {
        plan,
        status,
        interval: interval === "none" ? null : interval,
        periodEnd: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
        note: note.trim() || null,
        payment: paymentFrom(paid, amount, currency, reference),
      };
      await clientApi(`/admin/billing/users/${encodeURIComponent(user.id)}/plan`, { method: "POST", body });
      toast.success(`${user.email} is on ${PLAN_NAMES[plan]}`);
      onClose(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose(false)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set plan</DialogTitle>
          <DialogDescription>{user?.email}. Replaces their current plan; a card subscription in Stripe is not changed by this.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Plan</Label>
              <OptionSelect
                value={plan}
                onChange={(v) => setPlan(v as PlanId)}
                placeholder="Plan"
                options={(["free", "pro", "business"] as const).map((id) => ({ value: id, label: PLAN_NAMES[id] }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <OptionSelect
                value={status}
                onChange={(v) => setStatus(v as typeof status)}
                placeholder="Status"
                options={[
                  { value: "active", label: "Active" },
                  { value: "trialing", label: "Trial" },
                  { value: "canceled", label: "Canceled (runs to the end date)" },
                ]}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Until</Label>
              <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">Empty: until changed.</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Billing period</Label>
              <OptionSelect
                value={interval}
                onChange={(v) => setBillingPeriod(v as typeof interval)}
                placeholder="Period"
                options={[
                  { value: "month", label: "Monthly" },
                  { value: "year", label: "Yearly" },
                  { value: "none", label: "None" },
                ]}
              />
            </div>
          </div>
          <ManualPayment
            on={paid}
            setOn={setPaid}
            amount={amount}
            setAmount={setAmount}
            currency={currency}
            setCurrency={setCurrency}
            reference={reference}
            setReference={setReference}
          />
          <div className="space-y-1">
            <Label className="text-xs">Note (audit log)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why" />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => void save()}>
            Set plan
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CreditsDialog({ user, onClose }: { user: AdminBillingUser | null; onClose: (changed: boolean) => void }) {
  const [credits, setCredits] = useState("500");
  const [note, setNote] = useState("");
  const [paid, setPaid] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setCredits("500");
    setNote("");
    setPaid(false);
    setAmount("");
    setReference("");
  }, [user]);

  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const value = Number(credits.replace(/,/g, ""));
      if (!Number.isInteger(value) || value === 0) throw new Error("Enter a whole number of credits (negative to remove)");
      if (note.trim().length < 2) throw new Error("Add a note: it goes in the audit log");
      const body: AdminCreditsInput = { credits: value, note: note.trim(), payment: paymentFrom(paid, amount, currency, reference) };
      await clientApi(`/admin/billing/users/${encodeURIComponent(user.id)}/credits`, { method: "POST", body });
      toast.success(`${value > 0 ? "Added" : "Removed"} ${Math.abs(value).toLocaleString()} credits`);
      onClose(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose(false)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add AI credits</DialogTitle>
          <DialogDescription>
            {user?.email}. Added to their balance (never expires). Now:{" "}
            {user?.credits
              ? `${user.credits.balance.toLocaleString()} bought, ${user.credits.remainingAllowance.toLocaleString()} left this month`
              : "billing is off"}
            .
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Credits</Label>
            <Input inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">A negative number removes credits.</p>
          </div>
          <ManualPayment
            on={paid}
            setOn={setPaid}
            amount={amount}
            setAmount={setAmount}
            currency={currency}
            setCurrency={setCurrency}
            reference={reference}
            setReference={setReference}
          />
          <div className="space-y-1">
            <Label className="text-xs">Note (audit log)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Launch gift, refund, bKash payment…" />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The people on the installation with their plan and credits, and what they paid. */
export function AdminBillingPeople({
  users: initialUsers,
  payments,
  enabled,
}: {
  users: AdminBillingUser[];
  payments: AdminBillingPayment[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState(initialUsers);
  const [planFor, setPlanFor] = useState<AdminBillingUser | null>(null);
  const [creditsFor, setCreditsFor] = useState<AdminBillingUser | null>(null);
  const first = useRef(true);

  useEffect(() => setUsers(initialUsers), [initialUsers]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      clientApi<AdminBillingUser[]>("/admin/billing/users", { query: { q: q.trim() || undefined }, signal: controller.signal })
        .then(setUsers)
        .catch((error) => {
          if (!controller.signal.aborted) toast.error(errorMessage(error));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  const refresh = async (changed: boolean) => {
    setPlanFor(null);
    setCreditsFor(null);
    if (!changed) return;
    setUsers(await clientApi<AdminBillingUser[]>("/admin/billing/users", { query: { q: q.trim() || undefined } }));
    router.refresh();
  };

  return (
    <>
      <Section
        title="People"
        hint={enabled ? "Plans are per person and cover every workspace they own." : "Billing is off: plans are not enforced, but you can prepare them."}
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input className="h-8 w-56 pl-8" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        }
      >
        <AdminTable
          headers={["Person", "Plan", "Until", "Workspaces", { label: "AI credits", align: "right" }, ""]}
          empty={users.length ? undefined : <EmptyNote>{q ? `Nobody matches “${q}”.` : "People appear here as they sign up."}</EmptyNote>}
        >
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <p className="font-medium">{user.name}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
              </td>
              <td>
                <span className="flex flex-wrap items-center gap-1.5">
                  {PLAN_NAMES[user.plan]}
                  <Badge variant={STATUS_VARIANT[user.status] ?? "secondary"} className="capitalize">
                    {user.status.replace("_", " ")}
                  </Badge>
                  {user.cancelAtPeriodEnd && <Badge variant="warning">Not renewing</Badge>}
                </span>
                {user.provider && <p className="text-xs text-muted-foreground capitalize">{user.provider}</p>}
              </td>
              <td className="whitespace-nowrap text-xs">{user.status === "trialing" ? dateText(user.trialEndsAt) : dateText(user.currentPeriodEnd)}</td>
              <td className="tabular-nums">{user.workspacesOwned}</td>
              <td className="text-right text-xs tabular-nums">
                {user.credits ? (
                  <>
                    {user.credits.remainingAllowance.toLocaleString()} left
                    <span className="block text-muted-foreground">{user.credits.balance.toLocaleString()} bought</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="text-right">
                <div className="flex justify-end gap-1">
                  <Button size="xs" variant="outline" onClick={() => setPlanFor(user)}>
                    Set plan
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => setCreditsFor(user)}>
                    <Coins aria-hidden /> Credits
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </AdminTable>
      </Section>

      <Section title="Recent payments" hint="Card, SSLCommerz and manual payments, newest first.">
        <AdminTable
          headers={["Date", "Person", "Item", "Provider", { label: "Amount", align: "right" }, "Status", "Reference"]}
          empty={payments.length ? undefined : <EmptyNote>Payments appear here once people upgrade or buy credits.</EmptyNote>}
        >
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td className="whitespace-nowrap text-xs">{dateText(payment.paidAt ?? payment.createdAt)}</td>
              <td className="text-xs">{payment.userEmail ?? payment.userId}</td>
              <td className="text-xs">
                {payment.purpose === "credits"
                  ? `${(payment.credits ?? 0).toLocaleString()} credits`
                  : `${payment.plan ? PLAN_NAMES[payment.plan] : "Plan"}${payment.interval ? ` · ${payment.interval}` : ""}`}
              </td>
              <td className="text-xs capitalize">{payment.provider}</td>
              <td className="text-right tabular-nums">{money(payment.amount, payment.currency)}</td>
              <td>
                <Badge variant={payment.status === "paid" ? "success" : payment.status === "pending" ? "info" : "secondary"} className="capitalize">
                  {payment.status}
                </Badge>
              </td>
              <td className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">
                {payment.receiptUrl ? (
                  <a href={payment.receiptUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {payment.providerRef}
                  </a>
                ) : (
                  payment.providerRef
                )}
              </td>
            </tr>
          ))}
        </AdminTable>
      </Section>

      <PlanDialog user={planFor} onClose={(changed) => void refresh(changed)} />
      <CreditsDialog user={creditsFor} onClose={(changed) => void refresh(changed)} />
    </>
  );
}
