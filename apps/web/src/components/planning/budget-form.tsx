"use client";

import { minorToInput, parseMoneyInput, startOfMonth, today } from "@financeos/core";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { BudgetPeriod, BudgetView } from "@/lib/api/types/planning";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { categoryOptions, Field, FormError, fromOption, NONE, OptionSelect, projectOptions, useCatalog } from "./shared";

export const PERIOD_LABELS: Record<BudgetPeriod, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  total: "One total (start to end)",
};

type Scope = "workspace" | "category" | "project" | "category_project";

export function BudgetFormDialog({
  open,
  onOpenChange,
  budget,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: BudgetView | null;
  onSaved?: (id: string) => void;
}) {
  const id = useId();
  const router = useRouter();
  const { workspace, isBusiness } = useApp();
  const { categories, projects } = useCatalog({ projects: isBusiness });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("category");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [period, setPeriod] = useState<BudgetPeriod>("monthly");
  const [amount, setAmount] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [threshold, setThreshold] = useState("80");
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const b = budget;
    setError(null);
    setName(b?.name ?? "");
    setScope(b?.scope ?? "category");
    setCategoryId(b?.categoryId ?? null);
    setProjectId(b?.projectId ?? null);
    setPeriod(b?.period ?? "monthly");
    setAmount(b ? minorToInput(b.amount, workspace.baseCurrency) : "");
    setStartDate(b?.startDate ?? startOfMonth(today(workspace.timezone)));
    setEndDate(b?.endDate ?? "");
    setThreshold(String(b?.alertThreshold ?? 80));
    setActive(b?.active ?? true);
    setNotes(b?.notes ?? "");
  }, [open, budget, workspace.baseCurrency, workspace.timezone]);

  const usesCategory = scope === "category" || scope === "category_project";
  const usesProject = scope === "project" || scope === "category_project";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const amountMinor = parseMoneyInput(amount, workspace.baseCurrency);
    if (!amountMinor) return setError("Enter the budget amount, e.g. 15,000");
    if (usesCategory && !categoryId) return setError("Choose the category to budget");
    if (usesProject && !projectId) return setError("Choose the project to budget");
    const alertThreshold = Number(threshold);
    if (!Number.isInteger(alertThreshold) || alertThreshold < 1 || alertThreshold > 200) return setError("The warning threshold is a percentage from 1 to 200");
    const category = usesCategory ? categories.find((c) => c.id === categoryId) : null;
    const project = usesProject ? projects.find((p) => p.id === projectId) : null;
    const body = {
      name: name.trim() || [category?.name, project?.name].filter(Boolean).join(" · ") || "All spending",
      period,
      amount: amountMinor,
      categoryId: usesCategory ? categoryId : null,
      projectId: usesProject ? projectId : null,
      startDate,
      endDate: endDate || null,
      alertThreshold,
      notes: notes.trim() || null,
      ...(budget ? { active } : {}),
    };
    setSaving(true);
    try {
      const saved = budget
        ? await clientApi<{ id: string }>(`/budgets/${budget.id}`, { method: "PATCH", body })
        : await clientApi<{ id: string }>("/budgets", { method: "POST", body });
      toast.success(budget ? "Budget updated" : "Budget created");
      invalidateApiCache("/budgets");
      onOpenChange(false);
      onSaved?.(saved.id);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const scopes: Array<{ value: Scope; label: string }> = [
    { value: "category", label: "A category (with subcategories)" },
    { value: "workspace", label: "All spending" },
    ...(isBusiness
      ? [
          { value: "project" as const, label: "A project" },
          { value: "category_project" as const, label: "A category within a project" },
        ]
      : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{budget ? `Edit ${budget.name}` : "Create budget"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <Field label="What it covers" htmlFor={`${id}-scope`}>
              <OptionSelect id={`${id}-scope`} value={scope} onChange={(v) => setScope(v as Scope)} options={scopes} placeholder="Scope" />
            </Field>
            {usesCategory && (
              <Field label="Category" htmlFor={`${id}-category`} hint="Spending in its subcategories counts too; refunds are subtracted.">
                <OptionSelect
                  id={`${id}-category`}
                  value={categoryId ?? NONE}
                  onChange={(v) => setCategoryId(fromOption(v))}
                  options={categoryOptions(categories, "expense", "Choose a category")}
                  placeholder="Choose a category"
                />
              </Field>
            )}
            {usesProject && (
              <Field label="Project" htmlFor={`${id}-project`}>
                <OptionSelect
                  id={`${id}-project`}
                  value={projectId ?? NONE}
                  onChange={(v) => setProjectId(fromOption(v))}
                  options={projectOptions(projects, "Choose a project")}
                  placeholder="Choose a project"
                />
              </Field>
            )}
            <Field label="Name" htmlFor={`${id}-name`} hint="Leave empty to use the category or project name.">
              <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries, Marketing Q4…" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Period" htmlFor={`${id}-period`}>
                <OptionSelect
                  id={`${id}-period`}
                  value={period}
                  onChange={(v) => setPeriod(v as BudgetPeriod)}
                  options={Object.entries(PERIOD_LABELS).map(([value, label]) => ({ value, label }))}
                  placeholder="Period"
                />
              </Field>
              <Field
                label={`Amount (${workspace.baseCurrency})`}
                htmlFor={`${id}-amount`}
                hint={period === "total" ? "For the whole span." : `Per ${period.replace("ly", "")}.`}
              >
                <Input id={`${id}-amount`} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
              </Field>
              <Field label="Starts" htmlFor={`${id}-start`}>
                <Input id={`${id}-start`} type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Ends" htmlFor={`${id}-end`} hint={period === "total" ? "Optional; open-ended if empty." : "Optional."}>
                <Input id={`${id}-end`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            </div>
            <Field label="Warn me at" htmlFor={`${id}-threshold`} hint="Percent of the budget. You are also told when it is used up.">
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-threshold`}
                  inputMode="numeric"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value.replace(/\D/g, ""))}
                  className="w-20 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </Field>
            {budget && (
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                <span>
                  Active
                  <span className="block text-xs text-muted-foreground">Inactive budgets keep their history but send no alerts.</span>
                </span>
                <Switch checked={active} onCheckedChange={setActive} />
              </label>
            )}
            <Field label="Notes" htmlFor={`${id}-notes`}>
              <Textarea id={`${id}-notes`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <FormError message={error} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {budget ? "Save" : "Create budget"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
