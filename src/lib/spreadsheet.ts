/** Caps for spreadsheet import. Keep file size and row count in this one place. */
export const SPREADSHEET_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 2500,
  maxColumns: 32,
  maxCellChars: 300,
} as const;

export type SkipReason = "blank" | "duplicate" | "already_in_list" | "missing_fields" | "invalid";

export type SkippedRow = {
  rowNumber: number;
  reason: SkipReason;
};

export type ColumnMapping = {
  mode: "single" | "split";
  address?: number;
  street?: number;
  city?: number;
  state?: number;
  zip?: number;
};

export type SpreadsheetTable = {
  headers: string[];
  rows: string[][];
  hasHeaderRow: boolean;
};

export type ImportResult = {
  added: string[];
  skipped: SkippedRow[];
};

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetError";
  }
}

const ROLE_PATTERNS: Record<Exclude<keyof ColumnMapping, "mode">, RegExp[]> = {
  address: [
    /^(full\s*)?address$/,
    /^customer\s*address$/,
    /^stop(\s*address)?$/,
    /^location$/,
    /^destination$/,
    /^site$/,
  ],
  street: [
    /^street(\s*address)?$/,
    /^address\s*(line\s*)?1$/,
    /^addr(ess)?\s*1$/,
    /^line\s*1$/,
    /^street\s*1$/,
    /^address\s*line$/,
    /^addr$/,
  ],
  city: [/^city$/, /^town$/, /^municipality$/],
  state: [/^state$/, /^st$/, /^province$/, /^region$/, /^state\s*\/\s*province$/],
  zip: [/^zip(\s*code)?$/, /^zipcode$/, /^postal(\s*code)?$/, /^postcode$/, /^zip\+4$/],
};

export function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[_./-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeAddress(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function looksLikeAddressCell(value: string): boolean {
  return /^\d+\s+\S/.test(value.trim());
}

export function inferHasHeaderRow(firstRow: string[]): boolean {
  if (firstRow.some((cell) => headerRole(cell) !== null)) return true;
  if (firstRow.some(looksLikeAddressCell)) return false;
  if (
    firstRow.length > 1 &&
    firstRow.every((cell) => cell.length > 0 && cell.length < 40 && !/\d{3,}/.test(cell))
  ) {
    return true;
  }
  return false;
}

export function headerRole(value: string): Exclude<keyof ColumnMapping, "mode"> | null {
  const key = normalizeHeader(value);
  if (!key) return null;
  for (const role of ["street", "address", "city", "state", "zip"] as const) {
    if (ROLE_PATTERNS[role].some((pattern) => pattern.test(key))) return role;
  }
  return null;
}

export function detectColumns(headers: string[]): ColumnMapping {
  const found: Partial<Record<Exclude<keyof ColumnMapping, "mode">, number>> = {};
  headers.forEach((header, index) => {
    const role = headerRole(header);
    if (role && found[role] === undefined) found[role] = index;
  });

  if (found.address !== undefined) {
    return { mode: "single", address: found.address };
  }
  if (found.street !== undefined) {
    return {
      mode: "split",
      street: found.street,
      city: found.city,
      state: found.state,
      zip: found.zip,
    };
  }
  return { mode: "single", address: 0 };
}

export function joinMappedAddress(
  cells: string[],
  mapping: ColumnMapping,
  headers: string[] = [],
): string {
  if (mapping.mode === "single") {
    const start = mapping.address ?? 0;
    const parts = [sanitizeCell(cells[start] ?? "")];
    for (let i = start + 1; i < Math.max(cells.length, headers.length); i += 1) {
      const header = headers[i] ?? "";
      if (header && !/^Column \d+$/.test(header)) break;
      const extra = sanitizeCell(cells[i] ?? "");
      if (extra) parts.push(extra);
    }
    return parts.filter(Boolean).join(", ");
  }
  const street = sanitizeCell(cells[mapping.street ?? -1] ?? "");
  const city = sanitizeCell(cells[mapping.city ?? -1] ?? "");
  const state = sanitizeCell(cells[mapping.state ?? -1] ?? "");
  const zip = sanitizeCell(cells[mapping.zip ?? -1] ?? "");
  const region = [state, zip].filter(Boolean).join(" ");
  return [street, city, region].filter(Boolean).join(", ");
}

export function mappedCellsEmpty(cells: string[], mapping: ColumnMapping): boolean {
  return mappedValues(cells, mapping).every((value) => !value.trim());
}

export function extractAddresses(
  table: SpreadsheetTable,
  mapping: ColumnMapping,
  existing: string[] = [],
): ImportResult {
  const added: string[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set(existing.map(normalizeAddress).filter(Boolean));
  const existingKeys = new Set(seen);

  table.rows.forEach((cells, index) => {
    const rowNumber = table.hasHeaderRow ? index + 2 : index + 1;
    if (mappedCellsEmpty(cells, mapping)) {
      skipped.push({ rowNumber, reason: "blank" });
      return;
    }
    if (mapping.mode === "split" && !sanitizeCell(cells[mapping.street ?? -1] ?? "")) {
      skipped.push({ rowNumber, reason: "missing_fields" });
      return;
    }
    if (mappedValues(cells, mapping).some(looksLikeFormula)) {
      skipped.push({ rowNumber, reason: "invalid" });
      return;
    }
    const address = joinMappedAddress(cells, mapping, table.headers);
    if (!address) {
      skipped.push({ rowNumber, reason: "blank" });
      return;
    }
    if (looksLikeFormula(address)) {
      skipped.push({ rowNumber, reason: "invalid" });
      return;
    }
    const key = normalizeAddress(address);
    if (seen.has(key)) {
      skipped.push({
        rowNumber,
        reason: existingKeys.has(key) ? "already_in_list" : "duplicate",
      });
      return;
    }
    seen.add(key);
    added.push(address);
  });

  return { added, skipped };
}

export function skipReasonLabel(reason: SkipReason): string {
  switch (reason) {
    case "blank":
      return "blank";
    case "duplicate":
      return "duplicate";
    case "already_in_list":
      return "already in the stop list";
    case "missing_fields":
      return "missing street";
    case "invalid":
      return "not a usable address";
  }
}

function mappedValues(cells: string[], mapping: ColumnMapping): string[] {
  if (mapping.mode === "single") return [cells[mapping.address ?? 0] ?? ""];
  return [
    cells[mapping.street ?? -1] ?? "",
    cells[mapping.city ?? -1] ?? "",
    cells[mapping.state ?? -1] ?? "",
    cells[mapping.zip ?? -1] ?? "",
  ];
}

function sanitizeCell(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Spreadsheet formula / CSV-injection prefixes. Leading tab or CR only counts when it hides one of these. */
export function looksLikeFormula(value: string): boolean {
  return /^[\t\r]*[=@+\-]/.test(value);
}
