import { FileSpreadsheet, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseSpreadsheetFile, spreadsheetErrorMessage } from "@/lib/spreadsheet-file";
import {
  extractAddresses,
  skipReasonLabel,
  SPREADSHEET_LIMITS,
  type ColumnMapping,
  type ImportResult,
  type SpreadsheetTable,
} from "@/lib/spreadsheet";
import { cn } from "@/lib/utils";

type Draft = SpreadsheetTable & {
  fileName: string;
  mapping: ColumnMapping;
};

export function SpreadsheetImport({
  existingAddresses,
  onImport,
  disabled,
}: {
  existingAddresses: string[];
  onImport: (added: string[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({ mode: "single", address: 0 });
  const [summary, setSummary] = useState<ImportResult | null>(null);

  const pending = draft ? extractAddresses(draft, mapping, existingAddresses) : null;
  const preview = pending?.added.slice(0, 4) ?? [];

  async function onFile(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setError(null);
    setSummary(null);
    setDraft(null);
    try {
      const parsed = await parseSpreadsheetFile(file);
      setDraft(parsed);
      setMapping(parsed.mapping);
    } catch (err) {
      setError(spreadsheetErrorMessage(err));
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function confirmImport() {
    if (!draft) return;
    const result = extractAddresses(draft, mapping, existingAddresses);
    if (result.added.length > 0) onImport(result.added);
    setSummary(result);
    setDraft(null);
  }

  function reset() {
    setDraft(null);
    setSummary(null);
    setError(null);
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || reading}
          onClick={() => inputRef.current?.click()}
        >
          {reading ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="size-3.5" />
          )}
          {reading ? "Reading file" : "Upload spreadsheet"}
        </Button>
        <input
          id="stop-spreadsheet"
          ref={inputRef}
          type="file"
          accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      {error ? (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {draft ? (
        <div className="rounded-lg bg-surface-2 px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{draft.fileName}</p>
              <p className="mt-0.5 text-xs text-muted">
                Check the columns, then add matching rows to the stop list.
              </p>
            </div>
            <button
              type="button"
              aria-label="Cancel spreadsheet import"
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-fg"
              onClick={reset}
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <ModeButton
              active={mapping.mode === "single"}
              onClick={() =>
                setMapping({
                  mode: "single",
                  address: mapping.address ?? mapping.street ?? 0,
                })
              }
            >
              One column
            </ModeButton>
            <ModeButton
              active={mapping.mode === "split"}
              onClick={() =>
                setMapping({
                  mode: "split",
                  street: mapping.street ?? mapping.address ?? 0,
                  city: mapping.city,
                  state: mapping.state,
                  zip: mapping.zip,
                })
              }
            >
              Split columns
            </ModeButton>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {mapping.mode === "single" ? (
              <ColumnSelect
                label="Address"
                headers={draft.headers}
                value={mapping.address ?? 0}
                onChange={(address) => setMapping({ mode: "single", address })}
              />
            ) : (
              <div className="grid grid-cols-1 gap-2">
                <ColumnSelect
                  label="Street"
                  headers={draft.headers}
                  value={mapping.street ?? 0}
                  onChange={(street) => setMapping({ ...mapping, mode: "split", street })}
                />
                <ColumnSelect
                  label="City"
                  headers={draft.headers}
                  value={mapping.city}
                  optional
                  onChange={(city) => setMapping({ ...mapping, mode: "split", city })}
                />
                <ColumnSelect
                  label="State"
                  headers={draft.headers}
                  value={mapping.state}
                  optional
                  onChange={(state) => setMapping({ ...mapping, mode: "split", state })}
                />
                <ColumnSelect
                  label="ZIP"
                  headers={draft.headers}
                  value={mapping.zip}
                  optional
                  onChange={(zip) => setMapping({ ...mapping, mode: "split", zip })}
                />
              </div>
            )}
          </div>

          {preview.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Preview</p>
              <ul className="mt-1 space-y-1 text-sm leading-snug text-fg">
                {preview.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No new addresses match these columns.</p>
          )}

          <Button type="button" size="sm" className="mt-3 w-full" onClick={confirmImport}>
            Add to stop list
          </Button>
        </div>
      ) : null}

      {summary ? <ImportSummary result={summary} onDismiss={reset} /> : null}
    </div>
  );
}

function ImportSummary({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-3" role="status">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-fg">
          {result.added.length === 0
            ? "No new addresses were added"
            : result.added.length === 1
              ? "Added 1 address"
              : `Added ${result.added.length} addresses`}
        </p>
        <button
          type="button"
          aria-label="Dismiss import summary"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-fg"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </button>
      </div>
      {result.skipped.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Skipped {result.skipped.length} {result.skipped.length === 1 ? "row" : "rows"}
          </p>
          <ul className="mt-1 max-h-36 space-y-1 overflow-auto text-sm text-muted">
            {result.skipped.map((row) => (
              <li key={`${row.rowNumber}-${row.reason}`}>
                Row {row.rowNumber} — {skipReasonLabel(row.reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted">Every row was added.</p>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "h-9 rounded-md px-3 text-sm font-medium",
        active ? "bg-primary text-primary-fg" : "bg-surface text-fg shadow-border hover:bg-surface",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColumnSelect({
  label,
  headers,
  value,
  onChange,
  optional,
}: {
  label: string;
  headers: string[];
  value?: number;
  onChange: (index: number | undefined) => void;
  optional?: boolean;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs font-medium text-muted">{label}</span>
      <select
        className="h-9 min-w-0 flex-1 rounded-md bg-surface px-2 text-sm text-fg shadow-border outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      >
        {optional ? <option value="">Not used</option> : null}
        {headers.slice(0, SPREADSHEET_LIMITS.maxColumns).map((header, index) => (
          <option key={`${header}-${index}`} value={index}>
            {header}
          </option>
        ))}
      </select>
    </label>
  );
}
