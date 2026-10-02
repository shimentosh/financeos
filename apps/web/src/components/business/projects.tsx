"use client";

import { minorToInput } from "@expensewise/core";
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Flame, FolderKanban, Hourglass, Plus, Repeat, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { EmptyState, ProgressBar, StatCard, StatusBadge } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormError, KindSelect, MoneyInput, toMinor, useRefresh } from "@/components/wealth/shared";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Project } from "@/lib/api/types";
import type { ProjectOverview, ProjectOverviewRow } from "@/lib/api/types/business";
import { cn } from "@/lib/cn";
import { percentText } from "@/lib/format";
import { toast } from "@/lib/toast";
import { drillHref } from "./drill";
import { RangeSelect } from "./range-select";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

function Money({ value, href, className }: { value: number; href?: string; className?: string }) {
  const { money } = useApp();
  const text = <span className={cn("tabular-nums", className)}>{money(value)}</span>;
  return href ? (
    <Link href={href} className="hover:underline underline-offset-4">
      {text}
    </Link>
  ) : (
    text
  );
}

function ProjectCard({ row }: { row: ProjectOverviewRow }) {
  const { money } = useApp();
  const { project, actual, estimated } = row;
  const net = actual.netContribution;
  const utilization = actual.budget?.utilization ?? null;
  return (
    <Link
      href={`/business/projects/${project.id}`}
      className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/30"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{project.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[project.code, project.isDefault ? "Default project" : null].filter(Boolean).join(" · ") || " "}
          </p>
        </div>
        {project.status !== "active" && <StatusBadge status={project.status === "completed" ? "paid" : "paused"} label={STATUS_LABELS[project.status]} />}
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">Revenue</p>
          <Money value={actual.revenue.amount} className="text-money-in" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">Cost</p>
          <Money value={actual.cost.amount} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">Net</p>
          <span className={cn("tabular-nums", net < 0 && "text-red-600 dark:text-red-400")}>{money(net, undefined, { signed: true })}</span>
        </div>
      </div>
      {actual.budget && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Budget {money(actual.budget.amount, undefined, { compact: true })}</span>
            <span className="tabular-nums">{percentText(utilization)} used</span>
          </div>
          <ProgressBar value={utilization ?? 0} tone={(utilization ?? 0) > 100 ? "danger" : (utilization ?? 0) > 80 ? "warn" : "good"} />
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Flame className="size-3" /> {money(actual.monthlyBurn)}/mo burn
          {estimated.runwayMonths !== null && (
            <>
              {" · "}
              <Hourglass className="size-3" /> ~{estimated.runwayMonths} mo left
            </>
          )}
        </span>
        <span className="inline-flex items-center gap-0.5 font-medium text-foreground">
          Open <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

export function ProjectsView({ overview, preset }: { overview: ProjectOverview; preset: string }) {
  const { money, canWrite } = useApp();
  const [creating, setCreating] = useState(false);
  const { totals } = overview;

  if (overview.projects.length === 0) {
    return (
      <>
        <EmptyState
          icon={FolderKanban}
          title="See what each project earns and costs"
          description="Create a project, then tag income and expenses with it. Revenue, cost, burn, budget and runway follow from the ledger."
          action={
            canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" /> New project
              </Button>
            ) : undefined
          }
        />
        <ProjectFormDialog open={creating} onOpenChange={setCreating} />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <RangeSelect preset={preset} fallback="all_time" range={overview.range} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={ArrowDownLeft} label="Revenue" value={money(totals.revenue)} hint="Across projects, actual" tone="good" />
        <StatCard icon={ArrowUpRight} label="Cost" value={money(totals.cost)} hint={`${money(totals.monthlyBurn)}/mo recent burn`} />
        <StatCard
          icon={TrendingUp}
          label="Net contribution"
          value={money(totals.netContribution, undefined, { signed: true })}
          tone={totals.netContribution < 0 ? "danger" : "good"}
        />
        <StatCard
          icon={Repeat}
          label="Recurring costs"
          value={`${money(totals.recurringMonthlyCost)}/mo`}
          hint="Scheduled commitments (expected)"
          href="/commitments"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {overview.projects.map((row) => (
          <ProjectCard key={row.project.id} row={row} />
        ))}
        {(overview.unassigned.revenue.amount !== 0 || overview.unassigned.cost.amount !== 0) && (
          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-4">
            <p className="text-sm font-medium">Not assigned to a project</p>
            <p className="text-xs text-muted-foreground">Tag these to see the full picture per project.</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="text-[11px] text-muted-foreground">Revenue</p>
                <Money value={overview.unassigned.revenue.amount} href={drillHref(overview.unassigned.revenue.drill)} />
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Cost</p>
                <Money value={overview.unassigned.cost.amount} href={drillHref(overview.unassigned.cost.drill)} />
              </div>
            </div>
          </div>
        )}
      </div>
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

export function NewProjectButton() {
  const { canWrite } = useApp();
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> New project
      </Button>
      <ProjectFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ProjectFormDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project?: Project | null }) {
  const id = useId();
  const router = useRouter();
  const refresh = useRefresh();
  const { workspace } = useApp();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Project["status"]>("active");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(project?.name ?? "");
    setCode(project?.code ?? "");
    setStatus(project?.status ?? "active");
    setDescription(project?.description ?? "");
    setStartDate(project?.startDate ?? "");
    setEndDate(project?.endDate ?? "");
    setBudget(project?.budgetAmount ? minorToInput(project.budgetAmount, workspace.baseCurrency) : "");
  }, [open, project, workspace.baseCurrency]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const budgetMinor = budget ? toMinor(budget, workspace.baseCurrency) : null;
    if (budget && budgetMinor === null) return setError("Enter the budget as a number");
    if (startDate && endDate && endDate < startDate) return setError("The end date is before the start date");
    const body = {
      name: name.trim(),
      code: code.trim() || null,
      status,
      description: description.trim() || null,
      startDate: startDate || null,
      endDate: endDate || null,
      budgetAmount: budgetMinor,
    };
    setSaving(true);
    try {
      if (project) {
        await clientApi(`/projects/${project.id}`, { method: "PATCH", body });
        toast.success("Project updated");
        refresh("/projects");
      } else {
        const created = await clientApi<Project>("/projects", {
          method: "POST",
          body,
        });
        toast.success("Project created", {
          description: "Tag income and expenses with it to fill in its numbers.",
        });
        refresh("/projects");
        router.push(`/business/projects/${created.id}`);
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
            <DialogTitle>{project ? `Edit ${project.name}` : "New project"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
              <Field label="Name" htmlFor={`${id}-name`}>
                <Input
                  id={`${id}-name`}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Mobile app, Client X retainer…"
                />
              </Field>
              <Field label="Code" htmlFor={`${id}-code`}>
                <Input id={`${id}-code`} maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} placeholder="APP" />
              </Field>
            </div>
            <Field label="Status" htmlFor={`${id}-status`}>
              <KindSelect id={`${id}-status`} value={status} onChange={setStatus} labels={STATUS_LABELS} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Starts" htmlFor={`${id}-start`}>
                <Input id={`${id}-start`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Ends" htmlFor={`${id}-end`}>
                <Input id={`${id}-end`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            </div>
            <Field label="Lifetime budget" htmlFor={`${id}-budget`} hint="Optional. With a budget, the profile shows how much is used and an estimated runway.">
              <MoneyInput id={`${id}-budget`} value={budget} onChange={setBudget} currency={workspace.baseCurrency} placeholder="Optional" />
            </Field>
            <Field label="Description" htmlFor={`${id}-description`}>
              <Textarea id={`${id}-description`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <FormError error={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {project ? "Save" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
