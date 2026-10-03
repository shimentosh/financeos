import {
  addDays,
  DUPLICATE_THRESHOLD,
  isDirectionAllowed,
  normalizeName,
  parseDay,
  scoreDuplicate,
  TRANSACTION_TYPES,
  type TransactionInput,
  type TransactionType,
  transactionInput,
} from "@financeos/core";
import type { importCommitInput, importListQuery, importMappingRequest, importRowsQuery } from "@financeos/core/contracts/integrations-extra";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { contextFor, type WorkspaceContext } from "../../../common/context.js";
import { assertFound, badRequest, conflict, DomainError, unprocessable } from "../../../common/errors.js";
import { db } from "../../../db/index.js";
import { categories, financialAccounts, importBatches, importRows, projects, transactions, workspaceMembers } from "../../../db/schema/index.js";
import type { ImportMapping, ImportOptions } from "../../../db/schema/types.js";
import { CategoriesService, RulesService } from "../../ledger/catalog.service.js";
import { assertInWorkspace } from "../../ledger/references.js";
import { TransactionsService } from "../../ledger/transactions.service.js";
import { ALLOWED_TYPES, StorageService } from "../../storage/storage.service.js";
import { AuditService } from "../../system/audit.service.js";
import { JobsService } from "../../system/jobs.service.js";
import { excelSerialToDay, parseSignedAmount } from "../connectors/values.js";
import { sha256Hex } from "../crypto.js";
import { recordErrorMessage } from "../pipeline.service.js";
import { loadWorkspace } from "../store.js";
import { detectFormat, guessMapping, guessOptions, ImportParseError, type ParsedSheet, parseImportFile } from "./parse.js";

export const IMPORT_COMMIT_JOB = "imports.commit";
/** Larger commits run as a background job; the UI polls the batch. */
const INLINE_COMMIT_LIMIT = 1_000;
const CHUNK = 500;

type BatchRow = typeof importBatches.$inferSelect;
type RowRecord = typeof importRows.$inferSelect;
type MappingInput = z.output<typeof importMappingRequest>;
type RowStatus = RowRecord["status"];

/** A row as the preview shows it and the commit imports it. */
export type NormalizedRow = {
  type: TransactionType;
  direction: "in" | "out";
  amount: number;
  /** Signed: positive money in, negative money out. */
  signedAmount: number;
  currency: string;
  date: string;
  description: string | null;
  merchant: string | null;
  reference: string | null;
  /** From the file's category column. */
  categoryId: string | null;
  categoryHint: string | null;
  defaultCategoryId: string | null;
  projectId: string | null;
  balance: number | null;
  accountId: string;
  externalId: string;
  duplicateScore?: number;
  duplicateReasons?: string[];
};

type RowUpdate = {
  id: string;
  normalized: NormalizedRow | null;
  status: RowStatus;
  error: string | null;
  duplicateOfId: string | null;
  transactionId: string | null;
};

const SHEET_CONTENT_TYPE = { csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } as const;
const SUMMARY_LINE = /^(opening|closing|brought forward|carried forward|b\/f|c\/f|total|grand total|balance b\/?f|balance c\/?f)\b/i;

function cell(raw: Record<string, string>, column: string | undefined): string {
  return column ? (raw[column] ?? "").trim() : "";
}

function directionWord(text: string): "in" | "out" | null {
  const word = text.toLowerCase().replace(/[^a-z]/g, "");
  if (["cr", "credit", "deposit", "in", "income", "received", "receive"].includes(word)) return "in";
  if (["dr", "debit", "withdrawal", "out", "expense", "paid", "payment", "sent"].includes(word)) return "out";
  return null;
}

function typeWord(text: string): TransactionType | null {
  const word = text.toLowerCase().trim().replace(/\s+/g, "_");
  return (TRANSACTION_TYPES as readonly string[]).includes(word) ? (word as TransactionType) : null;
}

function categoryKindFor(type: TransactionType, direction: "in" | "out"): "income" | "expense" | null {
  if (type === "income") return "income";
  if (type === "expense") return "expense";
  if (type === "refund") return direction === "out" ? "income" : "expense";
  return null;
}

export function batchView(batch: BatchRow, accountName: string | null = null) {
  return {
    id: batch.id,
    filename: batch.filename,
    format: batch.format,
    status: batch.status,
    fileId: batch.fileId,
    accountId: batch.accountId,
    accountName,
    headers: batch.headers ?? [],
    mapping: batch.mapping ?? {},
    options: batch.options ?? {},
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    importedRows: batch.importedRows,
    error: batch.error,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
  };
}

function rowView(row: RowRecord) {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    raw: row.raw,
    normalized: (row.normalized ?? null) as NormalizedRow | null,
    status: row.status,
    error: row.error,
    duplicateOfId: row.duplicateOfId,
    transactionId: row.transactionId,
  };
}

/**
 * CSV and Excel statements: upload → map columns → preview (normalized,
 * validated, duplicates flagged) → commit. Re-importing the same file is
 * idempotent: every row's external id is a hash of the account, date, signed
 * amount, description and its occurrence among identical rows.
 */
@Injectable()
export class ImportsService implements OnModuleInit {
  private readonly logger = new Logger("Imports");

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  onModuleInit() {
    this.jobs.register(IMPORT_COMMIT_JOB, async (payload, job) => {
      const batchId = String(payload.batchId);
      const userId = String(payload.userId);
      const workspace = await loadWorkspace(String(job.workspaceId));
      const [member] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)))
        .limit(1);
      if (!member || member.role === "viewer") {
        await db
          .update(importBatches)
          .set({ status: "failed", error: "The person who started this import can no longer write to this workspace" })
          .where(eq(importBatches.id, batchId));
        return { imported: 0 };
      }
      const ctx = contextFor(workspace, { userId, actorType: "user", role: member.role });
      const includeDuplicates = Array.isArray(payload.includeDuplicates) ? (payload.includeDuplicates as string[]) : [];
      return this.commitRows(ctx, batchId, includeDuplicates);
    });
  }

  private async getBatch(ctx: Pick<WorkspaceContext, "workspaceId">, id: string): Promise<BatchRow> {
    const [row] = await db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.id, id), eq(importBatches.workspaceId, ctx.workspaceId)))
      .limit(1);
    return assertFound(row, "Import");
  }

  private async batchWithAccount(ctx: WorkspaceContext, id: string) {
    const batch = await this.getBatch(ctx, id);
    const [account] = batch.accountId
      ? await db.select({ name: financialAccounts.name }).from(financialAccounts).where(eq(financialAccounts.id, batch.accountId)).limit(1)
      : [];
    return batchView(batch, account?.name ?? null);
  }

  private async sample(batchId: string) {
    const rows = await db.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber)).limit(20);
    return rows.map((row) => ({ rowNumber: row.rowNumber, raw: row.raw }));
  }

  private async suggestions(batch: BatchRow) {
    const headers = batch.headers ?? [];
    const suggestedMapping = guessMapping(headers);
    const rows = await db
      .select({ rowNumber: importRows.rowNumber, raw: importRows.raw })
      .from(importRows)
      .where(eq(importRows.batchId, batch.id))
      .orderBy(asc(importRows.rowNumber))
      .limit(500);
    return { suggestedMapping, suggestedOptions: guessOptions(rows, suggestedMapping) };
  }

  async upload(ctx: WorkspaceContext, file: { buffer: Buffer; originalname: string; mimetype: string }, fields: { sheet?: string }) {
    const format = detectFormat(file.originalname, file.mimetype, file.buffer);
    if (format === "pdf")
      throw unprocessable("PDF statements are extracted by AI capture. Upload the PDF there, or export CSV/Excel from your bank.", "pdf_not_supported");
    if (format === "xls") throw unprocessable("Old .xls workbooks are not supported. Save the file as .xlsx or CSV and upload it again.", "xls_not_supported");
    if (!format) throw unprocessable("This is not a CSV or .xlsx file", "unsupported_file");

    let parsed: ParsedSheet;
    try {
      parsed = await parseImportFile(format, file.buffer, fields.sheet);
    } catch (error) {
      if (error instanceof ImportParseError) throw unprocessable(error.message, "unreadable_file");
      throw error;
    }

    const extension = format === "xlsx" ? ".xlsx" : ".csv";
    const filename = /\.[a-z0-9]+$/i.test(file.originalname) ? file.originalname : `${file.originalname || "statement"}${extension}`;
    const saved = await this.storage.save(ctx, { buffer: file.buffer, filename, contentType: SHEET_CONTENT_TYPE[format] }, "import", ALLOWED_TYPES.sheet ?? []);

    const batch = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(importBatches)
        .values({
          workspaceId: ctx.workspaceId,
          fileId: saved.id,
          filename: saved.filename,
          format,
          status: "uploaded",
          headers: parsed.headers,
          options: parsed.sheet ? { sheet: parsed.sheet } : {},
          totalRows: parsed.rows.length,
          createdBy: ctx.userId,
        })
        .returning();
      const row = created as BatchRow;
      for (let i = 0; i < parsed.rows.length; i += 1_000) {
        await tx
          .insert(importRows)
          .values(
            parsed.rows
              .slice(i, i + 1_000)
              .map((r) => ({ workspaceId: ctx.workspaceId, batchId: row.id, rowNumber: r.rowNumber, raw: r.raw, status: "valid" as const })),
          );
      }
      await this.audit.record(tx, ctx, {
        action: "import.uploaded",
        entityType: "import_batch",
        entityId: row.id,
        after: { filename: row.filename, format, rows: parsed.rows.length, duplicateFileOf: saved.duplicateOf },
      });
      return row;
    });

    const suggestedMapping = guessMapping(parsed.headers);
    return {
      batch: batchView(batch),
      suggestedMapping,
      suggestedOptions: guessOptions(parsed.rows, suggestedMapping),
      sampleRows: parsed.rows.slice(0, 20),
      detected: { headerRow: parsed.headerRow, delimiter: parsed.delimiter, sheet: parsed.sheet, sheets: parsed.sheets, sameFileAs: saved.duplicateOf },
    };
  }

  async list(ctx: WorkspaceContext, query: z.output<typeof importListQuery>) {
    const where = and(eq(importBatches.workspaceId, ctx.workspaceId), query.status?.length ? inArray(importBatches.status, query.status) : undefined);
    const [rows, [total]] = await Promise.all([
      db
        .select({ batch: importBatches, accountName: financialAccounts.name })
        .from(importBatches)
        .leftJoin(financialAccounts, eq(financialAccounts.id, importBatches.accountId))
        .where(where)
        .orderBy(desc(importBatches.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(importBatches).where(where),
    ]);
    return { items: rows.map((row) => batchView(row.batch, row.accountName)), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize };
  }

  async get(ctx: WorkspaceContext, id: string) {
    const batch = await this.getBatch(ctx, id);
    const [view, sampleRows, suggestions, counts] = await Promise.all([
      this.batchWithAccount(ctx, id),
      this.sample(id),
      this.suggestions(batch),
      this.counts(id),
    ]);
    return { batch: view, ...suggestions, sampleRows, counts };
  }

  private async counts(batchId: string) {
    const rows = await db
      .select({ status: importRows.status, value: count() })
      .from(importRows)
      .where(eq(importRows.batchId, batchId))
      .groupBy(importRows.status);
    const counts: Record<RowStatus, number> = { valid: 0, invalid: 0, duplicate: 0, imported: 0, skipped: 0 };
    for (const row of rows) counts[row.status] = row.value;
    return counts;
  }

  /** Saves the mapping and builds the preview: every row normalized, validated and checked for duplicates. */
  async setMapping(ctx: WorkspaceContext, id: string, input: MappingInput) {
    const batch = await this.getBatch(ctx, id);
    if (!["uploaded", "mapped", "previewed", "failed"].includes(batch.status)) {
      throw conflict(`This import is ${batch.status}; its mapping can no longer change`, "import_locked");
    }
    await assertInWorkspace(db, financialAccounts, ctx.workspaceId, [input.accountId], "Account");
    await assertInWorkspace(db, categories, ctx.workspaceId, [input.options.defaultCategoryId], "Category");
    const [account] = await db.select().from(financialAccounts).where(eq(financialAccounts.id, input.accountId)).limit(1);
    if (!account) throw badRequest("Account not found in this workspace", "invalid_reference");
    await assertInWorkspace(db, projects, ctx.workspaceId, [input.options.defaultProjectId], "Project");

    const headers = new Set(batch.headers ?? []);
    const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, column]) => column)) as ImportMapping;
    for (const [field, column] of Object.entries(mapping)) {
      if (column && !headers.has(column)) throw badRequest(`"${column}" (mapped to ${field}) is not a column in this file`, "unknown_column");
    }
    if (!mapping.date) throw badRequest("Map the date column", "mapping_incomplete");
    if (!mapping.amount && !mapping.debit && !mapping.credit) throw badRequest("Map an amount column, or the debit and credit columns", "mapping_incomplete");

    const options: ImportOptions = { ...(batch.options ?? {}), ...input.options, defaultCurrency: input.options.defaultCurrency ?? undefined };
    const rows = await db.select().from(importRows).where(eq(importRows.batchId, id)).orderBy(asc(importRows.rowNumber));
    const updates = await this.normalizeRows(ctx, rows, mapping, options, account);
    await this.markDuplicates(ctx, updates, batch.format === "xlsx" ? "excel" : "csv");

    const tally = { valid: 0, invalid: 0, duplicate: 0 };
    for (const update of updates) if (update.status in tally) tally[update.status as keyof typeof tally]++;
    await db.transaction(async (tx) => {
      await this.writeRows(tx, id, updates);
      await tx
        .update(importBatches)
        .set({
          status: "previewed",
          accountId: account.id,
          mapping,
          options,
          validRows: tally.valid,
          invalidRows: tally.invalid,
          duplicateRows: tally.duplicate,
          error: null,
        })
        .where(eq(importBatches.id, id));
      await this.audit.record(tx, ctx, {
        action: "import.mapped",
        entityType: "import_batch",
        entityId: id,
        after: { accountId: account.id, mapping, options, ...tally },
      });
    });
    return { batch: await this.batchWithAccount(ctx, id), counts: await this.counts(id) };
  }

  private async normalizeRows(
    ctx: WorkspaceContext,
    rows: RowRecord[],
    mapping: ImportMapping,
    options: ImportOptions,
    account: typeof financialAccounts.$inferSelect,
  ): Promise<RowUpdate[]> {
    const categoryKinds = new Map((await this.categories.list(ctx, { includeArchived: true })).map((c) => [c.id, c.kind]));
    const byName = new Map<string, string | null>();
    const resolveCategory = async (name: string, kind: "income" | "expense") => {
      const key = `${kind}:${normalizeName(name)}`;
      if (!byName.has(key)) byName.set(key, (await this.categories.resolveName(ctx, name, kind))?.id ?? null);
      return byName.get(key) ?? null;
    };
    const occurrences = new Map<string, number>();
    const skipBefore = (rows[0]?.rowNumber ?? 0) + (options.skipRows ?? 0);
    const updates: RowUpdate[] = [];

    for (const row of rows) {
      const base = { id: row.id, duplicateOfId: null, transactionId: null };
      const invalid = (error: string, normalized: NormalizedRow | null = null): RowUpdate => ({ ...base, normalized, status: "invalid", error });
      if (row.rowNumber < skipBefore) {
        updates.push({ ...base, normalized: null, status: "skipped", error: `Skipped: one of the first ${options.skipRows} rows` });
        continue;
      }
      const raw = row.raw;
      const dateText = cell(raw, mapping.date);
      const description = cell(raw, mapping.description).slice(0, 200) || null;
      const merchant = cell(raw, mapping.merchant).slice(0, 200) || null;
      if (!dateText && (!description || SUMMARY_LINE.test(description))) {
        updates.push({ ...base, normalized: null, status: "skipped", error: description ? "Skipped: summary line" : "Skipped: no date" });
        continue;
      }
      const serial = /^\d{5}(\.\d+)?$/.test(dateText) ? excelSerialToDay(Number(dateText)) : null;
      const date = serial ?? parseDay(dateText, options.dateFormat ?? "auto");
      if (!date) {
        updates.push(invalid(`Unreadable date "${dateText.slice(0, 40)}"`));
        continue;
      }

      const currencyCell = cell(raw, mapping.currency).toUpperCase();
      const currency = /^[A-Z]{3}$/.test(currencyCell) ? currencyCell : (options.defaultCurrency ?? account.currency);

      let direction: "in" | "out" | null = null;
      let amount = 0;
      if (mapping.debit || mapping.credit) {
        const debit = Math.abs(parseSignedAmount(cell(raw, mapping.debit), currency) ?? 0);
        const credit = Math.abs(parseSignedAmount(cell(raw, mapping.credit), currency) ?? 0);
        if (debit && credit) {
          updates.push(invalid("Both the debit and the credit column have a value"));
          continue;
        }
        if (debit) [direction, amount] = ["out", debit];
        else if (credit) [direction, amount] = ["in", credit];
      }
      if (!amount && mapping.amount) {
        const text = cell(raw, mapping.amount);
        const signed = parseSignedAmount(text, currency);
        if (signed === null || signed === 0) {
          updates.push(invalid(text ? `Unreadable amount "${text.slice(0, 40)}"` : "No amount"));
          continue;
        }
        amount = Math.abs(signed);
        const negative = signed < 0;
        direction = (options.amountSign ?? "negative_is_expense") === "negative_is_expense" ? (negative ? "out" : "in") : negative ? "in" : "out";
      }
      if (!amount || !direction) {
        updates.push(invalid("No amount"));
        continue;
      }

      const typeText = cell(raw, mapping.type);
      const explicitDirection = directionWord(typeText);
      if (explicitDirection) direction = explicitDirection;
      let type: TransactionType = typeWord(typeText) ?? (direction === "in" ? "income" : "expense");
      if (!isDirectionAllowed(type, direction)) {
        if (type === "income" || type === "expense" || type === "transfer" || type === "asset_purchase") direction = type === "income" ? "in" : "out";
        else type = direction === "in" ? "income" : "expense";
      }

      const kind = categoryKindFor(type, direction);
      const categoryHint = cell(raw, mapping.category).slice(0, 60) || null;
      const categoryId = categoryHint && kind ? await resolveCategory(categoryHint, kind) : null;
      const defaultCategoryId = options.defaultCategoryId && kind && categoryKinds.get(options.defaultCategoryId) === kind ? options.defaultCategoryId : null;
      const signedAmount = direction === "in" ? amount : -amount;
      const balanceText = cell(raw, mapping.balance);
      const balance = balanceText ? parseSignedAmount(balanceText, currency) : null;

      const identity = `${account.id}|${date}|${signedAmount}|${normalizeName(description ?? merchant ?? "")}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const normalized: NormalizedRow = {
        type,
        direction,
        amount,
        signedAmount,
        currency,
        date,
        description,
        merchant,
        reference: cell(raw, mapping.reference).slice(0, 200) || null,
        categoryId,
        categoryHint,
        defaultCategoryId,
        projectId: options.defaultProjectId ?? null,
        balance,
        accountId: account.id,
        externalId: sha256Hex(`${identity}|${occurrence}`),
      };

      const check = transactionInput.safeParse({
        type,
        direction,
        status: "posted",
        accountId: account.id,
        amount,
        currency,
        date,
        merchant,
        description,
        reference: normalized.reference,
        categoryId: categoryId ?? defaultCategoryId,
        projectId: normalized.projectId,
      });
      if (!check.success) {
        const issue = check.error.issues[0];
        updates.push(invalid(`${issue?.path.join(".") || "row"}: ${issue?.message ?? "invalid"}`, normalized));
        continue;
      }
      updates.push({ ...base, normalized, status: "valid", error: null });
    }
    return updates;
  }

  /**
   * Flags rows already in the books: the same row imported before (same
   * external id), or a probable match with a transaction entered another way.
   */
  private async markDuplicates(ctx: WorkspaceContext, updates: RowUpdate[], source: "csv" | "excel") {
    const candidates = updates.filter((u) => u.status === "valid" && u.normalized);
    if (!candidates.length) return;

    const keyToRow = new Map<string, RowUpdate>();
    for (const update of candidates) {
      const id = (update.normalized as NormalizedRow).externalId;
      keyToRow.set(`csv:-:${id}`, update);
      keyToRow.set(`excel:-:${id}`, update);
    }
    const keys = [...keyToRow.keys()];
    for (let i = 0; i < keys.length; i += 1_000) {
      const existing = await db
        .select({ id: transactions.id, externalKey: transactions.externalKey, date: transactions.date })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, ctx.workspaceId), inArray(transactions.externalKey, keys.slice(i, i + 1_000))));
      for (const match of existing) {
        const update = keyToRow.get(match.externalKey ?? "");
        if (update?.status !== "valid") continue;
        update.status = "duplicate";
        update.duplicateOfId = match.id;
        update.error = match.externalKey?.startsWith(`${source}:`) ? "Already imported from this file before" : "Already imported from another file";
      }
    }

    const remaining = candidates.filter((u) => u.status === "valid");
    if (!remaining.length) return;
    const dates = remaining.map((u) => (u.normalized as NormalizedRow).date).sort();
    const from = addDays(dates[0] as string, -3);
    const to = addDays(dates[dates.length - 1] as string, 3);
    const references = [...new Set(remaining.map((u) => u.normalized?.reference).filter((r): r is string => Boolean(r && r.length >= 5)))];
    const pool = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amount: transactions.amount,
        currency: transactions.currency,
        merchant: transactions.merchant,
        description: transactions.description,
        accountId: transactions.accountId,
        reference: transactions.reference,
        externalKey: transactions.externalKey,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.workspaceId, ctx.workspaceId),
          ne(transactions.status, "void"),
          or(and(gte(transactions.date, from), lte(transactions.date, to)), references.length ? inArray(transactions.reference, references) : sql`false`),
        ),
      );
    const byDay = new Map<string, typeof pool>();
    const byReference = new Map<string, typeof pool>();
    for (const candidate of pool) {
      const key = `${candidate.currency}|${candidate.date}`;
      byDay.set(key, [...(byDay.get(key) ?? []), candidate]);
      if (candidate.reference) byReference.set(candidate.reference.toLowerCase(), [...(byReference.get(candidate.reference.toLowerCase()) ?? []), candidate]);
    }
    for (const update of remaining) {
      const row = update.normalized as NormalizedRow;
      const nearby = [...(row.reference ? (byReference.get(row.reference.toLowerCase()) ?? []) : [])];
      for (let offset = -3; offset <= 3; offset++) nearby.push(...(byDay.get(`${row.currency}|${addDays(row.date, offset)}`) ?? []));
      let best: { id: string; score: number; exact: boolean; reasons: string[]; date: string; label: string | null } | null = null;
      for (const candidate of nearby) {
        const result = scoreDuplicate(
          {
            date: row.date,
            amount: row.amount,
            currency: row.currency,
            merchant: row.merchant ?? row.description,
            accountId: row.accountId,
            reference: row.reference,
          },
          {
            id: candidate.id,
            date: candidate.date,
            amount: candidate.amount,
            currency: candidate.currency,
            merchant: candidate.merchant ?? candidate.description,
            accountId: candidate.accountId,
            reference: candidate.reference,
            externalKey: candidate.externalKey,
          },
        );
        if ((result.exact || result.score >= DUPLICATE_THRESHOLD) && (!best || result.score > best.score)) {
          best = { id: candidate.id, ...result, date: candidate.date, label: candidate.merchant ?? candidate.description };
        }
      }
      if (best) {
        update.status = "duplicate";
        update.duplicateOfId = best.id;
        update.error = `Looks like ${best.label ? `"${best.label}"` : "a transaction"} on ${best.date} (${best.reasons.join(", ").toLowerCase()})`;
        row.duplicateScore = best.score;
        row.duplicateReasons = best.reasons;
      }
    }
  }

  private async writeRows(exec: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db, batchId: string, updates: RowUpdate[]) {
    for (let i = 0; i < updates.length; i += CHUNK) {
      const values = sql.join(
        updates
          .slice(i, i + CHUNK)
          .map(
            (u) =>
              sql`(${u.id}::uuid, ${u.normalized ? JSON.stringify(u.normalized) : null}::jsonb, ${u.status}::import_row_status, ${u.error}::text, ${u.duplicateOfId}::uuid, ${u.transactionId}::uuid)`,
          ),
        sql`, `,
      );
      await exec.execute(sql`
        update ${importRows} as r set
          normalized = v.normalized, status = v.status, error = v.error,
          duplicate_of_id = v.duplicate_of_id, transaction_id = v.transaction_id
        from (values ${values}) as v(id, normalized, status, error, duplicate_of_id, transaction_id)
        where r.id = v.id and r.batch_id = ${batchId}::uuid
      `);
    }
  }

  async rows(ctx: WorkspaceContext, id: string, query: z.output<typeof importRowsQuery>) {
    await this.getBatch(ctx, id);
    const where = and(
      eq(importRows.batchId, id),
      eq(importRows.workspaceId, ctx.workspaceId),
      query.status?.length ? inArray(importRows.status, query.status) : undefined,
    );
    const [items, [total], counts] = await Promise.all([
      db
        .select()
        .from(importRows)
        .where(where)
        .orderBy(asc(importRows.rowNumber))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(importRows).where(where),
      this.counts(id),
    ]);
    return { items: items.map(rowView), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize, counts };
  }

  /** Imports the previewed rows. Large imports continue as a background job. */
  async commit(ctx: WorkspaceContext, id: string, input: z.output<typeof importCommitInput>) {
    const batch = await this.getBatch(ctx, id);
    if (batch.status !== "previewed" && batch.status !== "failed") {
      throw conflict(
        batch.status === "importing" ? "This import is already running" : `Preview the import before committing it (it is ${batch.status})`,
        "import_not_ready",
      );
    }
    if (!batch.accountId) throw conflict("Choose the account and map the columns first", "import_not_ready");
    if (input.includeDuplicates.length) {
      const found = await db
        .select({ id: importRows.id })
        .from(importRows)
        .where(and(eq(importRows.batchId, id), eq(importRows.status, "duplicate"), inArray(importRows.id, input.includeDuplicates)));
      if (found.length !== new Set(input.includeDuplicates).size)
        throw badRequest("includeDuplicates must list rows of this import flagged as duplicates", "invalid_reference");
    }
    const pending = await db.$count(
      importRows,
      and(
        eq(importRows.batchId, id),
        input.includeDuplicates.length ? or(eq(importRows.status, "valid"), inArray(importRows.id, input.includeDuplicates)) : eq(importRows.status, "valid"),
      ),
    );
    if (pending > INLINE_COMMIT_LIMIT) {
      await db.update(importBatches).set({ status: "importing", error: null }).where(eq(importBatches.id, id));
      await this.jobs.enqueue(
        IMPORT_COMMIT_JOB,
        { batchId: id, userId: ctx.userId, includeDuplicates: input.includeDuplicates },
        { workspaceId: ctx.workspaceId, dedupeKey: `import:${id}`, maxAttempts: 2 },
      );
      return { batch: await this.batchWithAccount(ctx, id), summary: null, queued: true };
    }
    const summary = await this.commitRows(ctx, id, input.includeDuplicates);
    return { batch: await this.batchWithAccount(ctx, id), summary, queued: false };
  }

  async commitRows(ctx: WorkspaceContext, batchId: string, includeDuplicates: string[]) {
    const batch = await this.getBatch(ctx, batchId);
    const source = batch.format === "xlsx" ? "excel" : "csv";
    await db.update(importBatches).set({ status: "importing", error: null }).where(eq(importBatches.id, batchId));
    const categoryKinds = new Map((await this.categories.list(ctx, { includeArchived: true })).map((c) => [c.id, c.kind]));
    const include = new Set(includeDuplicates);
    const summary = { imported: 0, drafts: 0, skipped: 0, duplicates: 0, failed: 0 };

    let cursor = -1;
    while (true) {
      const rows = await db
        .select()
        .from(importRows)
        .where(and(eq(importRows.batchId, batchId), sql`${importRows.rowNumber} > ${cursor}`, inArray(importRows.status, ["valid", "duplicate"])))
        .orderBy(asc(importRows.rowNumber))
        .limit(CHUNK);
      if (!rows.length) break;
      cursor = rows[rows.length - 1]?.rowNumber ?? cursor;
      const updates: RowUpdate[] = [];
      for (const row of rows) {
        if (row.status === "duplicate" && !include.has(row.id)) continue;
        const n = row.normalized as NormalizedRow | null;
        if (!n) continue;
        const base = { id: row.id, normalized: n, duplicateOfId: row.duplicateOfId, transactionId: null };
        try {
          const outcome = await this.rules.evaluate(ctx, {
            merchant: n.merchant,
            description: n.description,
            amount: n.amount,
            currency: n.currency,
            accountId: n.accountId,
            source,
            type: n.type,
            reference: n.reference,
          });
          if (outcome.actions.ignore) {
            summary.skipped++;
            updates.push({ ...base, status: "skipped", error: "Ignored by one of your rules" });
            continue;
          }
          let type = n.type;
          let direction: "in" | "out" | undefined = n.direction;
          if (outcome.actions.type && outcome.actions.type !== type) {
            type = outcome.actions.type;
            direction = isDirectionAllowed(type, n.direction) ? n.direction : undefined;
          }
          const kind = categoryKindFor(type, direction ?? n.direction);
          const categoryId =
            [n.categoryId, outcome.actions.categoryId ?? null, n.defaultCategoryId].find(
              (candidate) => candidate && kind && categoryKinds.get(candidate) === kind,
            ) ?? null;
          const review = outcome.actions.requireReview === true || (type === "transfer" && !outcome.actions.accountId);
          const input: TransactionInput = {
            type,
            direction,
            status: review ? "draft" : "posted",
            accountId: n.accountId,
            amount: n.amount,
            currency: n.currency,
            date: n.date,
            merchant: type === "transfer" ? null : (outcome.actions.merchant ?? n.merchant),
            description: n.description,
            reference: n.reference,
            categoryId,
            projectId: outcome.actions.projectId ?? n.projectId,
            notes: outcome.actions.note ?? null,
          };
          const result = await this.transactions.create(ctx, input, {
            source,
            sourceRef: batchId,
            externalId: n.externalId,
            metadata: { importBatchId: batchId, rowNumber: row.rowNumber, ...(n.balance !== null ? { statementBalance: n.balance } : {}) },
            reviewReason: review ? (type === "transfer" ? "Choose the account this transfer went to" : "One of your rules asks to review this") : null,
            skipLearning: true,
          });
          if (result.duplicate) {
            summary.duplicates++;
            updates.push({ ...base, status: "duplicate", error: "Already imported from this file before", duplicateOfId: result.transaction.id });
          } else {
            summary.imported++;
            if (result.transaction.status !== "posted") summary.drafts++;
            updates.push({ ...base, status: "imported", error: null, transactionId: result.transaction.id });
          }
        } catch (error) {
          summary.failed++;
          updates.push({ ...base, status: "invalid", error: recordErrorMessage(error, this.logger) });
        }
      }
      await this.writeRows(db, batchId, updates);
    }

    const counts = await this.counts(batchId);
    const failedEverything = summary.imported === 0 && summary.failed > 0;
    await db.transaction(async (tx) => {
      await tx
        .update(importBatches)
        .set({
          status: failedEverything ? "failed" : "completed",
          importedRows: counts.imported,
          validRows: counts.valid,
          invalidRows: counts.invalid,
          duplicateRows: counts.duplicate,
          completedAt: failedEverything ? null : new Date(),
          error: summary.failed ? `${summary.failed} rows could not be imported` : null,
        })
        .where(eq(importBatches.id, batchId));
      await this.audit.record(tx, ctx, { action: "import.completed", entityType: "import_batch", entityId: batchId, after: summary, source });
    });
    return summary;
  }

  /** Cancels an import; a completed one can be reverted, voiding what it created. */
  async cancel(ctx: WorkspaceContext, id: string, options: { revert: boolean }) {
    const batch = await this.getBatch(ctx, id);
    if (batch.status === "importing") throw conflict("This import is still running; wait for it to finish", "import_running");
    let voided = 0;
    if (batch.status === "completed" && batch.importedRows > 0) {
      if (!options.revert) {
        throw conflict(`This import is complete. Pass revert=true to void the ${batch.importedRows} transactions it created.`, "import_completed");
      }
      const imported = await db
        .select({ id: importRows.id, transactionId: importRows.transactionId })
        .from(importRows)
        .where(and(eq(importRows.batchId, id), eq(importRows.status, "imported")));
      for (const row of imported) {
        if (!row.transactionId) continue;
        try {
          await this.transactions.void(ctx, row.transactionId, `Import ${batch.filename} reverted`);
          voided++;
        } catch (error) {
          if (!(error instanceof DomainError && error.status === 404)) throw error;
        }
      }
      await db
        .update(importRows)
        .set({ status: "skipped", error: "Reverted" })
        .where(and(eq(importRows.batchId, id), eq(importRows.status, "imported")));
    }
    if (batch.status !== "cancelled") {
      await db.transaction(async (tx) => {
        await tx
          .update(importBatches)
          .set({
            status: "cancelled",
            importedRows: batch.status === "completed" ? 0 : batch.importedRows,
            error: voided ? `Reverted: ${voided} transactions voided` : batch.error,
          })
          .where(eq(importBatches.id, id));
        await this.audit.record(tx, ctx, {
          action: voided ? "import.reverted" : "import.cancelled",
          entityType: "import_batch",
          entityId: id,
          after: { voided },
        });
      });
    }
    return { batch: await this.batchWithAccount(ctx, id), voided };
  }
}
