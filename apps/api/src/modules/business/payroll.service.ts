import { addMonths, type Day, daysInMonth, employeeUpdate, endOfMonth, payrollItemUpdate, payrollRunInput } from "@expensewise/core";
import {
  type EmployeeCreateInput,
  type EmployeePayInput,
  employeeCreateInput,
  employeePayInput,
  employeeQuery,
  employeeUnpayInput,
} from "@expensewise/core/contracts/business-extra";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { z } from "zod";
import { todayFor, type WorkspaceContext } from "../../common/context.js";
import { assertFound, badRequest, conflict, unprocessable } from "../../common/errors.js";
import { db, type Executor } from "../../db/index.js";
import { commitments, counterparties, employees, financialAccounts, payrollItems, payrollRuns, projects, transactions } from "../../db/schema/index.js";
import { CounterpartiesService } from "../ledger/catalog.service.js";
import { FxService } from "../ledger/fx.service.js";
import { assertInWorkspace } from "../ledger/references.js";
import { TransactionsService } from "../ledger/transactions.service.js";
import { CommitmentsService } from "../planning/commitments.service.js";
import { AuditService } from "../system/audit.service.js";
import { assertBusiness, ensureCategory } from "../wealth/support.js";

export type EmployeeRow = typeof employees.$inferSelect;
export type PayrollRunRow = typeof payrollRuns.$inferSelect;
export type PayrollItemRow = typeof payrollItems.$inferSelect;

const PAYROLL_CATEGORY = { name: "Payroll", kind: "expense" as const, icon: "users", color: "violet" };

/** The first pay day on or after `from`. */
export function nextPayDate(from: Day, payDay: number): Day {
  const [year, month] = from.split("-").map(Number) as [number, number];
  const day = Math.min(payDay, daysInMonth(year, month));
  const candidate = `${from.slice(0, 7)}-${String(day).padStart(2, "0")}`;
  return candidate >= from ? candidate : addMonths(candidate, 1, payDay);
}

/**
 * Employees and monthly payroll runs (business workspaces). A run is drafted
 * from active employees, edited, then posted: one expense per employee in the
 * Payroll category, attributed to their project. Un-posting voids those
 * expenses and returns the run to draft.
 */
@Injectable()
export class PayrollService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(CounterpartiesService) private readonly counterparties: CounterpartiesService,
    @Inject(CommitmentsService) private readonly commitments: CommitmentsService,
    @Inject(FxService) private readonly fx: FxService,
  ) {}

  // ---------------------------------------------------------------- employees

  async getEmployee(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<EmployeeRow> {
    assertBusiness(ctx);
    const [row] = await exec
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Employee");
  }

  private employeeSelect() {
    return db
      .select({ employee: employees, projectName: projects.name, accountName: financialAccounts.name, counterpartyName: counterparties.name })
      .from(employees)
      .leftJoin(projects, eq(projects.id, employees.defaultProjectId))
      .leftJoin(financialAccounts, eq(financialAccounts.id, employees.accountId))
      .leftJoin(counterparties, eq(counterparties.id, employees.counterpartyId));
  }

  async listEmployees(ctx: WorkspaceContext, raw: z.input<typeof employeeQuery> = {}) {
    assertBusiness(ctx);
    const query = employeeQuery.parse(raw);
    if (query.projectId) await assertInWorkspace(db, projects, ctx.workspaceId, [query.projectId], "Project");
    const rows = await this.employeeSelect()
      .where(
        and(
          eq(employees.workspaceId, ctx.workspaceId),
          query.status === "all" ? undefined : eq(employees.status, query.status),
          query.projectId ? eq(employees.defaultProjectId, query.projectId) : undefined,
        ),
      )
      .orderBy(asc(employees.status), asc(employees.name));
    const items = rows.map((row) => ({ ...row.employee, projectName: row.projectName, accountName: row.accountName, counterpartyName: row.counterpartyName }));
    const active = items.filter((item) => item.status === "active");
    const byCurrency = new Map<string, { currency: string; count: number; monthlySalary: number }>();
    for (const item of active) {
      const entry = byCurrency.get(item.currency) ?? { currency: item.currency, count: 0, monthlySalary: 0 };
      entry.count += 1;
      entry.monthlySalary += item.salary;
      byCurrency.set(item.currency, entry);
    }
    return { items, totals: { activeCount: active.length, monthlySalaryByCurrency: [...byCurrency.values()] } };
  }

  async employeeDetail(ctx: WorkspaceContext, id: string) {
    const employee = await this.getEmployee(ctx, id);
    const [[row], history, schedules] = await Promise.all([
      this.employeeSelect().where(eq(employees.id, id)),
      db
        .select({
          itemId: payrollItems.id,
          runId: payrollRuns.id,
          period: payrollRuns.period,
          payDate: payrollRuns.payDate,
          runStatus: payrollRuns.status,
          gross: payrollItems.gross,
          deductions: payrollItems.deductions,
          net: payrollItems.net,
          transactionId: payrollItems.transactionId,
          paidOn: transactions.date,
          transactionStatus: transactions.status,
        })
        .from(payrollItems)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.runId))
        .leftJoin(transactions, eq(transactions.id, payrollItems.transactionId))
        .where(and(eq(payrollItems.workspaceId, ctx.workspaceId), eq(payrollItems.employeeId, id)))
        .orderBy(desc(payrollRuns.period))
        .limit(24),
      employee.counterpartyId
        ? db
            .select({
              id: commitments.id,
              name: commitments.name,
              kind: commitments.kind,
              amount: commitments.amount,
              currency: commitments.currency,
              nextDueDate: commitments.nextDueDate,
              status: commitments.status,
            })
            .from(commitments)
            .where(
              and(
                eq(commitments.workspaceId, ctx.workspaceId),
                eq(commitments.counterpartyId, employee.counterpartyId),
                inArray(commitments.kind, ["payroll", "salary"]),
              ),
            )
        : Promise.resolve([]),
    ]);
    return {
      ...employee,
      projectName: row?.projectName ?? null,
      accountName: row?.accountName ?? null,
      counterpartyName: row?.counterpartyName ?? null,
      payrollHistory: history,
      months: this.salaryMonths(ctx, employee, history),
      commitments: schedules,
    };
  }

  /**
   * Each month the employee was on the books (the last 12 at most, newest
   * first) and whether that month's salary has been paid.
   */
  private salaryMonths(
    ctx: WorkspaceContext,
    employee: EmployeeRow,
    history: Array<{ period: string; net: number; transactionId: string | null; paidOn: Day | null; transactionStatus: string | null; runStatus: string }>,
  ) {
    const current = todayFor(ctx).slice(0, 7);
    const last = employee.endDate && employee.endDate.slice(0, 7) < current ? employee.endDate.slice(0, 7) : current;
    const months: string[] = [];
    for (let month = last; months.length < 12; month = addMonths(`${month}-01`, -1).slice(0, 7)) {
      if (employee.startDate && month < employee.startDate.slice(0, 7)) break;
      months.push(month);
    }
    return months.map((period) => {
      const item = history.find((h) => h.period === period);
      const paid = Boolean(item?.transactionId && item.transactionStatus !== "void");
      return {
        period,
        status: paid ? ("paid" as const) : ("unpaid" as const),
        amount: paid && item ? item.net : employee.salary,
        currency: employee.currency,
        paidOn: paid ? (item?.paidOn ?? null) : null,
        transactionId: paid ? (item?.transactionId ?? null) : null,
      };
    });
  }

  /**
   * Pays one employee for one month: an expense in the Payroll category on
   * their project, with the proof of payment attached. It shares the month's
   * payroll run, so posting the run later never pays them twice.
   */
  async payEmployee(ctx: WorkspaceContext, employeeId: string, raw: EmployeePayInput) {
    assertBusiness(ctx);
    const input = employeePayInput.parse(raw);
    await db.transaction(async (tx) => {
      const employee = await this.getEmployee(ctx, employeeId, tx);
      const accountId = input.accountId ?? employee.accountId;
      if (!accountId) throw unprocessable(`Choose the account ${employee.name} was paid from`, "missing_account");
      await this.checkRefs(tx, ctx, { accountId });
      const amount = input.amount ?? employee.salary;

      let [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.workspaceId, ctx.workspaceId), eq(payrollRuns.period, input.period)))
        .limit(1);
      if (!run) {
        [run] = await tx
          .insert(payrollRuns)
          .values({ workspaceId: ctx.workspaceId, period: input.period, payDate: input.paidOn, currency: ctx.baseCurrency, createdBy: ctx.userId })
          .returning();
      }
      const payrollRun = assertFound(run, "Payroll run");

      const [existing] = await tx
        .select({ item: payrollItems, transactionStatus: transactions.status })
        .from(payrollItems)
        .leftJoin(transactions, eq(transactions.id, payrollItems.transactionId))
        .where(and(eq(payrollItems.runId, payrollRun.id), eq(payrollItems.employeeId, employee.id)))
        .limit(1);
      if (existing?.item.transactionId && existing.transactionStatus !== "void") {
        throw conflict(`${employee.name} is already paid for ${input.period}`, "already_paid");
      }
      const values = { gross: amount, deductions: 0, net: amount, accountId, projectId: employee.defaultProjectId, note: input.note ?? null };
      const [item] = existing
        ? await tx.update(payrollItems).set(values).where(eq(payrollItems.id, existing.item.id)).returning()
        : await tx
            .insert(payrollItems)
            .values({ workspaceId: ctx.workspaceId, runId: payrollRun.id, employeeId: employee.id, ...values })
            .returning();
      const payrollItem = assertFound(item, "Payroll item");

      let counterpartyId = employee.counterpartyId;
      if (!counterpartyId) {
        counterpartyId = (await this.counterparties.findOrCreate(tx, ctx.workspaceId, employee.name, "employee"))?.id ?? null;
        if (counterpartyId) await tx.update(employees).set({ counterpartyId }).where(eq(employees.id, employee.id));
      }
      const categoryId = await ensureCategory(tx, ctx, this.audit, PAYROLL_CATEGORY);
      const { transaction } = await this.transactions.create(
        ctx,
        {
          type: "expense",
          direction: "out",
          accountId,
          amount,
          currency: employee.currency,
          date: input.paidOn,
          categoryId,
          projectId: employee.defaultProjectId,
          counterpartyId,
          description: `Salary ${input.period}: ${employee.name}`,
          notes: input.note ?? null,
          attachmentFileIds: input.attachmentFileIds,
        },
        {
          exec: tx,
          skipLearning: true,
          metadata: {
            payrollRunId: payrollRun.id,
            payrollItemId: payrollItem.id,
            employeeId: employee.id,
            gross: amount,
            deductions: 0,
            paidIndividually: true,
          },
        },
      );
      await tx.update(payrollItems).set({ transactionId: transaction.id }).where(eq(payrollItems.id, payrollItem.id));
      await this.runTotal(tx, ctx, payrollRun);
      await this.audit.record(tx, ctx, {
        action: "payroll.employee_paid",
        entityType: "employee",
        entityId: employee.id,
        after: { period: input.period, amount, transactionId: transaction.id, payrollRunId: payrollRun.id },
      });
    });
    return this.employeeDetail(ctx, employeeId);
  }

  /** Undoes one month's salary payment: the expense is voided and the month is unpaid again. */
  async unpayEmployee(ctx: WorkspaceContext, employeeId: string, raw: z.input<typeof employeeUnpayInput>) {
    assertBusiness(ctx);
    const input = employeeUnpayInput.parse(raw);
    await db.transaction(async (tx) => {
      const employee = await this.getEmployee(ctx, employeeId, tx);
      const [row] = await tx
        .select({ item: payrollItems, run: payrollRuns })
        .from(payrollItems)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.runId))
        .where(and(eq(payrollItems.workspaceId, ctx.workspaceId), eq(payrollItems.employeeId, employee.id), eq(payrollRuns.period, input.period)))
        .limit(1);
      if (!row?.item.transactionId) throw conflict(`${employee.name} has no salary payment for ${input.period}`, "not_paid");
      await this.transactions.void(ctx, row.item.transactionId, `Salary ${input.period} payment undone`, { exec: tx });
      // A posted run no longer pays them this month; a draft keeps them in line to be paid.
      if (row.run.status === "posted") await tx.delete(payrollItems).where(eq(payrollItems.id, row.item.id));
      else await tx.update(payrollItems).set({ transactionId: null }).where(eq(payrollItems.id, row.item.id));
      await this.runTotal(tx, ctx, row.run);
      await this.audit.record(tx, ctx, {
        action: "payroll.employee_unpaid",
        entityType: "employee",
        entityId: employee.id,
        before: { period: input.period, transactionId: row.item.transactionId },
      });
    });
    return this.employeeDetail(ctx, employeeId);
  }

  private async checkRefs(tx: Executor, ctx: WorkspaceContext, refs: { projectId?: string | null; accountId?: string | null }) {
    await assertInWorkspace(tx, projects, ctx.workspaceId, [refs.projectId], "Project");
    await assertInWorkspace(tx, financialAccounts, ctx.workspaceId, [refs.accountId], "Account");
  }

  /**
   * Adds an employee and links (or creates) their counterparty, kind
   * `employee`. With `createSalaryCommitment`, a monthly payroll commitment
   * on their pay day is created by Planning in the same transaction.
   */
  async createEmployee(ctx: WorkspaceContext, raw: EmployeeCreateInput) {
    assertBusiness(ctx);
    const input = employeeCreateInput.parse(raw);
    if (input.endDate && input.startDate && input.endDate < input.startDate) throw unprocessable("The end date is before the start date", "invalid_dates");
    const id = await db.transaction(async (tx) => {
      await this.checkRefs(tx, ctx, { projectId: input.defaultProjectId, accountId: input.accountId });
      const { createSalaryCommitment, ...fields } = input;
      const counterparty = await this.counterparties.findOrCreate(tx, ctx.workspaceId, fields.name, "employee");
      const [row] = await tx
        .insert(employees)
        .values({ workspaceId: ctx.workspaceId, ...fields, counterpartyId: counterparty?.id ?? null })
        .returning();
      const employee = assertFound(row, "Employee");
      let commitmentId: string | null = null;
      if (createSalaryCommitment) {
        const categoryId = await ensureCategory(tx, ctx, this.audit, PAYROLL_CATEGORY);
        const commitment = await this.commitments.create(
          ctx,
          {
            kind: "payroll",
            direction: "out",
            name: `Salary: ${employee.name.slice(0, 112)}`,
            payee: employee.name,
            counterpartyId: employee.counterpartyId,
            amount: employee.salary,
            currency: employee.currency,
            frequency: "monthly",
            startDate: nextPayDate(employee.startDate ?? todayFor(ctx), employee.payDay),
            endDate: employee.endDate,
            accountId: employee.accountId,
            categoryId,
            projectId: employee.defaultProjectId,
            autoPay: false,
          },
          { exec: tx },
        );
        commitmentId = commitment.id;
      }
      await this.audit.record(tx, ctx, { action: "employee.created", entityType: "employee", entityId: employee.id, after: { ...employee, commitmentId } });
      return employee.id;
    });
    return this.employeeDetail(ctx, id);
  }

  async updateEmployee(ctx: WorkspaceContext, id: string, raw: z.input<typeof employeeUpdate>) {
    assertBusiness(ctx);
    const input = employeeUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const before = await this.getEmployee(ctx, id, tx);
      await this.checkRefs(tx, ctx, { projectId: input.defaultProjectId, accountId: input.accountId });
      const startDate = input.startDate === undefined ? before.startDate : input.startDate;
      const endDate = input.endDate === undefined ? before.endDate : input.endDate;
      if (startDate && endDate && endDate < startDate) throw unprocessable("The end date is before the start date", "invalid_dates");
      const changes: Partial<EmployeeRow> = { ...input };
      if (input.name && input.name !== before.name) {
        changes.counterpartyId = (await this.counterparties.findOrCreate(tx, ctx.workspaceId, input.name, "employee"))?.id ?? before.counterpartyId;
      }
      if (Object.keys(changes).length) await tx.update(employees).set(changes).where(eq(employees.id, id));
      await this.audit.record(tx, ctx, {
        action: "employee.updated",
        entityType: "employee",
        entityId: id,
        before,
        after: await this.getEmployee(ctx, id, tx),
      });
    });
    return this.employeeDetail(ctx, id);
  }

  /** Deletes an employee never paid through payroll; otherwise marks them inactive. */
  async removeEmployee(ctx: WorkspaceContext, id: string) {
    assertBusiness(ctx);
    return db.transaction(async (tx) => {
      const before = await this.getEmployee(ctx, id, tx);
      const [used] = await tx.select({ id: payrollItems.id }).from(payrollItems).where(eq(payrollItems.employeeId, id)).limit(1);
      if (used) {
        await tx
          .update(employees)
          .set({ status: "inactive", endDate: before.endDate ?? todayFor(ctx) })
          .where(eq(employees.id, id));
        await this.audit.record(tx, ctx, { action: "employee.deactivated", entityType: "employee", entityId: id, before });
        return { deactivated: true };
      }
      await tx.delete(employees).where(eq(employees.id, id));
      await this.audit.record(tx, ctx, { action: "employee.deleted", entityType: "employee", entityId: id, before });
      return { deleted: true };
    });
  }

  // --------------------------------------------------------------------- runs

  async getRun(ctx: WorkspaceContext, id: string, exec: Executor = db): Promise<PayrollRunRow> {
    assertBusiness(ctx);
    const [row] = await exec
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, id), eq(payrollRuns.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Payroll run");
  }

  private async items(ctx: WorkspaceContext, runIds: string[], exec: Executor = db) {
    if (!runIds.length) return [];
    const rows = await exec
      .select({
        item: payrollItems,
        employeeName: employees.name,
        employeeTitle: employees.title,
        currency: employees.currency,
        counterpartyId: employees.counterpartyId,
        projectName: projects.name,
        accountName: financialAccounts.name,
        transactionStatus: transactions.status,
      })
      .from(payrollItems)
      .innerJoin(employees, eq(employees.id, payrollItems.employeeId))
      .leftJoin(projects, eq(projects.id, payrollItems.projectId))
      .leftJoin(financialAccounts, eq(financialAccounts.id, payrollItems.accountId))
      .leftJoin(transactions, eq(transactions.id, payrollItems.transactionId))
      .where(and(eq(payrollItems.workspaceId, ctx.workspaceId), inArray(payrollItems.runId, runIds)))
      .orderBy(asc(employees.name));
    return rows.map((row) => ({
      ...row.item,
      employeeName: row.employeeName,
      employeeTitle: row.employeeTitle,
      /** The employee's salary currency; gross, deductions and net are in it. */
      currency: row.currency,
      counterpartyId: row.counterpartyId,
      projectName: row.projectName,
      accountName: row.accountName,
      transactionStatus: row.transactionStatus,
    }));
  }

  private summarize(run: PayrollRunRow, items: Awaited<ReturnType<PayrollService["items"]>>) {
    const byCurrency = new Map<string, { currency: string; count: number; gross: number; deductions: number; net: number }>();
    for (const item of items) {
      const entry = byCurrency.get(item.currency) ?? { currency: item.currency, count: 0, gross: 0, deductions: 0, net: 0 };
      entry.count += 1;
      entry.gross += item.gross;
      entry.deductions += item.deductions;
      entry.net += item.net;
      byCurrency.set(item.currency, entry);
    }
    return {
      ...run,
      itemCount: items.length,
      totals: {
        /** Net pay converted to the run currency (the workspace base) at the pay date. */
        net: run.totalNet,
        currency: run.currency,
        byCurrency: [...byCurrency.values()],
      },
    };
  }

  async listRuns(ctx: WorkspaceContext) {
    assertBusiness(ctx);
    const runs = await db.select().from(payrollRuns).where(eq(payrollRuns.workspaceId, ctx.workspaceId)).orderBy(desc(payrollRuns.period));
    const items = await this.items(
      ctx,
      runs.map((run) => run.id),
    );
    return runs.map((run) =>
      this.summarize(
        run,
        items.filter((item) => item.runId === run.id),
      ),
    );
  }

  async runDetail(ctx: WorkspaceContext, id: string) {
    const run = await this.getRun(ctx, id);
    const items = await this.items(ctx, [id]);
    return { ...this.summarize(run, items), items };
  }

  /** Net pay of a run's items in the run currency, at the pay date. */
  private async runTotal(tx: Executor, ctx: WorkspaceContext, run: PayrollRunRow) {
    const rows = await tx
      .select({ net: payrollItems.net, currency: employees.currency })
      .from(payrollItems)
      .innerJoin(employees, eq(employees.id, payrollItems.employeeId))
      .where(eq(payrollItems.runId, run.id));
    let sum = 0;
    for (const row of rows) sum += (await this.fx.convert(row.net, row.currency, run.currency, run.payDate, ctx.workspaceId, tx)).amount;
    await tx.update(payrollRuns).set({ totalNet: sum }).where(eq(payrollRuns.id, run.id));
    return sum;
  }

  /** Drafts the run for a month from the employees active in it: gross = salary, no deductions. */
  async createRun(ctx: WorkspaceContext, raw: z.input<typeof payrollRunInput>) {
    assertBusiness(ctx);
    const input = payrollRunInput.parse(raw);
    const month = Number(input.period.slice(5, 7));
    if (month < 1 || month > 12) throw badRequest("Expected a period as YYYY-MM", "validation_failed");
    const periodStart = `${input.period}-01`;
    const periodEnd = endOfMonth(periodStart);
    const id = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.workspaceId, ctx.workspaceId), eq(payrollRuns.period, input.period)))
        .limit(1);
      if (existing) throw conflict(`There is already a payroll run for ${input.period}`, "run_exists");
      const staff = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.workspaceId, ctx.workspaceId),
            eq(employees.status, "active"),
            or(isNull(employees.startDate), lte(employees.startDate, periodEnd)),
            or(isNull(employees.endDate), gte(employees.endDate, periodStart)),
          ),
        )
        .orderBy(asc(employees.name));
      if (!staff.length) throw unprocessable(`No employees are active in ${input.period}`, "no_employees");
      const [row] = await tx
        .insert(payrollRuns)
        .values({ workspaceId: ctx.workspaceId, period: input.period, payDate: input.payDate, currency: ctx.baseCurrency, createdBy: ctx.userId })
        .returning();
      const run = assertFound(row, "Payroll run");
      await tx.insert(payrollItems).values(
        staff.map((employee) => ({
          workspaceId: ctx.workspaceId,
          runId: run.id,
          employeeId: employee.id,
          gross: employee.salary,
          deductions: 0,
          net: employee.salary,
          projectId: employee.defaultProjectId,
          accountId: employee.accountId,
        })),
      );
      const totalNet = await this.runTotal(tx, ctx, run);
      await this.audit.record(tx, ctx, {
        action: "payroll_run.created",
        entityType: "payroll_run",
        entityId: run.id,
        after: { ...run, totalNet, employees: staff.length },
      });
      return run.id;
    });
    return this.runDetail(ctx, id);
  }

  async deleteRun(ctx: WorkspaceContext, id: string) {
    assertBusiness(ctx);
    return db.transaction(async (tx) => {
      const run = await this.getRun(ctx, id, tx);
      if (run.status !== "draft") throw conflict("Un-post the run before deleting it", "run_posted");
      const [paid] = await tx
        .select({ id: payrollItems.id })
        .from(payrollItems)
        .where(and(eq(payrollItems.runId, id), isNotNull(payrollItems.transactionId)))
        .limit(1);
      if (paid) throw conflict("Someone in this run is already paid. Undo their salary payment first.", "run_has_payments");
      await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
      await this.audit.record(tx, ctx, { action: "payroll_run.deleted", entityType: "payroll_run", entityId: id, before: run });
      return { deleted: true };
    });
  }

  async updateItem(ctx: WorkspaceContext, runId: string, itemId: string, raw: z.input<typeof payrollItemUpdate>) {
    assertBusiness(ctx);
    const input = payrollItemUpdate.parse(raw);
    await db.transaction(async (tx) => {
      const run = await this.getRun(ctx, runId, tx);
      if (run.status !== "draft") throw conflict("Un-post the run to change it", "run_posted");
      const [before] = await tx
        .select()
        .from(payrollItems)
        .where(and(eq(payrollItems.id, itemId), eq(payrollItems.runId, runId), eq(payrollItems.workspaceId, ctx.workspaceId)))
        .limit(1);
      const item = assertFound(before, "Payroll item");
      if (item.transactionId) throw conflict("This salary is already paid. Undo the payment to change it.", "item_paid");
      await this.checkRefs(tx, ctx, { projectId: input.projectId, accountId: input.accountId });
      const gross = input.gross ?? item.gross;
      const deductions = input.deductions ?? item.deductions;
      if (deductions > gross) throw unprocessable("Deductions cannot be more than gross pay", "deductions_exceed_gross");
      const [after] = await tx
        .update(payrollItems)
        .set({
          gross,
          deductions,
          net: gross - deductions,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        })
        .where(eq(payrollItems.id, itemId))
        .returning();
      await this.runTotal(tx, ctx, run);
      await this.audit.record(tx, ctx, { action: "payroll_item.updated", entityType: "payroll_run", entityId: runId, before: item, after });
    });
    return this.runDetail(ctx, runId);
  }

  /**
   * Posts the run: one `expense` per employee (net pay — the cash that left
   * the account; deductions such as withheld tax are paid on later), in the
   * Payroll category, their project, dated the pay date, with the run and
   * item in metadata. All or nothing, in one database transaction.
   */
  async post(ctx: WorkspaceContext, runId: string) {
    assertBusiness(ctx);
    await db.transaction(async (tx) => {
      const run = await this.getRun(ctx, runId, tx);
      if (run.status !== "draft") throw conflict("This run is already posted", "run_posted");
      const items = await this.items(ctx, [runId], tx);
      if (!items.length) throw unprocessable("The run has no employees", "empty_run");
      const missing = items.filter((item) => item.net > 0 && !item.accountId && !item.transactionId);
      if (missing.length) {
        throw unprocessable(
          `Choose the account to pay ${missing.map((item) => item.employeeName).join(", ")} from`,
          "missing_account",
          missing.map((item) => ({ path: `items.${item.id}.accountId`, message: "Required to post" })),
        );
      }
      const categoryId = await ensureCategory(tx, ctx, this.audit, PAYROLL_CATEGORY);
      const posted: Array<{ itemId: string; transactionId: string }> = [];
      for (const item of items) {
        // Already paid on their own (with proof); the run must not pay them twice.
        if (item.net <= 0 || (item.transactionId && item.transactionStatus !== "void")) continue;
        let counterpartyId = item.counterpartyId;
        if (!counterpartyId) {
          counterpartyId = (await this.counterparties.findOrCreate(tx, ctx.workspaceId, item.employeeName, "employee"))?.id ?? null;
          if (counterpartyId) await tx.update(employees).set({ counterpartyId }).where(eq(employees.id, item.employeeId));
        }
        const { transaction } = await this.transactions.create(
          ctx,
          {
            type: "expense",
            direction: "out",
            accountId: item.accountId,
            amount: item.net,
            currency: item.currency,
            date: run.payDate,
            categoryId,
            projectId: item.projectId,
            counterpartyId,
            description: `Salary ${run.period}: ${item.employeeName}`,
            notes: item.note,
          },
          {
            exec: tx,
            skipLearning: true,
            metadata: { payrollRunId: run.id, payrollItemId: item.id, employeeId: item.employeeId, gross: item.gross, deductions: item.deductions },
          },
        );
        await tx.update(payrollItems).set({ transactionId: transaction.id }).where(eq(payrollItems.id, item.id));
        posted.push({ itemId: item.id, transactionId: transaction.id });
      }
      await tx.update(payrollRuns).set({ status: "posted", postedAt: new Date() }).where(eq(payrollRuns.id, runId));
      await this.audit.record(tx, ctx, {
        action: "payroll_run.posted",
        entityType: "payroll_run",
        entityId: runId,
        before: run,
        after: { transactions: posted },
      });
    });
    return this.runDetail(ctx, runId);
  }

  /** Voids the run's expenses and returns it to draft for editing. */
  async unpost(ctx: WorkspaceContext, runId: string) {
    assertBusiness(ctx);
    await db.transaction(async (tx) => {
      const run = await this.getRun(ctx, runId, tx);
      if (run.status !== "posted") throw conflict("This run is not posted", "run_not_posted");
      const items = await tx
        .select({ item: payrollItems, metadata: transactions.metadata })
        .from(payrollItems)
        .leftJoin(transactions, eq(transactions.id, payrollItems.transactionId))
        .where(eq(payrollItems.runId, runId));
      const voided: string[] = [];
      for (const { item, metadata } of items) {
        // Salaries paid one by one, with their proof, stay paid.
        if (!item.transactionId || (metadata as Record<string, unknown> | null)?.paidIndividually) continue;
        await this.transactions.void(ctx, item.transactionId, `Payroll ${run.period} un-posted`, { exec: tx });
        await tx.update(payrollItems).set({ transactionId: null }).where(eq(payrollItems.id, item.id));
        voided.push(item.transactionId);
      }
      await tx.update(payrollRuns).set({ status: "draft", postedAt: null }).where(eq(payrollRuns.id, runId));
      await this.audit.record(tx, ctx, {
        action: "payroll_run.unposted",
        entityType: "payroll_run",
        entityId: runId,
        before: run,
        after: { voidedTransactionIds: voided },
      });
    });
    return this.runDetail(ctx, runId);
  }
}
