"use client";

import { Archive, FlaskConical, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { CATEGORY_TILE, CategoryTile } from "@/components/app/blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/side-dialog";
import { Switch } from "@/components/ui/switch";
import { clientApi, errorMessage } from "@/lib/api/client";
import type { Account, Category, Project, Rule } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { invalidateApiCache } from "@/lib/use-api";
import { SettingsCard } from "./settings-page";

const NONE = "__none__";
const ICONS = [
  "utensils",
  "shopping-basket",
  "car",
  "house",
  "receipt",
  "zap",
  "wifi",
  "smartphone",
  "shopping-bag",
  "heart-pulse",
  "graduation-cap",
  "users",
  "plane",
  "repeat",
  "sparkles",
  "server",
  "megaphone",
  "code",
  "briefcase",
  "gift",
  "landmark",
  "package",
  "circle-dashed",
];

// ------------------------------------------------------------------ categories

export function CategorySettings({ categories }: { categories: Category[] }) {
  const { canWrite } = useApp();
  const router = useRouter();
  const [editing, setEditing] = useState<Category | "new-expense" | "new-income" | null>(null);

  const archive = async (category: Category) => {
    try {
      const result = await clientApi<{ archived?: boolean }>(`/categories/${category.id}`, { method: "DELETE" });
      toast.success(result.archived ? `${category.name} archived; its transactions keep it` : `${category.name} deleted`);
      invalidateApiCache("/categories");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const section = (kind: "expense" | "income") => {
    const list = categories.filter((c) => c.kind === kind);
    const parents = list.filter((c) => !c.parentId);
    return (
      <SettingsCard
        title={kind === "expense" ? "Spending categories" : "Income categories"}
        footer={
          canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(kind === "expense" ? "new-expense" : "new-income")}>
              <Plus className="size-3.5" /> Add category
            </Button>
          ) : undefined
        }
      >
        <ul className="divide-y divide-border">
          {parents.map((parent) => (
            <li key={parent.id} className="py-1.5">
              <CategoryRow category={parent} onEdit={() => setEditing(parent)} onArchive={() => void archive(parent)} canWrite={canWrite} />
              {list
                .filter((child) => child.parentId === parent.id)
                .map((child) => (
                  <div key={child.id} className="ps-9">
                    <CategoryRow category={child} onEdit={() => setEditing(child)} onArchive={() => void archive(child)} canWrite={canWrite} />
                  </div>
                ))}
            </li>
          ))}
        </ul>
      </SettingsCard>
    );
  };

  return (
    <>
      {section("expense")}
      {section("income")}
      <CategoryDialog
        category={typeof editing === "object" ? editing : null}
        kind={editing === "new-income" ? "income" : editing === "new-expense" ? "expense" : typeof editing === "object" && editing ? editing.kind : "expense"}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        parents={categories.filter((c) => !c.parentId && !c.archived)}
      />
    </>
  );
}

function CategoryRow({ category, onEdit, onArchive, canWrite }: { category: Category; onEdit: () => void; onArchive: () => void; canWrite: boolean }) {
  return (
    <div className={cn("group flex items-center gap-3 py-1", category.archived && "opacity-50")}>
      <CategoryTile icon={category.icon} color={category.color} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm">{category.name}</span>
      {category.archived && <Badge variant="outline">Archived</Badge>}
      {canWrite && !category.archived && (
        <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 touch:opacity-100">
          <Button size="icon-xs" variant="ghost" aria-label={`Edit ${category.name}`} onClick={onEdit}>
            <Pencil />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={`Archive ${category.name}`} onClick={onArchive}>
            <Archive />
          </Button>
        </span>
      )}
    </div>
  );
}

function CategoryDialog({
  category,
  kind,
  open,
  onOpenChange,
  parents,
}: {
  category: Category | null;
  kind: "expense" | "income";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parents: Category[];
}) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(NONE);
  const [icon, setIcon] = useState("circle-dashed");
  const [color, setColor] = useState("neutral");
  const [busy, setBusy] = useState(false);
  const [initialised, setInitialised] = useState<string | null>(null);

  const key = `${open}:${category?.id ?? kind}`;
  if (open && initialised !== key) {
    setInitialised(key);
    setName(category?.name ?? "");
    setParentId(category?.parentId ?? NONE);
    setIcon(category?.icon ?? "circle-dashed");
    setColor(category?.color ?? "neutral");
  }

  const save = async () => {
    setBusy(true);
    const body = { name: name.trim(), kind, parentId: parentId === NONE ? null : parentId, icon, color };
    try {
      if (category) await clientApi(`/categories/${category.id}`, { method: "PATCH", body });
      else await clientApi("/categories", { method: "POST", body });
      toast.success(category ? "Category updated" : "Category added");
      invalidateApiCache("/categories");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{category ? `Edit ${category.name}` : `New ${kind} category`}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>Inside</Label>
            <Select value={parentId} onValueChange={(v) => typeof v === "string" && setParentId(v)}>
              <SelectTrigger>
                <SelectValue>{parents.find((p) => p.id === parentId)?.name ?? "Top level"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Top level</SelectItem>
                {parents
                  .filter((p) => p.kind === kind && p.id !== category?.id)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {ICONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setIcon(name)}
                  className={cn("rounded-md p-0.5 ring-offset-1", icon === name && "ring-2 ring-ring")}
                  aria-label={name}
                >
                  <CategoryTile icon={name} color={color} size="sm" />
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(CATEGORY_TILE).map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setColor(name)}
                  aria-label={name}
                  className={cn("size-6 rounded-md ring-offset-1", CATEGORY_TILE[name], color === name && "ring-2 ring-ring")}
                />
              ))}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ----------------------------------------------------------------------- rules

const FIELDS = [
  { value: "merchant", label: "Merchant" },
  { value: "description", label: "Description" },
  { value: "amount", label: "Amount" },
  { value: "currency", label: "Currency" },
  { value: "account", label: "Account" },
  { value: "source", label: "Source" },
  { value: "reference", label: "Reference" },
];
const TEXT_OPERATORS = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "is" },
  { value: "starts_with", label: "starts with" },
  { value: "not_contains", label: "does not contain" },
];
const NUMBER_OPERATORS = [
  { value: "gt", label: "is more than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "equals", label: "equals" },
];

type Condition = { field: string; operator: string; value: string };

export function RuleSettings({ rules, categories, projects, accounts }: { rules: Rule[]; categories: Category[]; projects: Project[]; accounts: Account[] }) {
  const { canWrite, money } = useApp();
  const router = useRouter();
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [testing, setTesting] = useState(false);

  const describe = (rule: Rule) => {
    const conditions = rule.conditions
      .map((c) => {
        const field = FIELDS.find((f) => f.value === c.field)?.label ?? c.field;
        const operator = [...TEXT_OPERATORS, ...NUMBER_OPERATORS].find((o) => o.value === c.operator)?.label ?? c.operator;
        const value =
          c.field === "amount" ? money(Number(c.value)) : c.field === "account" ? (accounts.find((a) => a.id === c.value)?.name ?? c.value) : `“${c.value}”`;
        return `${field} ${operator} ${value}`;
      })
      .join(rule.match === "all" ? " and " : " or ");
    const actions = [
      rule.actions.categoryId && `category → ${categories.find((c) => c.id === rule.actions.categoryId)?.name ?? "?"}`,
      rule.actions.projectId && `project → ${projects.find((p) => p.id === rule.actions.projectId)?.name ?? "?"}`,
      rule.actions.type && `type → ${rule.actions.type}`,
      rule.actions.requireReview && "ask me to confirm",
      rule.actions.ignore && "skip when importing",
    ]
      .filter(Boolean)
      .join(", ");
    return { conditions, actions };
  };

  const remove = async (rule: Rule) => {
    try {
      await clientApi(`/rules/${rule.id}`, { method: "DELETE" });
      toast.success("Rule deleted");
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const toggle = async (rule: Rule, enabled: boolean) => {
    try {
      await clientApi(`/rules/${rule.id}`, { method: "PUT", body: { enabled } });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <>
      <SettingsCard
        title="Rules"
        description="Run before any AI: a rule that decides the category means no model call is made. Lower numbers run first."
        footer={
          canWrite ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setTesting(true)}>
                <FlaskConical className="size-3.5" /> Test
              </Button>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus className="size-3.5" /> New rule
              </Button>
            </>
          ) : undefined
        }
      >
        {rules.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No rules yet. Example: if the merchant contains “OpenAI”, set the category to AI &amp; APIs.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rules.map((rule) => {
              const text = describe(rule);
              return (
                <li key={rule.id} className="flex items-start gap-3 py-2.5">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(value) => void toggle(rule, value)}
                    disabled={!canWrite}
                    aria-label={`Enable ${rule.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      <span className="me-1.5 rounded bg-muted px-1 text-[11px] tabular-nums text-muted-foreground">{rule.priority}</span>
                      {rule.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      If {text.conditions} → {text.actions}
                    </p>
                    <p className="text-[11px] text-muted-foreground/80">Applied {rule.timesApplied} times</p>
                  </div>
                  {canWrite && (
                    <div className="flex gap-1">
                      <Button size="icon-xs" variant="ghost" aria-label="Edit rule" onClick={() => setEditing(rule)}>
                        <Pencil />
                      </Button>
                      <Button size="icon-xs" variant="ghost" aria-label="Delete rule" onClick={() => void remove(rule)}>
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>
      <RuleDialog
        open={editing !== null}
        rule={editing === "new" ? null : editing}
        onOpenChange={(open) => !open && setEditing(null)}
        categories={categories}
        projects={projects}
        accounts={accounts}
      />
      <RuleTestDialog open={testing} onOpenChange={setTesting} describe={describe} rules={rules} />
    </>
  );
}

function RuleDialog({
  open,
  rule,
  onOpenChange,
  categories,
  projects,
  accounts,
}: {
  open: boolean;
  rule: Rule | null;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  projects: Project[];
  accounts: Account[];
}) {
  const router = useRouter();
  const { isBusiness, workspace } = useApp();
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("100");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [categoryId, setCategoryId] = useState(NONE);
  const [projectId, setProjectId] = useState(NONE);
  const [requireReview, setRequireReview] = useState(false);
  const [ignore, setIgnore] = useState(false);
  const [stop, setStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [initialised, setInitialised] = useState<string | null>(null);

  const key = `${open}:${rule?.id ?? "new"}`;
  if (open && initialised !== key) {
    setInitialised(key);
    setName(rule?.name ?? "");
    setPriority(String(rule?.priority ?? 100));
    setMatch(rule?.match ?? "all");
    setConditions(
      rule?.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.field === "amount" ? String(Number(c.value) / 100) : String(c.value),
      })) ?? [{ field: "merchant", operator: "contains", value: "" }],
    );
    setCategoryId(rule?.actions.categoryId ?? NONE);
    setProjectId(rule?.actions.projectId ?? NONE);
    setRequireReview(Boolean(rule?.actions.requireReview));
    setIgnore(Boolean(rule?.actions.ignore));
    setStop(Boolean(rule?.stopProcessing));
  }

  const setCondition = (index: number, change: Partial<Condition>) =>
    setConditions((list) =>
      list.map((c, i) => {
        if (i !== index) return c;
        const next = { ...c, ...change };
        if (change.field) next.operator = change.field === "amount" ? "gt" : "contains";
        return next;
      }),
    );

  const save = async () => {
    const payloadConditions = conditions
      .filter((c) => c.value.trim())
      .map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.field === "amount" ? Math.round(Number(c.value.replace(/,/g, "")) * 100) : c.value.trim(),
      }));
    if (!payloadConditions.length) return toast.error("Add at least one condition");
    const actions = {
      ...(categoryId !== NONE ? { categoryId } : {}),
      ...(projectId !== NONE ? { projectId } : {}),
      ...(requireReview ? { requireReview: true } : {}),
      ...(ignore ? { ignore: true } : {}),
    };
    setBusy(true);
    try {
      const body = {
        name: name.trim() || "Untitled rule",
        priority: Number(priority) || 100,
        match,
        conditions: payloadConditions,
        actions,
        stopProcessing: stop,
        enabled: true,
      };
      if (rule) await clientApi(`/rules/${rule.id}`, { method: "PUT", body });
      else await clientApi("/rules", { method: "POST", body });
      toast.success(rule ? "Rule updated" : "Rule created");
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="space-y-1">
              <Label htmlFor="rule-name">Name</Label>
              <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenAI is AI & APIs" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-priority">Priority</Label>
              <Input id="rule-priority" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              If
              <Select value={match} onValueChange={(v) => typeof v === "string" && setMatch(v as "all" | "any")}>
                <SelectTrigger size="sm" className="w-24">
                  <SelectValue>{match}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="any">any</SelectItem>
                </SelectContent>
              </Select>
              of these match
            </div>
            {conditions.map((condition, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: condition rows have no identity; every field is controlled from state
              <div key={index} className="grid grid-cols-[7rem_9rem_1fr_auto] items-center gap-2">
                <Select value={condition.field} onValueChange={(v) => typeof v === "string" && setCondition(index, { field: v, value: "" })}>
                  <SelectTrigger size="sm">
                    <SelectValue>{FIELDS.find((f) => f.value === condition.field)?.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FIELDS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={condition.operator} onValueChange={(v) => typeof v === "string" && setCondition(index, { operator: v })}>
                  <SelectTrigger size="sm">
                    <SelectValue>{[...TEXT_OPERATORS, ...NUMBER_OPERATORS].find((o) => o.value === condition.operator)?.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(condition.field === "amount" ? NUMBER_OPERATORS : TEXT_OPERATORS).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {condition.field === "account" ? (
                  <Select value={condition.value || null} onValueChange={(v) => typeof v === "string" && setCondition(index, { value: v })}>
                    <SelectTrigger size="sm">
                      <SelectValue>{accounts.find((a) => a.id === condition.value)?.name ?? "Choose"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    size="sm"
                    value={condition.value}
                    inputMode={condition.field === "amount" ? "decimal" : undefined}
                    placeholder={condition.field === "amount" ? `in ${workspace.baseCurrency}` : "text"}
                    onChange={(e) => setCondition(index, { value: e.target.value })}
                  />
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remove condition"
                  disabled={conditions.length === 1}
                  onClick={() => setConditions((list) => list.filter((_, i) => i !== index))}
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button size="xs" variant="outline" onClick={() => setConditions((list) => [...list, { field: "description", operator: "contains", value: "" }])}>
              <Plus className="size-3" /> Condition
            </Button>
          </div>
          <div className="space-y-2">
            <p className="text-sm">Then</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select value={categoryId} onValueChange={(v) => typeof v === "string" && setCategoryId(v)}>
                <SelectTrigger size="sm">
                  <SelectValue>{categories.find((c) => c.id === categoryId)?.name ?? "Keep category"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Keep category</SelectItem>
                  {categories
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.kind === "income" ? "↓ " : ""}
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {isBusiness && (
                <Select value={projectId} onValueChange={(v) => typeof v === "string" && setProjectId(v)}>
                  <SelectTrigger size="sm">
                    <SelectValue>{projects.find((p) => p.id === projectId)?.name ?? "Keep project"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Keep project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={requireReview} onCheckedChange={setRequireReview} /> Ask me to confirm before posting
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={ignore} onCheckedChange={setIgnore} /> Skip these when importing
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={stop} onCheckedChange={setStop} /> Stop checking other rules after this one
            </label>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => void save()}>
            Save rule
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RuleTestDialog({
  open,
  onOpenChange,
  rules,
  describe,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: Rule[];
  describe: (rule: Rule) => { conditions: string; actions: string };
}) {
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<{ matchedRuleIds: string[] } | null>(null);

  const run = async () => {
    try {
      setResult(
        await clientApi<{ matchedRuleIds: string[] }>("/rules/test", {
          method: "POST",
          body: {
            merchant: merchant || undefined,
            description: merchant || undefined,
            amount: amount ? Math.round(Number(amount.replace(/,/g, "")) * 100) : undefined,
          },
        }),
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Test your rules</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="grid grid-cols-[1fr_8rem] gap-2">
            <Input placeholder="Merchant, e.g. OPENAI *CHATGPT" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            <Input placeholder="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => void run()}>
            Run
          </Button>
          {result &&
            (result.matchedRuleIds.length ? (
              <ul className="space-y-1 text-sm">
                {result.matchedRuleIds.map((ruleId) => {
                  const rule = rules.find((r) => r.id === ruleId);
                  return rule ? (
                    <li key={ruleId} className="rounded-lg bg-muted/50 px-3 py-2">
                      <span className="font-medium">{rule.name}</span>
                      <span className="block text-xs text-muted-foreground">→ {describe(rule).actions}</span>
                    </li>
                  ) : null;
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No rule matches. Merchant memory, then AI, would decide.</p>
            ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
