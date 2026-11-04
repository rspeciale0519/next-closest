import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { utils, write } from "xlsx";
import {
  detectColumns,
  extractAddresses,
  inferHasHeaderRow,
  joinMappedAddress,
  normalizeAddress,
  SPREADSHEET_LIMITS,
  SpreadsheetError,
  type SpreadsheetTable,
} from "./spreadsheet.ts";
import {
  parseSpreadsheetFile,
  spreadsheetErrorMessage,
  validateSpreadsheetFile,
} from "./spreadsheet-file.ts";

function table(headers: string[], rows: string[][], hasHeaderRow = true): SpreadsheetTable {
  return { headers, rows, hasHeaderRow };
}

function spreadsheetFile(rows: string[][], name: string, bookType: "csv" | "xls" | "xlsx"): File {
  const sheet = utils.aoa_to_sheet(rows);
  if (bookType === "csv") {
    return new File([utils.sheet_to_csv(sheet)], name, { type: "text/csv" });
  }
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Stops");
  const body = write(workbook, { bookType, type: "array" });
  return new File([body], name);
}

describe("column detection", () => {
  it("uses a single address column when the header says address", () => {
    assert.deepEqual(detectColumns(["Name", "Address", "Notes"]), {
      mode: "single",
      address: 1,
    });
  });

  it("detects split street, city, state, and zip headers", () => {
    assert.deepEqual(detectColumns(["Street", "City", "State", "ZIP"]), {
      mode: "split",
      street: 0,
      city: 1,
      state: 2,
      zip: 3,
    });
  });

  it("recognizes common aliases for split columns", () => {
    assert.deepEqual(detectColumns(["Address Line 1", "Town", "ST", "Postal Code"]), {
      mode: "split",
      street: 0,
      city: 1,
      state: 2,
      zip: 3,
    });
  });

  it("prefers a full address column over split columns", () => {
    assert.deepEqual(detectColumns(["Full Address", "Street", "City", "State", "Zip"]), {
      mode: "single",
      address: 0,
    });
  });

  it("falls back to the first column when headers are unknown", () => {
    assert.deepEqual(detectColumns(["Foo", "Bar"]), { mode: "single", address: 0 });
  });
});

describe("header inference", () => {
  it("treats known header names as a header row", () => {
    assert.equal(inferHasHeaderRow(["Address"]), true);
  });

  it("treats a leading house-number row as data, not a header", () => {
    assert.equal(inferHasHeaderRow(["123 Main St, Orlando, FL"]), false);
  });
});

describe("split-column joining", () => {
  it("joins street, city, state, and zip into one address", () => {
    assert.equal(
      joinMappedAddress(["123 Main St", "Orlando", "FL", "32801"], {
        mode: "split",
        street: 0,
        city: 1,
        state: 2,
        zip: 3,
      }),
      "123 Main St, Orlando, FL 32801",
    );
  });

  it("omits unused split fields", () => {
    assert.equal(
      joinMappedAddress(["400 S Orange Ave", "", "FL", ""], {
        mode: "split",
        street: 0,
        city: 1,
        state: 2,
        zip: 3,
      }),
      "400 S Orange Ave, FL",
    );
  });
});

describe("extractAddresses", () => {
  it("skips blank rows", () => {
    const result = extractAddresses(
      table(["Address"], [["123 Main St, Orlando, FL"], [""], ["   "]]),
      { mode: "single", address: 0 },
    );
    assert.deepEqual(result.added, ["123 Main St, Orlando, FL"]);
    assert.deepEqual(result.skipped, [
      { rowNumber: 3, reason: "blank" },
      { rowNumber: 4, reason: "blank" },
    ]);
  });

  it("skips duplicate addresses after normalizing case and whitespace", () => {
    const result = extractAddresses(
      table(
        ["Address"],
        [
          ["123 Main St, Orlando, FL"],
          ["123   MAIN ST, orlando, fl"],
          ["200 W Morse Blvd, Winter Park, FL"],
        ],
      ),
      { mode: "single", address: 0 },
    );
    assert.deepEqual(result.added, [
      "123 Main St, Orlando, FL",
      "200 W Morse Blvd, Winter Park, FL",
    ]);
    assert.deepEqual(result.skipped, [{ rowNumber: 3, reason: "duplicate" }]);
  });

  it("skips addresses already in the stop list", () => {
    const result = extractAddresses(
      table(["Address"], [["123 Main St, Orlando, FL"], ["400 S Orange Ave, Orlando, FL"]]),
      { mode: "single", address: 0 },
      ["123  main st, Orlando, FL"],
    );
    assert.deepEqual(result.added, ["400 S Orange Ave, Orlando, FL"]);
    assert.deepEqual(result.skipped, [{ rowNumber: 2, reason: "already_in_list" }]);
  });

  it("skips split rows that are missing a street", () => {
    const result = extractAddresses(
      table(
        ["Street", "City", "State", "Zip"],
        [
          ["123 Main St", "Orlando", "FL", "32801"],
          ["", "Winter Park", "FL", "32789"],
        ],
      ),
      { mode: "split", street: 0, city: 1, state: 2, zip: 3 },
    );
    assert.deepEqual(result.added, ["123 Main St, Orlando, FL 32801"]);
    assert.deepEqual(result.skipped, [{ rowNumber: 3, reason: "missing_fields" }]);
  });

  it("skips formula-like values", () => {
    const result = extractAddresses(table(["Address"], [["=HYPERLINK(A1)"]]), {
      mode: "single",
      address: 0,
    });
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.skipped, [{ rowNumber: 2, reason: "invalid" }]);
  });

  it("numbers data rows from 1 when there is no header row", () => {
    const result = extractAddresses(
      table(["Column 1"], [["123 Main St, Orlando, FL"], [""]], false),
      { mode: "single", address: 0 },
    );
    assert.deepEqual(result.skipped, [{ rowNumber: 2, reason: "blank" }]);
  });

  it("normalizes addresses for comparison", () => {
    assert.equal(normalizeAddress("  123   Main St "), "123 main st");
  });
});

describe("file validation and parsing", () => {
  it("parses a one-column CSV and detects the address header", async () => {
    const parsed = await parseSpreadsheetFile(
      spreadsheetFile(
        [
          ["Address"],
          ["123 Main St, Orlando, FL"],
          ["200 W Morse Blvd, Winter Park, FL"],
        ],
        "stops.csv",
        "csv",
      ),
    );
    assert.equal(parsed.hasHeaderRow, true);
    assert.deepEqual(parsed.mapping, { mode: "single", address: 0 });
    assert.deepEqual(parsed.rows[0], ["123 Main St, Orlando, FL"]);
  });

  it("reports original row numbers for blank and duplicate CSV rows", async () => {
    const parsed = await parseSpreadsheetFile(
      new File(
        ["Address\n123 Main St, Orlando, FL\n\n123 MAIN ST, orlando, fl\n"],
        "stops.csv",
        { type: "text/csv" },
      ),
    );
    const result = extractAddresses(parsed, parsed.mapping);
    assert.deepEqual(result.added, ["123 Main St, Orlando, FL"]);
    assert.deepEqual(result.skipped, [
      { rowNumber: 3, reason: "blank" },
      { rowNumber: 4, reason: "duplicate" },
    ]);
  });

  it("keeps unquoted commas in a one-column CSV address", async () => {
    const parsed = await parseSpreadsheetFile(
      new File(
        ["Address\n123 Main St, Orlando, FL\n200 W Morse Blvd, Winter Park, FL\n"],
        "stops.csv",
        { type: "text/csv" },
      ),
    );
    const result = extractAddresses(parsed, parsed.mapping);
    assert.deepEqual(result.added, [
      "123 Main St, Orlando, FL",
      "200 W Morse Blvd, Winter Park, FL",
    ]);
  });

  it("parses a split-column XLSX file", async () => {
    const parsed = await parseSpreadsheetFile(
      spreadsheetFile(
        [
          ["Street", "City", "State", "Zip"],
          ["123 Main St", "Orlando", "FL", "32801"],
        ],
        "stops.xlsx",
        "xlsx",
      ),
    );
    assert.deepEqual(parsed.mapping, {
      mode: "split",
      street: 0,
      city: 1,
      state: 2,
      zip: 3,
    });
    const result = extractAddresses(parsed, parsed.mapping);
    assert.deepEqual(result.added, ["123 Main St, Orlando, FL 32801"]);
  });

  it("parses a legacy XLS workbook", async () => {
    const parsed = await parseSpreadsheetFile(
      spreadsheetFile([["Address"], ["400 S Orange Ave, Orlando, FL"]], "stops.xls", "xls"),
    );
    assert.deepEqual(parsed.rows[0], ["400 S Orange Ave, Orlando, FL"]);
  });

  it("rejects files over the size limit", () => {
    assert.throws(
      () =>
        validateSpreadsheetFile({
          name: "big.csv",
          size: SPREADSHEET_LIMITS.maxBytes + 1,
        }),
      (err: unknown) => err instanceof SpreadsheetError && /5 MB/.test(err.message),
    );
  });

  it("accepts a file at the row limit", async () => {
    const rows = [
      ["Address"],
      ...Array.from({ length: SPREADSHEET_LIMITS.maxRows }, (_, i) => [
        `${i + 1} Main St, Orlando, FL`,
      ]),
    ];
    const parsed = await parseSpreadsheetFile(spreadsheetFile(rows, "at-limit.csv", "csv"));
    assert.equal(parsed.rows.length, SPREADSHEET_LIMITS.maxRows);
  });

  it("rejects files over the row limit", async () => {
    const rows = [["Address"], ...Array.from({ length: SPREADSHEET_LIMITS.maxRows + 1 }, (_, i) => [
      `${i + 1} Main St, Orlando, FL`,
    ])];
    await assert.rejects(
      parseSpreadsheetFile(spreadsheetFile(rows, "too-many.csv", "csv")),
      (err: unknown) =>
        err instanceof SpreadsheetError &&
        err.message.includes(String(SPREADSHEET_LIMITS.maxRows)),
    );
  });

  it("rejects the wrong file type", () => {
    assert.throws(
      () => validateSpreadsheetFile({ name: "notes.pdf", size: 120 }),
      (err: unknown) => err instanceof SpreadsheetError && /CSV, XLS, or XLSX/.test(err.message),
    );
  });

  it("rejects an empty file", () => {
    assert.throws(
      () => validateSpreadsheetFile({ name: "empty.csv", size: 0 }),
      (err: unknown) => err instanceof SpreadsheetError && /empty/.test(err.message),
    );
  });

  it("rejects a corrupt workbook without throwing a raw parser error", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], "bad.xlsx");
    await assert.rejects(
      parseSpreadsheetFile(file),
      (err: unknown) =>
        err instanceof SpreadsheetError && /could not be read|damaged|expand/.test(err.message),
    );
  });

  it("maps password and encryption errors to a friendly message", () => {
    assert.match(
      spreadsheetErrorMessage(new Error("File is password-protected")),
      /password-protected/,
    );
    assert.match(
      spreadsheetErrorMessage(new Error("unsupported encryption")),
      /password-protected/,
    );
  });

  it("rejects a zip that advertises an encrypted workbook", async () => {
    const file = new File([Uint8Array.from(encryptedPackageZip())], "secret.xlsx");
    await assert.rejects(
      parseSpreadsheetFile(file),
      (err: unknown) => err instanceof SpreadsheetError && /password-protected/.test(err.message),
    );
  });
});

function encryptedPackageZip(): Uint8Array {
  const name = "EncryptedPackage";
  const nameBytes = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + nameBytes.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}
