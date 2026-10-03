"use client";

import { formatDay, formatMonth, minorToInput, today } from "@financeos/core";
import { Briefcase, CalendarDays, Check, CircleAlert, Pencil, Plus, Send, Trash2, Undo2, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyNote, EmptyState, Section, StatCard, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  AccountSelect,
  ConfirmDialog,
  CurrencySelect,
  Field,
  FormError,
  KindSelect,
  MoneyInput,
  ParamTabs,
  ProjectSelect,
  SwitchRow,
  toMinor,
  useRefresh,
} from "@/components/wealth/shared";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Employee, EmployeeList, EmploymentType, PayrollItem, PayrollRun, PayrollRunDetail } from "@/lib/api/types/business";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contractor: "Contractor",
  intern: "Intern",
};

/** Payroll in a personal workspace: say where it lives instead of failing. */
export function PayrollUnavailable() {
  return (
    <EmptyState
      icon={Users}
      title="Payroll lives in business workspaces"
      description="Switch to your business workspace from the menu at the top of the sidebar to add employees, run monthly payroll and see salary costs by project."
      action={
        <Button size="sm" variant="outline" render={<Link href="/settings/workspace" />}>
          Workspace settings
        </Button>
      }
    />
  );
}

export function PayrollView({ tab, employees, runs, run }: { tab: string; employees: EmployeeList; runs: PayrollRun[]; run: PayrollRunDetail | null }) {
  return (
    <div className="space-y-4">
      <ParamTabs
        param="tab"
        label="Payroll"
        value={tab}
        clear={["run"]}
        options={[
          {
            value: "employees",
            label: "Employees",
            count: employees.totals.activeCount,
          },
          { value: "runs", label: "Payroll runs", count: runs.length },
        ]}
      />
      {tab === "runs" ? <RunsTab runs={runs} run={run} hasEmployees={employees.totals.activeCount > 0} /> : <EmployeesTab employees={employees} />}
    </div>
  );
}

// ---------------------------------------------------------------- employees

/** One project's people: who it pays, and a way into the monthly run (which covers every project). */
export function ProjectPayroll({ employees, projectId }: { employees: EmployeeList; projectId: string }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span>Salaries post as Payroll expenses on this project when you post the month's payroll run. Don't also enter them by hand.</span>
        <Button size="xs" variant="outline" render={<Link href="/business/payroll?tab=runs" />}>
          <Send className="size-3.5" /> Run monthly payroll
        </Button>
      </div>
      <EmployeesTab employees={employees} projectId={projectId} />
    </div>
  );
}

function EmployeesTab({ employees, projectId }: { employees: EmployeeList; projectId?: string }) {
  const { money, canWrite } = useApp();
  const [editing, setEditing] = useState<Employee | null>(null);
  const [creating, setCreating] = useState(false);
  const { items, totals } = employees;

  if (!items.length) {
    return (
      <>
        <EmptyState
          icon={Users}
          title={projectId ? "No one is paid from this project yet" : "Add the people you pay"}
          description={
            projectId
              ? "Add an employee here and their salary counts as this project's cost when the month's payroll is posted."
              : "Salary, pay day, the account they are paid from and the project their cost belongs to. Each month's run then posts one expense per person."
          }
          action={
            canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> Add employee
              </Button>
            ) : undefined
          }
        />
        <EmployeeFormDialog open={creating} onOpenChange={setCreating} defaultProjectId={projectId} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={Users} label="Active employees" value={String(totals.activeCount)} hint={`${items.length - totals.activeCount} inactive`} />
        {totals.monthlySalaryByCurrency.map((row) => (
          <StatCard
            key={row.currency}
            icon={Wallet}
            label={`Monthly salaries · ${row.currency}`}
            value={money(row.monthlySalary, row.currency)}
            hint={`${row.count} people, gross`}
          />
        ))}
        {canWrite && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex min-h-20 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          >
            <Plus className="size-4" /> Add employee
          </button>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Employee</th>
              <th className="text-right!">Monthly salary</th>
              <th className="hidden md:table-cell">Pay day</th>
              {!projectId && <th className="hidden lg:table-cell">Project</th>}
              <th className="hidden lg:table-cell">Paid from</th>
              <th className="hidden w-24 sm:table-cell">Status</th>
              {canWrite && <th className="w-12" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((e) => (
              <tr key={e.id} className={cn("[&>td]:px-3 [&>td]:py-2", e.status === "inactive" && "text-muted-foreground")}>
                <td className="min-w-0">
                  <span className="block truncate font-medium">{e.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[e.title, EMPLOYMENT_LABELS[e.employmentType]].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td className="text-right tabular-nums">{money(e.salary, e.currency)}</td>
                <td className="hidden text-xs md:table-cell">{ordinal(e.payDay)}</td>
                {!projectId && <td className="hidden text-xs lg:table-cell">{e.projectName ?? "—"}</td>}
                <td className="hidden text-xs lg:table-cell">{e.accountName ?? <span className="text-amber-600 dark:text-amber-400">Not set</span>}</td>
                <td className="hidden sm:table-cell">
                  <StatusBadge status={e.status === "active" ? "active" : "cancelled"} label={e.status} />
                </td>
                {canWrite && (
                  <td className="text-right">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${e.name}`} onClick={() => setEditing(e)}>
                      <Pencil className="size-3.5" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <EmployeeFormDialog open={creating} onOpenChange={setCreating} defaultProjectId={projectId} />
      <EmployeeFormDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} employee={editing} />
    </div>
  );
}

function ordinal(day: number) {
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix} of the month`;
}

export function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
  defaultProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: Employee | null;
  /** A new employee starts on this project. */
  defaultProjectId?: string;
}) {
  const id = useId();
  const refresh = useRefresh();
  const { workspace } = useApp();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [employmentType, setEmploymentType] = useState<EmploymentType>("full_time");
  const [salary, setSalary] = useState("");
  const [currency, setCurrency] = useState(workspace.baseCurrency);
  const [payDay, setPayDay] = useState("1");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [notes, setNotes] = useState("");
  const [commitment, setCommitment] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(employee?.name ?? "");
    setTitle(employee?.title ?? "");
    setEmploymentType(employee?.employmentType ?? "full_time");
    setSalary(employee ? minorToInput(employee.salary, employee.currency) : "");
    setCurrency(employee?.currency ?? workspace.baseCurrency);
    setPayDay(String(employee?.payDay ?? 1));
    setProjectId(employee ? employee.defaultProjectId : (defaultProjectId ?? null));
    setAccountId(employee?.accountId ?? null);
    setStartDate(employee?.startDate ?? "");
    setEndDate(employee?.endDate ?? "");
    setStatus(employee?.status ?? "active");
    setNotes(employee?.notes ?? "");
    setCommitment(false);
  }, [open, employee, defaultProjectId, workspace.baseCurrency]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const salaryMinor = toMinor(salary, currency);
    if (!salaryMinor) return setError("Enter the monthly gross salary");
    const day = Number(payDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) return setError("Pay day is a day of the month from 1 to 28");
    const body = {
      name: name.trim(),
      title: title.trim() || null,
      employmentType,
      salary: salaryMinor,
      currency,
      payDay: day,
      defaultProjectId: projectId,
      accountId,
      startDate: startDate || null,
      endDate: endDate || null,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      if (employee) {
        await clientApi(`/payroll/employees/${employee.id}`, {
          method: "PATCH",
          body: { ...body, status },
        });
        toast.success("Employee updated", {
          description: "Draft runs keep their amounts; new runs use the new salary.",
        });
      } else {
        await clientApi("/payroll/employees", {
          method: "POST",
          body: { ...body, createSalaryCommitment: commitment },
        });
        toast.success("Employee added", {
          description: commitment ? "Their salary is on your commitments calendar." : undefined,
        });
      }
      refresh();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!employee) return;
    try {
      const result = await clientApi<{
        deleted?: boolean;
        deactivated?: boolean;
      }>(`/payroll/employees/${employee.id}`, { method: "DELETE" });
      toast.success(result.deleted ? "Employee removed" : "Marked inactive; their payroll history is kept");
      refresh();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{employee ? `Edit ${employee.name}` : "Add employee"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" htmlFor={`${id}-name`}>
                <Input id={`${id}-name`} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Role" htmlFor={`${id}-title`}>
                <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Engineer" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type" htmlFor={`${id}-type`}>
                <KindSelect id={`${id}-type`} value={employmentType} onChange={setEmploymentType} labels={EMPLOYMENT_LABELS} />
              </Field>
              {employee ? (
                <Field label="Status" htmlFor={`${id}-status`}>
                  <KindSelect id={`${id}-status`} value={status} onChange={setStatus} labels={{ active: "Active", inactive: "Inactive" }} />
                </Field>
              ) : (
                <Field label="Pay day" htmlFor={`${id}-payday`}>
                  <Input id={`${id}-payday`} type="number" min={1} max={28} value={payDay} onChange={(e) => setPayDay(e.target.value)} />
                </Field>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Monthly gross salary" htmlFor={`${id}-salary`}>
                <MoneyInput id={`${id}-salary`} value={salary} onChange={setSalary} currency={currency} required />
              </Field>
              <Field label="Currency" htmlFor={`${id}-currency`}>
                <CurrencySelect id={`${id}-currency`} value={currency} onChange={setCurrency} />
              </Field>
            </div>
            {employee && (
              <Field label="Pay day" htmlFor={`${id}-payday2`}>
                <Input id={`${id}-payday2`} type="number" min={1} max={28} value={payDay} onChange={(e) => setPayDay(e.target.value)} />
              </Field>
            )}
            <Field label="Paid from" htmlFor={`${id}-account`} hint="Needed to post payroll.">
              <AccountSelect id={`${id}-account`} value={accountId} onChange={setAccountId} noneLabel="Choose later" enabled={open} />
            </Field>
            <Field label="Cost goes to project" htmlFor={`${id}-project`}>
              <ProjectSelect id={`${id}-project`} value={projectId} onChange={setProjectId} enabled={open} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Started" htmlFor={`${id}-start`}>
                <Input id={`${id}-start`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Leaves" htmlFor={`${id}-end`}>
                <Input id={`${id}-end`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            </div>
            {!employee && (
              <div className="rounded-lg border border-border px-3 py-2">
                <SwitchRow
                  id={`${id}-commitment`}
                  title="Add salary to commitments"
                  hint="A monthly payroll commitment on their pay day, with reminders and cash forecasting."
                  checked={commitment}
                  onCheckedChange={setCommitment}
                />
              </div>
            )}
            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            {employee && (
              <Button type="button" variant="ghost" size="sm" className="me-auto" onClick={() => setRemoving(true)}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {employee ? "Save" : "Add employee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
      {employee && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${employee.name}?`}
          description="Someone who has been paid through payroll is marked inactive so their history stays; otherwise they are deleted."
          confirmLabel="Remove"
          onConfirm={remove}
        />
      )}
    </Dialog>
  );
}

// --------------------------------------------------------------------- runs

function RunsTab({ runs, run, hasEmployees }: { runs: PayrollRun[]; run: PayrollRunDetail | null; hasEmployees: boolean }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const select = (id: string) => router.push(`/business/payroll?tab=runs&run=${id}`, { scroll: false });

  if (!runs.length) {
    return (
      <>
        <EmptyState
          icon={CalendarDays}
          title={hasEmployees ? "Run your first payroll" : "Add employees first"}
          description={
            hasEmployees
              ? "A run drafts each active employee's pay for a month. Adjust deductions, then post it: one expense per person, in the Payroll category and their project."
              : "Payroll runs are drafted from your active employees."
          }
          action={
            canWrite && hasEmployees ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> New payroll run
              </Button>
            ) : !hasEmployees ? (
              <Button size="sm" variant="outline" render={<Link href="/business/payroll" />}>
                Go to employees
              </Button>
            ) : undefined
          }
        />
        <RunCreateDialog open={creating} onOpenChange={setCreating} onCreated={select} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
        <Section
          title="Runs"
          actions={
            canWrite ? (
              <Button size="xs" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> New run
              </Button>
            ) : undefined
          }
        >
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => select(r.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent/50",
                    run?.id === r.id && "bg-accent/60",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{formatMonth(r.period)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.itemCount} people · pay {formatDay(r.payDate, "short")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm tabular-nums">{money(r.totals.net, r.currency)}</span>
                    <StatusBadge status={r.status === "posted" ? "posted" : "draft"} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
        {run ? <RunEditor run={run} /> : <EmptyNote>Choose a run to see and edit it.</EmptyNote>}
      </div>
      <RunCreateDialog open={creating} onOpenChange={setCreating} onCreated={select} />
    </div>
  );
}

function RunCreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const id = useId();
  const refresh = useRefresh();
  const { workspace } = useApp();
  const [period, setPeriod] = useState("");
  const [payDate, setPayDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const day = today(workspace.timezone);
    setPeriod(day.slice(0, 7));
    setPayDate(day);
    setError(null);
  }, [open, workspace.timezone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{4}-\d{2}$/.test(period)) return setError("Choose the month");
    setSaving(true);
    setError(null);
    try {
      const run = await clientApi<PayrollRunDetail>("/payroll/runs", {
        method: "POST",
        body: { period, payDate },
      });
      toast.success(`Draft payroll for ${formatMonth(period)}`, {
        description: `${run.items.length} employees. Review, then post.`,
      });
      refresh();
      onOpenChange(false);
      onCreated(run.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-sm">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>New payroll run</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Drafts pay for everyone active in the month at their current salary. Nothing is posted until you post the run.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Month" htmlFor={`${id}-period`}>
                <Input id={`${id}-period`} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required />
              </Field>
              <Field label="Pay date" htmlFor={`${id}-paydate`}>
                <Input id={`${id}-paydate`} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} required />
              </Field>
            </div>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              Draft run
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function RunEditor({ run }: { run: PayrollRunDetail }) {
  const { money, canWrite } = useApp();
  const router = useRouter();
  const refresh = useRefresh();
  const [confirm, setConfirm] = useState<"post" | "unpost" | "delete" | null>(null);
  const draft = run.status === "draft";
  const missingAccount = run.items.filter((item) => item.net > 0 && !item.accountId);

  const act = async (action: "post" | "unpost" | "delete") => {
    try {
      if (action === "delete") {
        await clientApi(`/payroll/runs/${run.id}`, { method: "DELETE" });
        toast.success("Draft run deleted");
        router.push("/business/payroll?tab=runs");
      } else {
        await clientApi(`/payroll/runs/${run.id}/${action}`, {
          method: "POST",
        });
        toast.success(action === "post" ? "Payroll posted" : "Payroll un-posted", {
          description: action === "post" ? "One expense per employee, in the Payroll category." : "Its expenses were voided; the run is a draft again.",
        });
      }
      refresh("/transactions");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Section
      title={`${formatMonth(run.period)} payroll`}
      hint={`Pay date ${formatDay(run.payDate)} · ${run.itemCount} people`}
      actions={<StatusBadge status={draft ? "draft" : "posted"} />}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">
            Net pay
            {run.totals.byCurrency.length > 1 ? `, in ${run.currency} at the pay date` : ""}
          </p>
          <p className="text-2xl font-semibold tabular-nums">{money(run.totals.net, run.currency)}</p>
          {run.totals.byCurrency.map((c) => (
            <p key={c.currency} className="text-xs text-muted-foreground tabular-nums">
              {c.currency}: gross {money(c.gross, c.currency)} − deductions {money(c.deductions, c.currency)} = {money(c.net, c.currency)}
            </p>
          ))}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {draft ? (
              <>
                <Button size="sm" onClick={() => setConfirm("post")} disabled={missingAccount.length > 0}>
                  <Send className="size-3.5" /> Post payroll
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm("delete")}>
                  <Trash2 className="size-3.5" /> Delete draft
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <Link
                      href={`/transactions?period=all_time&ids=${run.items
                        .map((i) => i.transactionId)
                        .filter(Boolean)
                        .join(",")}`}
                    />
                  }
                >
                  View expenses
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm("unpost")}>
                  <Undo2 className="size-3.5" /> Un-post
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {draft && missingAccount.length > 0 && (
        <p className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <CircleAlert className="size-3.5 shrink-0" /> Choose the account to pay {missingAccount.map((i) => i.employeeName).join(", ")} from before posting.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Employee</th>
              <th className="w-36 text-right!">Gross</th>
              <th className="w-36 text-right!">Deductions</th>
              <th className="w-28 text-right!">Net</th>
              <th className="hidden min-w-40 lg:table-cell">Project · Account</th>
              {draft && canWrite && <th className="w-16" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {run.items.map((item) => (
              <ItemRow key={item.id} runId={run.id} item={item} editable={draft && canWrite} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Posting records net pay as an expense per person. Deductions such as withheld tax are paid on separately — record them when you pay them.
      </p>
      <ConfirmDialog
        open={confirm === "post"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Post ${formatMonth(run.period)} payroll?`}
        description={`${run.items.filter((i) => i.net > 0).length} expenses totalling ${money(run.totals.net, run.currency)} are recorded on ${formatDay(run.payDate)}, each in its employee's project. You can un-post it later.`}
        confirmLabel="Post payroll"
        destructive={false}
        onConfirm={() => act("post")}
      />
      <ConfirmDialog
        open={confirm === "unpost"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Un-post this payroll?"
        description="Its expenses are voided, account balances change back, and the run returns to draft so you can edit it."
        confirmLabel="Un-post"
        onConfirm={() => act("unpost")}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this draft?"
        description="Nothing was posted from it. You can draft the month again later."
        confirmLabel="Delete draft"
        onConfirm={() => act("delete")}
      />
    </Section>
  );
}

function ItemRow({ runId, item, editable }: { runId: string; item: PayrollItem; editable: boolean }) {
  const { money } = useApp();
  const refresh = useRefresh();
  const [gross, setGross] = useState(minorToInput(item.gross, item.currency));
  const [deductions, setDeductions] = useState(minorToInput(item.deductions, item.currency));
  const [projectId, setProjectId] = useState<string | null>(item.projectId);
  const [accountId, setAccountId] = useState<string | null>(item.accountId);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setGross(minorToInput(item.gross, item.currency));
    setDeductions(minorToInput(item.deductions, item.currency));
    setProjectId(item.projectId);
    setAccountId(item.accountId);
  }, [item]);

  const grossMinor = toMinor(gross, item.currency);
  const deductionsMinor = deductions.trim() ? toMinor(deductions, item.currency) : 0;
  const dirty = grossMinor !== item.gross || deductionsMinor !== item.deductions || projectId !== item.projectId || accountId !== item.accountId;
  const invalid = grossMinor === null || grossMinor <= 0 || deductionsMinor === null || deductionsMinor > (grossMinor ?? 0);
  const net = !invalid ? (grossMinor as number) - (deductionsMinor as number) : null;

  const save = async () => {
    if (invalid) return toast.error("Gross must be positive and deductions no more than gross");
    setSaving(true);
    try {
      await clientApi(`/payroll/runs/${runId}/items/${item.id}`, {
        method: "PATCH",
        body: {
          gross: grossMinor,
          deductions: deductionsMinor,
          projectId,
          accountId,
        },
      });
      toast.success(`${item.employeeName} updated`);
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="align-top [&>td]:px-3 [&>td]:py-2">
      <td className="min-w-0">
        <span className="block truncate font-medium">{item.employeeName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[item.employeeTitle, item.currency].filter(Boolean).join(" · ")}
          <span className="lg:hidden">{item.projectName ? ` · ${item.projectName}` : ""}</span>
        </span>
        {editable && (
          <div className="mt-1.5 grid gap-1.5 lg:hidden">
            <ProjectSelect value={projectId} onChange={setProjectId} />
            <AccountSelect value={accountId} onChange={setAccountId} noneLabel="No account" />
          </div>
        )}
        {item.transactionId && (
          <Link href={`/transactions?period=all_time&ids=${item.transactionId}`} className="text-xs text-muted-foreground hover:text-foreground">
            <Check className="me-0.5 inline size-3" /> Expense {item.transactionStatus === "void" ? "voided" : "posted"}
          </Link>
        )}
      </td>
      <td className="text-right">
        {editable ? (
          <Input
            size="sm"
            inputMode="decimal"
            className="text-right tabular-nums"
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            aria-label="Gross"
          />
        ) : (
          <span className="tabular-nums">{money(item.gross, item.currency)}</span>
        )}
      </td>
      <td className="text-right">
        {editable ? (
          <Input
            size="sm"
            inputMode="decimal"
            className="text-right tabular-nums"
            value={deductions}
            onChange={(e) => setDeductions(e.target.value)}
            aria-label="Deductions"
          />
        ) : (
          <span className="tabular-nums">{money(item.deductions, item.currency)}</span>
        )}
      </td>
      <td className={cn("text-right font-medium tabular-nums", invalid && "text-red-600 dark:text-red-400")}>
        {net === null ? "—" : money(net, item.currency)}
      </td>
      <td className="hidden lg:table-cell">
        {editable ? (
          <div className="grid gap-1.5">
            <ProjectSelect value={projectId} onChange={setProjectId} />
            <AccountSelect value={accountId} onChange={setAccountId} noneLabel="No account" />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Briefcase className="size-3" /> {item.projectName ?? "No project"}
            </span>
            <span className="flex items-center gap-1">
              <Wallet className="size-3" /> {item.accountName ?? "No account"}
            </span>
          </span>
        )}
      </td>
      {editable && (
        <td className="text-right">
          {dirty && (
            <Button size="xs" loading={saving} disabled={invalid} onClick={() => void save()}>
              Save
            </Button>
          )}
        </td>
      )}
    </tr>
  );
}
