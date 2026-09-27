import Papa from "papaparse";
import readXlsxFile from "read-excel-file/node";
import type { ImportMapping, ImportOptions } from "../../../db/schema/types.js";

export const MAX_IMPORT_ROWS = 20_000;
const HEADER_SCAN_ROWS = 30;

export type ImportFormat = "csv" | "xlsx";

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

export type ParsedSheet = {
  headers: string[];
  rows: Array<{ rowNumber: number; raw: Record<string, string> }>;
  /** 1-based row number of the header in the file. */
  headerRow: number;
  delimiter: string | null;
  sheet: string | null;
  sheets: string[];
};

/** What a file is, by extension first and its first bytes second. */
export function detectFormat(filename: string, contentType: string, buffer: Buffer): ImportFormat | "pdf" | "xls" | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const zip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const pdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  const ole = buffer.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0;
  if (pdf || ext === "pdf" || contentType === "application/pdf") return "pdf";
  // An .xlsx workbook is a zip archive.
  if (zip) return "xlsx";
  if (ole || ext === "xls") return "xls";
  if (ext === "xlsx") return null;
  return "csv";
}

/** UTF-8 (BOM stripped), UTF-16 from Excel's "Unicode text", or Windows-1252 as a last resort. */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const text = utf8.charCodeAt(0) === 0xfeff ? utf8.slice(1) : utf8;
  if (!text.includes("�")) return text;
  try {
    return new TextDecoder("windows-1252").decode(buffer);
  } catch {
    return text;
  }
}

export function parseCsvMatrix(buffer: Buffer): { matrix: string[][]; delimiter: string } {
  const text = decodeText(buffer);
  // Empty lines are kept (and dropped later) so row numbers match the file.
  const result = Papa.parse<string[]>(text, { skipEmptyLines: false, delimitersToGuess: [",", ";", "\t", "|"] });
  const matrix = result.data.filter((row): row is string[] => Array.isArray(row)).map((row) => row.map((cell) => String(cell ?? "").trim()));
  return { matrix, delimiter: result.meta.delimiter || "," };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
  return String(value).trim();
}

export async function parseXlsxMatrix(buffer: Buffer, sheet?: string): Promise<{ matrix: string[][]; sheet: string; sheets: string[] }> {
  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    sheets = await readXlsxFile(buffer);
  } catch {
    throw new ImportParseError("This Excel file could not be read. Save it again as .xlsx (or export CSV) and retry.");
  }
  if (!sheets.length) throw new ImportParseError("The workbook has no sheets");
  const chosen = sheet ? sheets.find((s) => s.sheet.toLowerCase() === sheet.toLowerCase()) : sheets[0];
  if (!chosen) throw new ImportParseError(`There is no sheet called "${sheet}". Sheets: ${sheets.map((s) => s.sheet).join(", ")}`);
  const matrix = chosen.data.map((row) => (row as unknown[]).map(cellText));
  return { matrix, sheet: chosen.sheet, sheets: sheets.map((s) => s.sheet) };
}

// ---------------------------------------------------------------- column guessing

type MappedField = keyof ImportMapping;

/** Header words seen on English bank, card and Bangladeshi bank / bKash statements. */
const SYNONYMS: Record<MappedField, string[]> = {
  date: [
    "date",
    "txn date",
    "transaction date",
    "value date",
    "posting date",
    "post date",
    "trans date",
    "tran date",
    "booking date",
    "date time",
    "datetime",
    "date & time",
    "created at",
    "তারিখ",
  ],
  debit: [
    "debit",
    "debits",
    "withdrawal",
    "withdrawals",
    "dr",
    "debit amount",
    "withdrawal amount",
    "withdrawal amt",
    "money out",
    "paid out",
    "out",
    "outflow",
    "debit amt",
  ],
  credit: [
    "credit",
    "credits",
    "deposit",
    "deposits",
    "cr",
    "credit amount",
    "deposit amount",
    "deposit amt",
    "money in",
    "paid in",
    "in",
    "inflow",
    "credit amt",
  ],
  amount: ["amount", "transaction amount", "txn amount", "amt", "net amount", "value", "টাকা", "পরিমাণ"],
  balance: ["balance", "running balance", "closing balance", "available balance", "ledger balance", "balance amount", "ব্যালেন্স"],
  reference: [
    "ref",
    "reference",
    "ref no",
    "reference no",
    "reference number",
    "ref number",
    "cheque no",
    "chq no",
    "cheque number",
    "check no",
    "trx id",
    "trxid",
    "transaction id",
    "txn id",
    "trans id",
    "instrument no",
    "ref/cheque no",
    "cheque/ref no",
    "chq/ref no",
    "utr",
  ],
  description: [
    "description",
    "narration",
    "particulars",
    "details",
    "transaction details",
    "remarks",
    "memo",
    "narrative",
    "transaction description",
    "purpose",
    "note",
    "notes",
    "বিবরণ",
  ],
  merchant: ["merchant", "payee", "vendor", "counterparty", "beneficiary", "to/from", "from/to", "recipient", "receiver", "sender", "party", "name", "payer"],
  currency: ["currency", "ccy", "cur", "curr"],
  category: ["category", "categories", "expense category"],
  type: ["type", "dr/cr", "cr/dr", "debit/credit", "txn type", "transaction type", "d/c", "c/d"],
};
const FIELD_ORDER: MappedField[] = ["date", "debit", "credit", "amount", "balance", "reference", "description", "merchant", "currency", "category", "type"];

export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^\p{L}\p{N}/&]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldFor(header: string, loose: boolean): MappedField | null {
  const text = normalizeHeader(header);
  if (!text) return null;
  for (const field of FIELD_ORDER) {
    if (SYNONYMS[field].includes(text)) return field;
  }
  if (!loose) return null;
  for (const field of FIELD_ORDER) {
    if (SYNONYMS[field].some((word) => word.length >= 4 && new RegExp(`(^|\\s)${word.replace(/[/&]/g, "\\$&")}(\\s|$)`).test(text))) return field;
  }
  return null;
}

/** Best guess of which column holds which field. */
export function guessMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  for (const pass of [false, true]) {
    for (const header of headers) {
      const field = fieldFor(header, pass);
      if (!field || mapping[field] || Object.values(mapping).includes(header)) continue;
      mapping[field] = header;
    }
  }
  // Separate debit/credit columns carry the direction; a lone "amount" beside them is ambiguous.
  if (mapping.debit && mapping.credit && mapping.amount) delete mapping.amount;
  return mapping;
}

/** Suggests the date format from the date column's values and a sign convention. */
export function guessOptions(rows: ParsedSheet["rows"], mapping: ImportMapping): Pick<ImportOptions, "dateFormat" | "amountSign"> & { skipRows: number } {
  let dayFirst = 0;
  let monthFirst = 0;
  let iso = 0;
  let separator = "/";
  if (mapping.date) {
    for (const row of rows.slice(0, 500)) {
      const value = row.raw[mapping.date] ?? "";
      if (/^\d{4}-\d{1,2}-\d{1,2}/.test(value)) iso++;
      const match = value.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})/);
      if (!match) continue;
      separator = match[2] ?? "/";
      if (Number(match[1]) > 12) dayFirst++;
      if (Number(match[3]) > 12) monthFirst++;
    }
  }
  let dateFormat: ImportOptions["dateFormat"] = "auto";
  if (iso && !dayFirst && !monthFirst) dateFormat = "YYYY-MM-DD";
  else if (monthFirst > dayFirst) dateFormat = "MM/DD/YYYY";
  else if (dayFirst) dateFormat = separator === "-" ? "DD-MM-YYYY" : separator === "." ? "DD.MM.YYYY" : "DD/MM/YYYY";
  return { dateFormat, amountSign: "negative_is_expense", skipRows: 0 };
}

/**
 * Finds the header row (statements often start with a title, the account
 * number and the period), names unnamed or repeated columns, and turns the
 * rest into records.
 */
export function tabulate(matrix: string[][], meta: { delimiter: string | null; sheet: string | null; sheets: string[] }): ParsedSheet {
  let headerIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(matrix.length, HEADER_SCAN_ROWS); i++) {
    const row = matrix[i] ?? [];
    const score = row.filter((cell) => cell && fieldFor(cell, false)).length;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = i;
    }
  }
  if (bestScore < 2) headerIndex = matrix.findIndex((row) => row.filter(Boolean).length >= 2);
  if (headerIndex < 0) throw new ImportParseError("Could not find a header row. The first row should name the columns (Date, Description, Amount…).");

  const seen = new Map<string, number>();
  const headerCells = matrix[headerIndex] ?? [];
  const width = Math.max(headerCells.length, ...matrix.slice(headerIndex + 1, headerIndex + 200).map((row) => row.length));
  const headers = Array.from({ length: width }, (_, index) => {
    const base = (headerCells[index] ?? "").trim().slice(0, 80) || `Column ${index + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });

  const rows: ParsedSheet["rows"] = [];
  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    if (!cells.some((cell) => cell?.trim())) continue;
    if (rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportParseError(`This file has more than ${MAX_IMPORT_ROWS.toLocaleString("en")} rows. Split it and import the parts.`);
    }
    const raw: Record<string, string> = {};
    headers.forEach((header, index) => {
      raw[header] = (cells[index] ?? "").slice(0, 500);
    });
    rows.push({ rowNumber: i + 1, raw });
  }
  if (!rows.length) throw new ImportParseError("No rows found under the header row");
  return { headers, rows, headerRow: headerIndex + 1, ...meta };
}

export async function parseImportFile(format: ImportFormat, buffer: Buffer, sheet?: string): Promise<ParsedSheet> {
  if (format === "xlsx") {
    const parsed = await parseXlsxMatrix(buffer, sheet);
    return tabulate(parsed.matrix, { delimiter: null, sheet: parsed.sheet, sheets: parsed.sheets });
  }
  const parsed = parseCsvMatrix(buffer);
  return tabulate(parsed.matrix, { delimiter: parsed.delimiter, sheet: null, sheets: [] });
}
