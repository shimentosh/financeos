"use client";

import { COMMON_CURRENCIES, currencyDecimals, minorToInput, parseMoneyInput, type TransactionType, TYPE_LABELS, TYPE_RULES } from "@expensewise/core";
import { AlertTriangle, Briefcase, CheckCircle2, ExternalLink, ListTree, Trash2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useMemo } from "react";
import { useApp } from "@/components/app/app-context";
import { ConfidenceMeter } from "@/components/app/blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Account, Category, Project } from "@/lib/api/types";
import type { CaptureDraftView, ConfidenceField, ConfidenceSource } from "@/lib/api/types/ai";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import { Callout, SourceTag, transactionsHref } from "./shared";

export const NONE = "__none__";
const TYPES: TransactionType[] = ["expense", "income", "transfer", "refund", "investment", "asset_purchase", "debt_payment", "loan"];
const DIRECTION_LABELS: Partial<Record<TransactionType, { in: string; out: string }>> = {
  refund: { in: "Refund received", out: "Refund issued" },
  investment: { in: "Withdrawal", out: "Contribution" },
  debt_payment: { in: "Repayment received", out: "Payment made" },
  loan: { in: "Borrowed", out: "Lent" },
};

/** One transaction on the review screen: a draft from the capture, or a row typed by hand. */
export type DraftRow = {
  key: string;
  id: string | null;
  include: boolean;
  posted: boolean;
  type: TransactionType;
  direction: "in" | "out";
  amount: string;
  currency: string;
  date: string;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  projectId: string;
  merchant: string;
  reference: string;
  description: string;
  /** Fields the person changed: their AI flags no longer apply. */
  touched: string[];
  draft: CaptureDraftView | null;
};

export function rowFromDraft(draft: CaptureDraftView): DraftRow {
  const t = draft.transaction;
  return {
    key: t.id,
    id: t.id,
    include: t.status !== "void",
    posted: t.status === "posted",
    type: t.type,
    direction: t.direction,
    amount: minorToInput(t.amount, t.currency),
    currency: t.currency,
    date: t.date,
    accountId: t.accountId ?? "",
    toAccountId: "",
    categoryId: t.categoryId ?? NONE,
    projectId: t.projectId ?? NONE,
    merchant: t.merchant ?? "",
    reference: t.reference ?? "",
    description: t.description ?? "",
    touched: [],
    draft,
  };
}

export function blankRow(key: string, defaults: { currency: string; date: string; accountId?: string; merchant?: string | null }): DraftRow {
  return {
    key,
    id: null,
    include: true,
    posted: false,
    type: "expense",
    direction: "out",
    amount: "",
    currency: defaults.currency,
    date: defaults.date,
    accountId: defaults.accountId ?? "",
    toAccountId: "",
    categoryId: NONE,
    projectId: NONE,
    merchant: defaults.merchant ?? "",
    reference: "",
    description: "",
    touched: [],
    draft: null,
  };
}

export function usesCategory(type: TransactionType) {
  return type === "expense" || type === "income" || type === "refund";
}

export function categoryKind(type: TransactionType, direction: "in" | "out"): "expense" | "income" {
  return type === "income" || (type === "refund" && direction === "out") ? "income" : "expense";
}

/** Checks a row the way the ledger will; returns the body item or a message. */
export function rowToItem(row: DraftRow): { ok: true; item: Record<string, unknown> } | { ok: false; error: string } {
  const amount = parseMoneyInput(row.amount, row.currency);
  if (!amount) return { ok: false, error: `Enter the amount in ${row.currency}` };
  if (!row.date) return { ok: false, error: "Enter the date" };
  if (!row.accountId) return { ok: false, error: "Choose the account the money moved through" };
  if (row.type === "transfer" && !row.toAccountId) return { ok: false, error: "Choose the account the money went to" };
  const directions = TYPE_RULES[row.type].directions;
  return {
    ok: true,
    item: {
      ...(row.id ? { id: row.id } : {}),
      type: row.type,
      direction: directions.includes(row.direction) ? row.direction : TYPE_RULES[row.type].defaultDirection,
      accountId: row.accountId,
      toAccountId: row.type === "transfer" ? row.toAccountId : null,
      amount,
      currency: row.currency,
      date: row.date,
      merchant: row.type === "transfer" ? null : row.merchant.trim() || null,
      categoryId: usesCategory(row.type) && row.categoryId !== NONE ? row.categoryId : null,
      projectId: row.projectId !== NONE ? row.projectId : null,
      description: row.description.trim().slice(0, 200) || null,
      reference: row.reference.trim() || null,
    },
  };
}

type Flag = "missing" | "low" | null;

function flagOf(row: DraftRow, field: ConfidenceField): Flag {
  if (!row.draft || row.touched.includes(field)) return null;
  if (row.draft.missing.includes(field)) return "missing";
  if (row.draft.lowConfidence.includes(field)) return "low";
  return null;
}

/**
 * A label, the model's confidence and where the value came from, around an
 * input. Missing required values get a red ring, unsure ones an amber ring,
 * until the person edits them.
 */
function FieldFrame({
  label,
  htmlFor,
  flag,
  confidence,
  source,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  flag: Flag;
  confidence?: number;
  source?: ConfidenceSource;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("@container min-w-0 space-y-1", className)}>
      <div className="flex min-h-4 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <Label htmlFor={htmlFor} className="text-xs">
          {label}
          {flag === "missing" && <span className="ms-1 font-normal text-red-600 dark:text-red-400">· needed</span>}
          {flag === "low" && <span className="ms-1 font-normal text-amber-600 dark:text-amber-400">· check</span>}
        </Label>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          {/* Narrow fields (currency) keep the meter; the source tag needs room. */}
          <SourceTag source={source} className="hidden @min-[16rem]:inline-flex" />
          {confidence !== undefined && confidence > 0 && <ConfidenceMeter value={confidence} />}
        </span>
      </div>
      <div
        className={cn(
          "rounded-lg",
          flag === "missing" && "ring-2 ring-red-500/60 ring-offset-1 ring-offset-card",
          flag === "low" && "ring-2 ring-amber-500/60 ring-offset-1 ring-offset-card",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DraftEditor({
  row,
  index,
  count,
  accounts,
  categories,
  projects,
  error,
  readOnly,
  onChange,
  onRemove,
}: {
  row: DraftRow;
  index: number;
  count: number;
  accounts: Account[];
  categories: Category[];
  projects: Project[];
  error?: string | null;
  readOnly: boolean;
  onChange: (next: DraftRow) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const { money, isBusiness } = useApp();
  const draft = row.draft;
  const fields = draft?.confidence?.fields ?? {};
  const sources = draft?.confidence?.sources ?? {};
  const disabled = readOnly || row.posted || !row.include;
  const rules = TYPE_RULES[row.type];

  const set = (patch: Partial<DraftRow>, touched: string[]) => onChange({ ...row, ...patch, touched: [...new Set([...row.touched, ...touched])] });

  const kind = categoryKind(row.type, row.direction);
  const categoryOptions = useMemo(() => {
    const list = categories.filter((c) => c.kind === kind && !c.archived);
    return list
      .filter((c) => !c.parentId)
      .flatMap((parent) => [{ ...parent, depth: 0 }, ...list.filter((c) => c.parentId === parent.id).map((child) => ({ ...child, depth: 1 }))]);
  }, [categories, kind]);

  const amountMinor = parseMoneyInput(row.amount, row.currency);
  const account = accounts.find((a) => a.id === row.accountId);
  const title = row.merchant || row.description || TYPE_LABELS[row.type];
  const candidates = draft?.suggestions.accountCandidates ?? [];

  const accountSelect = (value: string, onValue: (v: string) => void, fieldId: string, exclude?: string) => (
    <Select value={value || null} onValueChange={(v) => typeof v === "string" && onValue(v)} disabled={disabled}>
      <SelectTrigger id={fieldId}>
        <SelectValue>{accounts.find((a) => a.id === value)?.name ?? "Choose account"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {accounts
          .filter((a) => a.id !== exclude)
          .map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name} · {a.currency}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );

  return (
    <article className={cn("rounded-xl border border-border bg-card", !row.include && "opacity-60")}>
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        {!row.posted && !readOnly && count > 1 && (
          <Checkbox
            checked={row.include}
            onCheckedChange={(checked) => onChange({ ...row, include: Boolean(checked) })}
            aria-label={row.include ? "Leave this one out" : "Include this one"}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {count > 1 && <span className="me-1.5 text-muted-foreground tabular-nums">{index + 1}.</span>}
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {amountMinor ? money(amountMinor, row.currency) : "Amount needed"} · {row.date ? formatDay(row.date) : "date needed"}
            {account && ` · ${account.name}`}
            {!row.id && " · entered by hand"}
          </p>
        </div>
        {row.posted ? (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="size-3" /> Posted
          </Badge>
        ) : draft?.confidence ? (
          <ConfidenceMeter value={draft.confidence.overall} className="shrink-0" />
        ) : null}
        {row.posted && row.id && (
          <Button size="xs" variant="ghost" render={<Link href={transactionsHref([row.id])} />}>
            View <ExternalLink className="size-3" />
          </Button>
        )}
        {onRemove && !row.posted && !readOnly && (
          <Button size="icon-xs" variant="ghost" aria-label="Remove this row" onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </header>

      {row.include && !row.posted && (
        <div className="space-y-3 p-4">
          {draft?.transaction.reviewReason && draft.transaction.status !== "posted" && (
            <p className="text-xs text-muted-foreground">{draft.transaction.reviewReason}</p>
          )}

          {draft && draft.duplicates.length > 0 && <DuplicateMatches draft={draft} />}

          {draft?.suggestedWorkspace && (
            <Callout tone="info" icon={Briefcase} title={`This looks like a ${draft.suggestedWorkspace.kind} transaction`}>
              It stays in this workspace when you confirm.
              {draft.suggestedWorkspace.workspaceName
                ? ` If it belongs to ${draft.suggestedWorkspace.workspaceName}, discard it here and capture it there.`
                : ""}
            </Callout>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FieldFrame label="Type" htmlFor={`${id}-type`} flag={flagOf(row, "type")} confidence={fields.type} source={sources.type}>
              <Select
                value={row.type}
                disabled={disabled}
                onValueChange={(v) => {
                  if (typeof v !== "string") return;
                  const type = v as TransactionType;
                  const kindChanged = categoryKind(type, TYPE_RULES[type].defaultDirection) !== kind;
                  set({ type, direction: TYPE_RULES[type].defaultDirection, categoryId: kindChanged || !usesCategory(type) ? NONE : row.categoryId }, ["type"]);
                }}
              >
                <SelectTrigger id={`${id}-type`}>
                  <SelectValue>{TYPE_LABELS[row.type]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldFrame>
            <FieldFrame label="Date" htmlFor={`${id}-date`} flag={flagOf(row, "date")} confidence={fields.date} source={sources.date}>
              <Input id={`${id}-date`} type="date" value={row.date} disabled={disabled} onChange={(e) => set({ date: e.target.value }, ["date"])} />
            </FieldFrame>
          </div>

          {rules.directions.length > 1 && DIRECTION_LABELS[row.type] && (
            <div className="flex gap-1">
              {(["out", "in"] as const).map((direction) => (
                <Button
                  key={direction}
                  type="button"
                  size="xs"
                  disabled={disabled}
                  variant={row.direction === direction ? "default" : "outline"}
                  onClick={() => set({ direction }, ["type"])}
                >
                  {DIRECTION_LABELS[row.type]?.[direction]}
                </Button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-[1fr_6.5rem] gap-3">
            <FieldFrame label="Amount" htmlFor={`${id}-amount`} flag={flagOf(row, "amount")} confidence={fields.amount} source={sources.amount}>
              <Input
                id={`${id}-amount`}
                inputMode="decimal"
                placeholder={currencyDecimals(row.currency) ? "0.00" : "0"}
                value={row.amount}
                disabled={disabled}
                onChange={(e) => set({ amount: e.target.value }, ["amount"])}
                className="text-base font-medium tabular-nums"
              />
            </FieldFrame>
            <FieldFrame label="Currency" htmlFor={`${id}-currency`} flag={flagOf(row, "currency")} confidence={fields.currency} source={sources.currency}>
              <Select value={row.currency} disabled={disabled} onValueChange={(v) => typeof v === "string" && set({ currency: v }, ["currency"])}>
                <SelectTrigger id={`${id}-currency`} className="min-w-0">
                  <SelectValue>{row.currency}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([row.currency, ...COMMON_CURRENCIES])].map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldFrame>
          </div>

          <div className={cn("grid gap-3", row.type === "transfer" ? "grid-cols-2" : "grid-cols-1")}>
            <FieldFrame
              label={row.type === "transfer" ? "From account" : "Account"}
              htmlFor={`${id}-account`}
              flag={flagOf(row, "account")}
              confidence={fields.account}
              source={draft?.suggestions.account?.source ?? sources.account}
            >
              {accountSelect(row.accountId, (v) => set({ accountId: v }, ["account"]), `${id}-account`)}
            </FieldFrame>
            {row.type === "transfer" && (
              <FieldFrame label="To account" htmlFor={`${id}-to`} flag={null}>
                {accountSelect(row.toAccountId, (v) => set({ toAccountId: v }, []), `${id}-to`, row.accountId)}
              </FieldFrame>
            )}
          </div>
          {candidates.length > 0 && !row.accountId && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Could be:
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => set({ accountId: c.id }, ["account"])}
                  className="rounded-full border border-border px-2 py-0.5 text-foreground hover:bg-accent/50"
                >
                  {c.name}
                </button>
              ))}
            </p>
          )}
          {account && account.currency !== row.currency && (
            <p className="text-xs text-muted-foreground">
              {account.name} is in {account.currency}; the amount is converted at your saved {row.currency}→{account.currency} rate.
            </p>
          )}

          <div className={cn("grid gap-3", usesCategory(row.type) && isBusiness ? "grid-cols-2" : "grid-cols-1")}>
            {usesCategory(row.type) && (
              <FieldFrame
                label="Category"
                htmlFor={`${id}-category`}
                flag={flagOf(row, "category")}
                confidence={fields.category}
                source={draft?.suggestions.category?.source ?? sources.category}
              >
                <Select value={row.categoryId} disabled={disabled} onValueChange={(v) => typeof v === "string" && set({ categoryId: v }, ["category"])}>
                  <SelectTrigger id={`${id}-category`}>
                    <SelectValue>{categoryOptions.find((c) => c.id === row.categoryId)?.name ?? "Uncategorized"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Uncategorized</SelectItem>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className={cn(c.depth === 1 && "ps-4 text-muted-foreground")}>{c.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldFrame>
            )}
            {isBusiness && (
              <FieldFrame
                label="Project"
                htmlFor={`${id}-project`}
                flag={flagOf(row, "project")}
                confidence={fields.project}
                source={draft?.suggestions.project?.source ?? sources.project}
              >
                <Select value={row.projectId} disabled={disabled} onValueChange={(v) => typeof v === "string" && set({ projectId: v }, ["project"])}>
                  <SelectTrigger id={`${id}-project`}>
                    <SelectValue>{projects.find((p) => p.id === row.projectId)?.name ?? "No project"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldFrame>
            )}
          </div>
          {(draft?.suggestions.unmatchedCategoryName || draft?.suggestions.unmatchedProjectName) && row.categoryId === NONE && (
            <p className="text-xs text-muted-foreground">
              The reader suggested “{draft.suggestions.unmatchedCategoryName ?? draft.suggestions.unmatchedProjectName}”, which isn't one of your{" "}
              {draft.suggestions.unmatchedCategoryName ? "categories" : "projects"}.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            {row.type !== "transfer" && (
              <FieldFrame
                label={row.type === "income" ? "From" : "Merchant / payee"}
                htmlFor={`${id}-merchant`}
                flag={flagOf(row, "merchant")}
                confidence={fields.merchant}
                source={sources.merchant}
              >
                <Input
                  id={`${id}-merchant`}
                  value={row.merchant}
                  disabled={disabled}
                  onChange={(e) => set({ merchant: e.target.value }, ["merchant"])}
                  placeholder="Shwapno, Foodpanda…"
                />
              </FieldFrame>
            )}
            <FieldFrame label="Reference" htmlFor={`${id}-reference`} flag={flagOf(row, "reference")} confidence={fields.reference} source={sources.reference}>
              <Input
                id={`${id}-reference`}
                value={row.reference}
                disabled={disabled}
                onChange={(e) => set({ reference: e.target.value }, ["reference"])}
                placeholder="TrxID, invoice no."
                className="font-mono text-sm"
              />
            </FieldFrame>
          </div>
          <FieldFrame label="Description" htmlFor={`${id}-description`} flag={null}>
            <Input
              id={`${id}-description`}
              value={row.description}
              disabled={disabled}
              maxLength={200}
              onChange={(e) => set({ description: e.target.value }, [])}
            />
          </FieldFrame>

          {draft && <Extracted draft={draft} />}

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function DuplicateMatches({ draft }: { draft: CaptureDraftView }) {
  const { money } = useApp();
  const exact = draft.duplicates.some((d) => d.exact);
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-200">
        <AlertTriangle className="size-4" />
        {exact ? "Already in your books: same transaction ID" : "Might already be in your books"}
      </p>
      <ul className="space-y-1.5">
        {draft.duplicates.map((match) => (
          <li key={match.transactionId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <Link href={transactionsHref([match.transactionId])} className="font-medium underline-offset-4 hover:underline">
              {formatDay(match.transaction.date)} · {money(match.transaction.amount, match.transaction.currency)} ·{" "}
              {match.transaction.merchant ?? match.transaction.reference ?? "—"}
            </Link>
            <span className="text-muted-foreground">
              {match.reasons.join(", ")} ({Math.round(match.score * 100)}%) · {match.transaction.status}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Leave this one out if it's the same payment, or post it anyway if it's a second one.</p>
    </div>
  );
}

function Extracted({ draft }: { draft: CaptureDraftView }) {
  const { money } = useApp();
  const e = draft.extracted;
  const currency = draft.transaction.currency;
  if (!e.paymentMethod && e.fee === null && !e.lineItems.length && !e.notes.length && !e.ruleIds.length) return null;
  return (
    <div className="space-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {e.paymentMethod && <span>Paid with {e.paymentMethod}</span>}
        {e.fee !== null && e.fee > 0 && <span>Includes a {money(e.fee, currency)} fee</span>}
        {e.ruleIds.length > 0 && (
          <Link href="/settings/rules" className="underline-offset-4 hover:underline">
            {e.ruleIds.length === 1 ? "A rule" : `${e.ruleIds.length} rules`} applied
          </Link>
        )}
      </div>
      {e.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-4">
          {e.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {e.lineItems.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
            <ListTree className="size-3.5" /> {e.lineItems.length} line item{e.lineItems.length === 1 ? "" : "s"}
          </summary>
          <table className="mt-2 w-full">
            <tbody className="divide-y divide-border/60">
              {e.lineItems.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: line items have no id and never reorder
                <tr key={`${line.description}-${i}`} className="[&>td]:py-1">
                  <td className="text-foreground">{line.description}</td>
                  <td className="w-12 text-right tabular-nums">{line.quantity ?? ""}</td>
                  <td className="w-28 text-right tabular-nums">{line.amount !== null ? money(line.amount, currency) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
