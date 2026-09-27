import { index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, currency, day, money, pk, ts, updatedAt } from "./_columns.js";
import { users } from "./auth.js";
import { workspaces } from "./core.js";
import { employeeStatus, employmentType, payrollRunStatus } from "./enums.js";
import { counterparties, financialAccounts, projects, transactions } from "./ledger.js";

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const employees = pgTable(
  "employee",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    title: text("title"),
    employmentType: employmentType("employment_type").notNull().default("full_time"),
    /** Monthly gross. */
    salary: money("salary").notNull(),
    currency: currency().notNull(),
    /** Day of the month salary is paid (1-28). */
    payDay: integer("pay_day").notNull().default(1),
    defaultProjectId: uuid("default_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    accountId: uuid("account_id").references(() => financialAccounts.id, {
      onDelete: "set null",
    }),
    startDate: day("start_date"),
    endDate: day("end_date"),
    status: employeeStatus("status").notNull().default("active"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("employee_workspace_idx").on(t.workspaceId, t.status)],
);

export const payrollRuns = pgTable(
  "payroll_run",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** `YYYY-MM`. */
    period: text("period").notNull(),
    status: payrollRunStatus("status").notNull().default("draft"),
    payDate: day("pay_date").notNull(),
    totalNet: money("total_net").notNull().default(0),
    currency: currency().notNull(),
    postedAt: ts("posted_at"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [unique("payroll_run_period_unique").on(t.workspaceId, t.period)],
);

export const payrollItems = pgTable(
  "payroll_item",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    gross: money("gross").notNull(),
    deductions: money("deductions").notNull().default(0),
    net: money("net").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    accountId: uuid("account_id").references(() => financialAccounts.id, {
      onDelete: "set null",
    }),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    note: text("note"),
  },
  (t) => [index("payroll_item_run_idx").on(t.runId)],
);
