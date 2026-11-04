import type { WorkBook } from "xlsx";
import {
  inferHasHeaderRow,
  detectColumns,
  SPREADSHEET_LIMITS,
  SpreadsheetError,
  type ColumnMapping,
  type SpreadsheetTable,
} from "./spreadsheet.ts";

const ALLOWED_EXT = new Set(["csv", "xls", "xlsx"]);
const MAX_UNCOMPRESSED = SPREADSHEET_LIMITS.maxBytes * 4;

export type ParsedSpreadsheet = SpreadsheetTable & {
  fileName: string;
  mapping: ColumnMapping;
};

function tooManyRowsError(): SpreadsheetError {
  return new SpreadsheetError(
    `That file has too many rows. Use a list of ${SPREADSHEET_LIMITS.maxRows} addresses or fewer.`,
  );
}

export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function validateSpreadsheetFile(file: { name: string; size: number }): void {
  if (file.size <= 0) {
    throw new SpreadsheetError("That spreadsheet is empty.");
  }
  if (file.size > SPREADSHEET_LIMITS.maxBytes) {
    throw new SpreadsheetError("That file is too large. Use a spreadsheet under 5 MB.");
  }
  if (!ALLOWED_EXT.has(fileExtension(file.name))) {
    throw new SpreadsheetError("Use a CSV, XLS, or XLSX spreadsheet.");
  }
}

export function spreadsheetErrorMessage(err: unknown): string {
  if (err instanceof SpreadsheetError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  if (/password|encrypt/i.test(raw)) {
    return "That spreadsheet is password-protected. Save it without a password and try again.";
  }
  return "That spreadsheet could not be read. It may be damaged.";
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedSpreadsheet> {
  validateSpreadsheetFile(file);
  const buffer = await file.arrayBuffer();
  assertSafeWorkbook(new Uint8Array(buffer), fileExtension(file.name));

  const { read, utils } = await import("xlsx");
  let workbook: WorkBook;
  try {
    workbook = read(buffer, {
      type: "array",
      dense: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellDates: false,
      bookVBA: false,
      raw: false,
    });
  } catch (err) {
    throw new SpreadsheetError(spreadsheetErrorMessage(err));
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    throw new SpreadsheetError("That spreadsheet does not have any addresses.");
  }

  const rawRows = (utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  }) as unknown[][])
    .map((row) => row.map((cell) => String(cell ?? "").replace(/\s+/g, " ").trim()));

  const rows = trimTrailingEmpty(rawRows);
  if (rows.length === 0) {
    throw new SpreadsheetError("That spreadsheet does not have any addresses.");
  }
  if (rows.length > SPREADSHEET_LIMITS.maxRows + 1) {
    throw tooManyRowsError();
  }

  const hasHeaderRow = inferHasHeaderRow(rows[0]);
  if (!hasHeaderRow && rows.length > SPREADSHEET_LIMITS.maxRows) {
    throw tooManyRowsError();
  }

  const width = Math.max(...rows.map((row) => row.length), 1);
  const headers = hasHeaderRow
    ? padHeaders(rows[0], width)
    : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const data = (hasHeaderRow ? rows.slice(1) : rows).map((row) => padRow(row, width));
  if (data.length === 0) {
    throw new SpreadsheetError("That spreadsheet does not have any addresses.");
  }
  if (data.length > SPREADSHEET_LIMITS.maxRows) {
    throw tooManyRowsError();
  }

  return {
    fileName: file.name,
    headers,
    rows: data,
    hasHeaderRow,
    mapping: detectColumns(hasHeaderRow ? headers : []),
  };
}

function padHeaders(row: string[], width: number): string[] {
  const headers = row.map((cell, index) => cell || `Column ${index + 1}`);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  return headers;
}

function padRow(row: string[], width: number): string[] {
  const next = row.slice(0, width);
  while (next.length < width) next.push("");
  return next;
}

function trimTrailingEmpty(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].every((cell) => !cell)) end -= 1;
  return rows.slice(0, end);
}

function assertSafeWorkbook(bytes: Uint8Array, ext: string): void {
  const kind = sniffKind(bytes);
  if (ext === "xlsx" && kind !== "zip") {
    throw new SpreadsheetError("That spreadsheet could not be read. It may be damaged.");
  }
  if (ext === "xls" && kind !== "ole" && kind !== "zip" && kind !== "text") {
    throw new SpreadsheetError("That spreadsheet could not be read. It may be damaged.");
  }
  if (ext === "csv" && (kind === "zip" || kind === "ole")) {
    throw new SpreadsheetError("That file does not look like a CSV.");
  }
  if (kind === "zip") assertSafeZip(bytes);
}

function sniffKind(bytes: Uint8Array): "zip" | "ole" | "text" | "unknown" {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return "ole";
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
  if (sample.every((b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b !== 0x7f))) {
    return "text";
  }
  return "unknown";
}

function assertSafeZip(bytes: Uint8Array): void {
  const stats = zipCentralStats(bytes);
  if (!stats) return;
  if (stats.names.some((name) => /encryptedpackage|encryptioninfo/i.test(name))) {
    throw new SpreadsheetError(
      "That spreadsheet is password-protected. Save it without a password and try again.",
    );
  }
  if (stats.totalUncompressed > MAX_UNCOMPRESSED) {
    throw new SpreadsheetError("That spreadsheet expands too far to open safely.");
  }
}

function zipCentralStats(bytes: Uint8Array): { totalUncompressed: number; names: string[] } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let totalUncompressed = 0;
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    if (uncompressed > MAX_UNCOMPRESSED) {
      throw new SpreadsheetError("That spreadsheet expands too far to open safely.");
    }
    names.push(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen)));
    totalUncompressed += uncompressed;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { totalUncompressed, names };
}

function findEocd(view: DataView, length: number): number {
  const min = Math.max(0, length - 65557);
  for (let i = length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}
