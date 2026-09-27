import { normalizeName } from "../text.ts";

export type RuleField = "merchant" | "description" | "amount" | "currency" | "account" | "source" | "type" | "reference";

export type RuleOperator = "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "ends_with" | "gt" | "gte" | "lt" | "lte" | "between";

export type RuleCondition = {
  field: RuleField;
  operator: RuleOperator;
  value: string | number;
  value2?: number;
};

export type RuleActions = {
  categoryId?: string;
  projectId?: string;
  accountId?: string;
  type?: "expense" | "income" | "transfer" | "refund" | "investment" | "asset_purchase" | "debt_payment";
  merchant?: string;
  requireReview?: boolean;
  ignore?: boolean;
  note?: string;
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleActions;
  stopProcessing: boolean;
};

export type RuleSubject = {
  merchant?: string | null;
  description?: string | null;
  /** Minor units, positive. */
  amount?: number | null;
  currency?: string | null;
  accountId?: string | null;
  source?: string | null;
  type?: string | null;
  reference?: string | null;
};

function fieldValue(subject: RuleSubject, field: RuleField): string | number | null {
  switch (field) {
    case "merchant":
      return subject.merchant ?? null;
    case "description":
      return subject.description ?? null;
    case "amount":
      return subject.amount ?? null;
    case "currency":
      return subject.currency ?? null;
    case "account":
      return subject.accountId ?? null;
    case "source":
      return subject.source ?? null;
    case "type":
      return subject.type ?? null;
    case "reference":
      return subject.reference ?? null;
  }
}

export function conditionMatches(subject: RuleSubject, condition: RuleCondition): boolean {
  const actual = fieldValue(subject, condition.field);
  if (actual === null || actual === undefined) return condition.operator === "not_equals" || condition.operator === "not_contains";

  if (typeof actual === "number") {
    const expected = Number(condition.value);
    switch (condition.operator) {
      case "equals":
        return actual === expected;
      case "not_equals":
        return actual !== expected;
      case "gt":
        return actual > expected;
      case "gte":
        return actual >= expected;
      case "lt":
        return actual < expected;
      case "lte":
        return actual <= expected;
      case "between":
        return actual >= expected && actual <= Number(condition.value2 ?? expected);
      default:
        return false;
    }
  }

  // Text compares on the normalized form, so "OPENAI *CHATGPT" contains "openai".
  const isName = condition.field === "merchant" || condition.field === "description";
  const left = isName ? normalizeName(actual) : actual.toLowerCase();
  const right = isName ? normalizeName(String(condition.value)) : String(condition.value).toLowerCase();
  switch (condition.operator) {
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "not_contains":
      return !left.includes(right);
    case "starts_with":
      return left.startsWith(right);
    case "ends_with":
      return left.endsWith(right);
    default:
      return false;
  }
}

export function ruleMatches(rule: Rule, subject: RuleSubject): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false;
  return rule.match === "all"
    ? rule.conditions.every((condition) => conditionMatches(subject, condition))
    : rule.conditions.some((condition) => conditionMatches(subject, condition));
}

export type RuleOutcome = {
  actions: RuleActions;
  matchedRuleIds: string[];
  /** Which rule set each action, for explaining a categorisation. */
  decidedBy: Partial<Record<keyof RuleActions, string>>;
};

/**
 * Applies enabled rules in priority order (lower first). An earlier rule's
 * action is not overwritten by a later one; `stopProcessing` ends the run.
 */
export function applyRules(rules: Rule[], subject: RuleSubject): RuleOutcome {
  const outcome: RuleOutcome = { actions: {}, matchedRuleIds: [], decidedBy: {} };
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (!ruleMatches(rule, subject)) continue;
    outcome.matchedRuleIds.push(rule.id);
    for (const [key, value] of Object.entries(rule.actions) as [keyof RuleActions, RuleActions[keyof RuleActions]][]) {
      if (value === undefined || value === null || key in outcome.actions) continue;
      (outcome.actions as Record<string, unknown>)[key] = value;
      outcome.decidedBy[key] = rule.id;
    }
    if (rule.stopProcessing) break;
  }
  return outcome;
}
