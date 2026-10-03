import { rmSync } from "node:fs";
import { importMappingRequest } from "@financeos/core/contracts/integrations-extra";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Uploaded statements go to a throwaway directory, not the dev storage folder.
const storageDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/ew-imports-test-${process.pid}`;
  process.env.STORAGE_LOCAL_DIR = dir;
  return dir;
});

import { db } from "../../src/db/index.js";
import { categories, files, importRows, transactions } from "../../src/db/schema/index.js";
import { ImportsService } from "../../src/modules/integrations/imports/imports.service.js";
import { AccountsService } from "../../src/modules/ledger/accounts.service.js";
import { RulesService } from "../../src/modules/ledger/catalog.service.js";
import { TransactionsService } from "../../src/modules/ledger/transactions.service.js";
import { JobsService } from "../../src/modules/system/jobs.service.js";
import { buildXlsx } from "../fixtures/xlsx.js";
import { createUser, resetDatabase, service, shutdown, type TestUser } from "./harness.js";

let imports: ImportsService;
let accounts: AccountsService;
let transactionsService: TransactionsService;
let rules: RulesService;
let user: TestUser;
let bank: string;

beforeAll(async () => {
  imports = await service(ImportsService);
  accounts = await service(AccountsService);
  transactionsService = await service(TransactionsService);
  rules = await service(RulesService);
});

afterAll(async () => {
  await shutdown();
  rmSync(storageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  user = await createUser("Farhana Akter");
  bank = (
    await accounts.create(user.personal, { name: "Demo Bank Savings", kind: "bank", currency: "BDT", openingBalance: 5_000_000, openingDate: "2026-09-01" })
  ).id;
});

const STATEMENT = [
  "Demo Bank Ltd,Statement of Account",
  "Account,1234567890",
  "Period,01/09/2026 - 30/09/2026",
  "",
  "Txn Date,Particulars,Cheque No,Withdrawal (Dr),Deposit (Cr),Balance",
  ',Opening Balance,,,,"50,000.00"',
  '13/09/2026,POS SHWAPNO GULSHAN,,"1,250.00",,"48,750.00"',
  '14/09/2026,SALARY SEP ACME,,,"85,000.00","1,33,750.00"',
  '15/09/2026,PATHAO RIDE,,350.00,,"1,33,400.00"',
  '15/09/2026,PATHAO RIDE,,350.00,,"1,33,050.00"',
  '16/09/2026,FOODPANDA ORDER,,780.00,,"1,32,270.00"',
  "32/09/2026,BROKEN DATE,,100.00,,",
  "17/09/2026,NO AMOUNT,,,,",
  ',Closing Balance,,,,"1,32,270.00"',
].join("\r\n");

const upload = (name: string, body: string | Buffer, type = "text/csv", sheet?: string) =>
  imports.upload(user.personal, { buffer: Buffer.isBuffer(body) ? body : Buffer.from(`﻿${body}`, "utf8"), originalname: name, mimetype: type }, { sheet });

async function preview(batchId: string, mapping: Record<string, string | undefined>, options: Record<string, unknown> = {}) {
  return imports.setMapping(user.personal, batchId, importMappingRequest.parse({ accountId: bank, mapping, options }));
}

describe("CSV statements", () => {
  it("detects the columns, previews with duplicates flagged, imports, and re-imports idempotently", async () => {
    const [transport] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, user.personal.workspaceId), eq(categories.name, "Transport")));
    await rules.create(user.personal, {
      name: "Rides",
      conditions: [{ field: "description", operator: "contains", value: "pathao" }],
      actions: { categoryId: transport?.id },
    });
    const { transaction: manual } = await transactionsService.create(user.personal, {
      type: "expense",
      accountId: bank,
      amount: 78_000,
      currency: "BDT",
      date: "2026-09-16",
      merchant: "Foodpanda",
    });

    const uploaded = await upload("september.csv", STATEMENT);
    expect(uploaded.batch).toMatchObject({
      status: "uploaded",
      format: "csv",
      totalRows: 9,
      headers: ["Txn Date", "Particulars", "Cheque No", "Withdrawal (Dr)", "Deposit (Cr)", "Balance"],
    });
    expect(uploaded.detected).toMatchObject({ headerRow: 5, delimiter: "," });
    expect(uploaded.suggestedMapping).toEqual({
      date: "Txn Date",
      description: "Particulars",
      reference: "Cheque No",
      debit: "Withdrawal (Dr)",
      credit: "Deposit (Cr)",
      balance: "Balance",
    });
    expect(uploaded.suggestedOptions).toMatchObject({ dateFormat: "DD/MM/YYYY", amountSign: "negative_is_expense" });
    expect(uploaded.sampleRows[1]).toEqual({
      rowNumber: 7,
      raw: expect.objectContaining({ Particulars: "POS SHWAPNO GULSHAN", "Withdrawal (Dr)": "1,250.00" }),
    });
    const [file] = await db
      .select()
      .from(files)
      .where(eq(files.id, uploaded.batch.fileId as string));
    expect(file).toMatchObject({ kind: "import", contentType: "text/csv" });

    const previewed = await preview(uploaded.batch.id, uploaded.suggestedMapping, uploaded.suggestedOptions);
    expect(previewed.batch).toMatchObject({ status: "previewed", accountName: "Demo Bank Savings", validRows: 4, invalidRows: 2, duplicateRows: 1 });
    expect(previewed.counts).toEqual({ valid: 4, invalid: 2, duplicate: 1, imported: 0, skipped: 2 });
    const rows = await imports.rows(user.personal, uploaded.batch.id, { page: 1, pageSize: 50 });
    const byNumber = new Map(rows.items.map((r) => [r.rowNumber, r]));
    expect(byNumber.get(6)).toMatchObject({ status: "skipped", error: "Skipped: summary line" });
    expect(byNumber.get(7)?.normalized).toMatchObject({
      type: "expense",
      direction: "out",
      amount: 125_000,
      date: "2026-09-13",
      currency: "BDT",
      balance: 4_875_000,
    });
    expect(byNumber.get(8)?.normalized).toMatchObject({ type: "income", direction: "in", amount: 8_500_000 });
    expect(byNumber.get(9)?.normalized?.externalId).not.toBe(byNumber.get(10)?.normalized?.externalId);
    expect(byNumber.get(11)).toMatchObject({ status: "duplicate", duplicateOfId: manual.id, error: expect.stringMatching(/Looks like "Foodpanda"/) });
    expect(byNumber.get(12)).toMatchObject({ status: "invalid", error: expect.stringMatching(/Unreadable date/) });
    expect(byNumber.get(13)).toMatchObject({ status: "invalid", error: "No amount" });
    const onlyInvalid = await imports.rows(user.personal, uploaded.batch.id, { page: 1, pageSize: 50, status: ["invalid"] });
    expect(onlyInvalid.total).toBe(2);

    const committed = await imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [] });
    expect(committed).toMatchObject({
      queued: false,
      summary: { imported: 4, failed: 0, skipped: 0, duplicates: 0 },
      batch: { status: "completed", importedRows: 4 },
    });
    const imported = await db.select().from(transactions).where(eq(transactions.sourceRef, uploaded.batch.id));
    expect(imported).toHaveLength(4);
    expect(imported.every((t) => t.source === "csv" && t.status === "posted" && t.accountId === bank)).toBe(true);
    // Both identical ride lines import, and the rule categorised them.
    const rides = imported.filter((t) => t.description === "PATHAO RIDE");
    expect(rides).toHaveLength(2);
    expect(rides.every((t) => t.categoryId === transport?.id)).toBe(true);
    const balance = (await accounts.list(user.personal)).find((a) => a.id === bank)?.balance;
    expect(balance).toBe(5_000_000 - 125_000 + 8_500_000 - 35_000 - 35_000 - 78_000);

    // The same file again: every row is recognised, nothing new is created.
    const again = await upload("september-copy.csv", STATEMENT);
    expect(again.detected.sameFileAs).toBe(uploaded.batch.fileId);
    const repeat = await preview(again.batch.id, again.suggestedMapping, again.suggestedOptions);
    expect(repeat.batch).toMatchObject({ validRows: 0, duplicateRows: 5 });
    const repeatRows = await imports.rows(user.personal, again.batch.id, { page: 1, pageSize: 50, status: ["duplicate"] });
    expect(repeatRows.items.filter((r) => r.error === "Already imported from this file before")).toHaveLength(4);
    const nothing = await imports.commit(user.personal, again.batch.id, { includeDuplicates: [] });
    expect(nothing.summary).toMatchObject({ imported: 0 });
    // Forcing an exact re-import still cannot double-count it.
    await imports.cancel(user.personal, again.batch.id, { revert: false });
    expect(await db.$count(transactions, eq(transactions.accountId, bank))).toBe(5);

    // Revert voids what the import created.
    await expect(imports.cancel(user.personal, uploaded.batch.id, { revert: false })).rejects.toMatchObject({ status: 409 });
    const reverted = await imports.cancel(user.personal, uploaded.batch.id, { revert: true });
    expect(reverted).toMatchObject({ voided: 4, batch: { status: "cancelled" } });
    expect((await accounts.list(user.personal)).find((a) => a.id === bank)?.balance).toBe(5_000_000 - 78_000);
  });

  it("imports a flagged duplicate when the user says it is new", async () => {
    const { transaction: manual } = await transactionsService.create(user.personal, {
      type: "expense",
      accountId: bank,
      amount: 78_000,
      currency: "BDT",
      date: "2026-09-16",
      merchant: "Foodpanda",
    });
    const uploaded = await upload("september.csv", STATEMENT);
    await preview(uploaded.batch.id, uploaded.suggestedMapping, { dateFormat: "DD/MM/YYYY" });
    const [dup] = await db
      .select()
      .from(importRows)
      .where(and(eq(importRows.batchId, uploaded.batch.id), eq(importRows.status, "duplicate")));
    expect(dup?.duplicateOfId).toBe(manual.id);
    await expect(imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [uploaded.batch.id] })).rejects.toMatchObject({ status: 400 });
    const committed = await imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [dup?.id as string] });
    expect(committed.summary).toMatchObject({ imported: 5 });
  });

  it("uses a signed amount column and refuses bad mappings", async () => {
    const csv = [
      "Date;Description;Amount;Currency",
      "2026-09-10;Coffee;-350.50;BDT",
      "2026-09-11;Refund from Daraz;1,200;BDT",
      "2026-09-12;Card in USD;-12.99;USD",
    ].join("\n");
    const uploaded = await upload("card.csv", csv);
    expect(uploaded.suggestedMapping).toMatchObject({ date: "Date", description: "Description", amount: "Amount", currency: "Currency" });
    await expect(preview(uploaded.batch.id, { description: "Description", amount: "Amount" })).rejects.toMatchObject({ code: "mapping_incomplete" });
    await expect(preview(uploaded.batch.id, { date: "When", amount: "Amount" })).rejects.toMatchObject({ code: "unknown_column" });
    const previewed = await preview(uploaded.batch.id, uploaded.suggestedMapping, { amountSign: "negative_is_expense" });
    expect(previewed.counts).toMatchObject({ valid: 3 });
    const rows = (await imports.rows(user.personal, uploaded.batch.id, { page: 1, pageSize: 10 })).items;
    expect(rows.map((r) => [r.normalized?.type, r.normalized?.amount, r.normalized?.currency])).toEqual([
      ["expense", 35_050, "BDT"],
      ["income", 120_000, "BDT"],
      ["expense", 1_299, "USD"],
    ]);
    const committed = await imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [] });
    expect(committed.summary).toMatchObject({ imported: 3, failed: 0 });
    // The USD row was converted into the account's currency with the workspace rate.
    const [usd] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.sourceRef, uploaded.batch.id), eq(transactions.currency, "USD")));
    expect(usd).toMatchObject({ amount: 1_299, accountAmount: 158_478, baseCurrency: "BDT" });
  });

  it("explains that PDFs go to AI capture and rejects old Excel files", async () => {
    await expect(upload("statement.pdf", Buffer.from("%PDF-1.7 fake"), "application/pdf")).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/PDF statements are extracted by AI capture/),
    });
    const ole = Buffer.alloc(64);
    ole.writeUInt32BE(0xd0cf11e0, 0);
    await expect(upload("old.xls", ole, "application/vnd.ms-excel")).rejects.toMatchObject({ status: 422, code: "xls_not_supported" });
    await expect(upload("empty.csv", "Date,Amount\n")).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/No rows/) });
  });
});

describe("Excel statements", () => {
  it("reads the chosen sheet of an .xlsx workbook and imports it as excel", async () => {
    const workbook = buildXlsx({
      Notes: [["Exported from bKash"]],
      Statement: [
        ["Date", "Trx ID", "Transaction Type", "To/From", "Amount (BDT)", "Balance"],
        ["2026-09-18", "BKA7Q2W9E1", "Send Money", "Ammu", -5000, 15000],
        ["2026-09-19", "BKA7Q2W9E2", "Cash In", "Agent 017", 20000, 35000],
        ["2026-09-20", "BKA7Q2W9E3", "Payment", "Shwapno", -1850.5, 33149.5],
      ],
    });
    await expect(upload("bkash.xlsx", workbook, "application/octet-stream", "Missing")).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/no sheet called "Missing"/),
    });
    const uploaded = await upload("bkash.xlsx", workbook, "application/octet-stream", "Statement");
    expect(uploaded.batch).toMatchObject({ format: "xlsx", totalRows: 3, options: { sheet: "Statement" } });
    expect(uploaded.detected).toMatchObject({ sheet: "Statement", sheets: ["Notes", "Statement"] });
    expect(uploaded.suggestedMapping).toMatchObject({
      date: "Date",
      reference: "Trx ID",
      merchant: "To/From",
      amount: "Amount (BDT)",
      type: "Transaction Type",
    });
    const previewed = await preview(uploaded.batch.id, uploaded.suggestedMapping, uploaded.suggestedOptions);
    expect(previewed.counts).toMatchObject({ valid: 3, invalid: 0 });
    const committed = await imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [] });
    expect(committed.summary).toMatchObject({ imported: 3 });
    const rows = await db.select().from(transactions).where(eq(transactions.sourceRef, uploaded.batch.id));
    expect(rows.every((t) => t.source === "excel")).toBe(true);
    expect(rows.find((t) => t.reference === "BKA7Q2W9E3")).toMatchObject({ type: "expense", amount: 185_050, merchant: "Shwapno" });
    expect(rows.find((t) => t.reference === "BKA7Q2W9E2")).toMatchObject({ type: "income", amount: 2_000_000 });
  });
});

describe("large imports", () => {
  it("commits in the background above the inline limit", async () => {
    const lines = ["Date,Description,Amount"];
    for (let i = 0; i < 1_050; i++) lines.push(`2026-09-${String((i % 28) + 1).padStart(2, "0")},Item ${i},-${(i % 90) + 10}.00`);
    const uploaded = await upload("big.csv", lines.join("\n"));
    await preview(uploaded.batch.id, uploaded.suggestedMapping);
    const committed = await imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [] });
    expect(committed).toMatchObject({ queued: true, summary: null, batch: { status: "importing" } });
    await expect(imports.commit(user.personal, uploaded.batch.id, { includeDuplicates: [] })).rejects.toMatchObject({ status: 409 });
    const jobs = await service(JobsService);
    await jobs.runDue(5);
    const done = await imports.get(user.personal, uploaded.batch.id);
    expect(done.batch).toMatchObject({ status: "completed", importedRows: 1_050 });
  }, 120_000);
});

describe("workspace isolation", () => {
  it("keeps imports inside their workspace", async () => {
    const other = await createUser("Someone Else");
    const uploaded = await upload("september.csv", STATEMENT);
    await expect(imports.get(other.personal, uploaded.batch.id)).rejects.toThrow(/not found/);
    await expect(imports.rows(other.personal, uploaded.batch.id, { page: 1, pageSize: 10 })).rejects.toThrow(/not found/);
    await expect(imports.commit(other.personal, uploaded.batch.id, { includeDuplicates: [] })).rejects.toThrow(/not found/);
    const otherBank = (await accounts.create(other.personal, { name: "Theirs", kind: "bank", currency: "BDT", openingBalance: 0, openingDate: "2026-09-01" }))
      .id;
    await expect(
      imports.setMapping(user.personal, uploaded.batch.id, importMappingRequest.parse({ accountId: otherBank, mapping: uploaded.suggestedMapping })),
    ).rejects.toThrow(/not found in this workspace/);
    expect((await imports.list(other.personal, { page: 1, pageSize: 10 })).total).toBe(0);
  });
});
