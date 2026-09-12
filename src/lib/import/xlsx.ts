/**
 * .xlsx reading.
 *
 * Schools send real Excel files, so the importer reads them directly rather
 * than asking the office to re-save as CSV. Parsing is delegated to
 * `read-excel-file`, chosen deliberately:
 *
 *   - it is a reader only, so no formula evaluation and no macro surface;
 *   - it has no known vulnerabilities (the widely used `xlsx@0.18.5` on npm
 *     carries unfixed prototype-pollution and ReDoS advisories);
 *   - it pulls seven packages rather than a hundred.
 *
 * Everything below converts the library's typed cells into the same
 * `ParsedSheet` shape the CSV path produces, so the validation layer has a
 * single code path and cannot behave differently for the two formats.
 */

import readXlsxFile from 'read-excel-file/node';
import { normaliseHeader, type ParsedSheet, blankRecord } from './csv.ts';

/**
 * Limits for untrusted uploads. A spreadsheet is a compressed archive, so a
 * small file can expand enormously; these caps bound the work regardless.
 */
export const XLSX_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 128,
  /** Longest single cell we keep; anything beyond is truncated, not stored. */
  maxCellLength: 2000,
} as const;

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

/** The first four bytes of every .xlsx file: it is a ZIP archive. */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 && // P
    bytes[1] === 0x4b && // K
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

/** The legacy .xls binary format, which we cannot read and must not pretend to. */
export function looksLikeLegacyXls(bytes: Uint8Array): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return (
    bytes.length > 8 && signature.every((byte, index) => bytes[index] === byte)
  );
}

/**
 * Render one spreadsheet cell as the trimmed string the validator expects.
 *
 * The conversions here are where most real-world import bugs live:
 *
 *  - Dates arrive as JS `Date` at UTC midnight. They are formatted with UTC
 *    accessors; using local ones would shift the day backwards on any server
 *    west of Greenwich and quietly change every date of birth.
 *  - Numbers must not reach the validator in exponential form, and an integer
 *    must not gain a ".0" tail. Excel also strips the leading zero from a
 *    phone number typed as a number — `normalisePhone` already accepts the
 *    resulting nine-digit form, so no data is lost.
 *  - Blank cells become '' so that "absent" and "empty" are indistinguishable
 *    to the validator, exactly as in CSV.
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const year = String(value.getUTCFullYear()).padStart(4, '0');
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    const day = String(value.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return String(value);
    // Trim floating-point noise (1.2000000000000002) without losing precision
    // that matters for the fields we import.
    return String(Number(value.toFixed(10)));
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false';

  return String(value).trim();
}

type SheetResult = { sheet: string; data: unknown[][] };

/**
 * Read an .xlsx buffer into the shared ParsedSheet shape.
 *
 * By default the first sheet is used, because that is where a school's data
 * always is; the names of the others are returned so the UI can say which
 * sheet was read rather than leaving the administrator guessing.
 */
export async function parseXlsx(
  buffer: Buffer | Uint8Array,
  options: { sheet?: string | number; maxRows?: number } = {},
): Promise<ParsedSheet & { sheetNames: string[]; sheetUsed: string }> {
  const bytes = buffer instanceof Buffer ? buffer : Buffer.from(buffer);

  if (bytes.length > XLSX_LIMITS.maxBytes) {
    throw new SpreadsheetError(
      'That file is larger than 5 MB. Split it into smaller files and import them one at a time.',
    );
  }

  if (looksLikeLegacyXls(bytes)) {
    throw new SpreadsheetError(
      'That is an old .xls file. Open it in Excel and use File → Save As → Excel Workbook (.xlsx), then upload it again.',
    );
  }

  if (!looksLikeXlsx(bytes)) {
    throw new SpreadsheetError('That file is not a valid Excel workbook.');
  }

  let sheets: SheetResult[];
  try {
    // Without a `sheet` option the library returns every sheet, which lets us
    // name them in an error message instead of failing opaquely.
    sheets = (await readXlsxFile(bytes as Buffer, {
      getSheets: false,
    } as never)) as unknown as SheetResult[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new SpreadsheetError(
      `That Excel file could not be read${detail ? ` (${detail})` : ''}. If it opens in Excel, try File → Save As → Excel Workbook (.xlsx).`,
    );
  }

  // Older/other shapes: a bare row array means a single unnamed sheet.
  const normalised: SheetResult[] = Array.isArray(sheets) && sheets.length > 0 && 'data' in (sheets[0] as object)
    ? sheets
    : [{ sheet: 'Sheet1', data: sheets as unknown as unknown[][] }];

  const sheetNames = normalised.map((s) => s.sheet);

  let chosen: SheetResult | undefined;
  if (typeof options.sheet === 'string') {
    chosen = normalised.find((s) => s.sheet === options.sheet);
    if (!chosen) {
      throw new SpreadsheetError(
        `This workbook has no sheet called "${options.sheet}". It contains: ${sheetNames.join(', ')}.`,
      );
    }
  } else if (typeof options.sheet === 'number') {
    chosen = normalised[options.sheet - 1];
    if (!chosen) throw new SpreadsheetError(`This workbook has no sheet ${options.sheet}.`);
  } else {
    chosen = normalised[0];
  }

  if (!chosen) throw new SpreadsheetError('That Excel file contains no sheets.');

  const maxRows = options.maxRows ?? XLSX_LIMITS.maxRows;
  const raw = chosen.data ?? [];

  // Keep original positions so an error can say "row 34" and mean the row the
  // administrator sees in Excel.
  const indexed = raw
    .map((cells, index) => ({ cells: cells ?? [], lineNumber: index + 1 }))
    .filter((entry) =>
      entry.cells.some((cell) => cellToString(cell) !== ''),
    );

  if (indexed.length === 0) {
    return { headers: [], rows: [], rowNumbers: [], sheetNames, sheetUsed: chosen.sheet };
  }

  const headerCells = (indexed[0]?.cells ?? []).slice(0, XLSX_LIMITS.maxColumns);
  const headers = headerCells.map((cell) => cellToString(cell));

  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  const dataRows = indexed.slice(1);

  for (const entry of dataRows.slice(0, maxRows)) {
    const record = blankRecord();
    headers.forEach((header, index) => {
      const key = normaliseHeader(header);
      if (!key) return;
      const text = cellToString(entry.cells[index]);
      record[key] =
        text.length > XLSX_LIMITS.maxCellLength
          ? text.slice(0, XLSX_LIMITS.maxCellLength)
          : text;
    });
    rows.push(record);
    rowNumbers.push(entry.lineNumber);
  }

  return {
    headers,
    rows,
    rowNumbers,
    sheetNames,
    sheetUsed: chosen.sheet,
    ...(dataRows.length > maxRows ? { truncatedAt: maxRows } : {}),
  };
}

/**
 * Recognises the common binary formats a user might rename to .csv or .xlsx by
 * mistake. Without this a PDF would be fed to the CSV parser, which happily
 * reports "6 rows, 0 ready" — a confusing non-answer. Naming the actual format
 * lets us tell the user precisely what went wrong.
 */
export function detectBinaryFormat(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]) =>
    sig.length <= bytes.length && sig.every((b, i) => bytes[i] === b);

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'PDF';
  if (startsWith(0xff, 0xd8, 0xff)) return 'JPEG image';
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'PNG image';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'GIF image';
  if (startsWith(0x1f, 0x8b)) return 'gzip archive';
  if (startsWith(0x52, 0x61, 0x72, 0x21)) return 'RAR archive';
  if (startsWith(0x7f, 0x45, 0x4c, 0x46)) return 'binary program';
  if (startsWith(0x00, 0x00, 0x00) && bytes.length > 8) return 'binary file';
  return null;
}

/**
 * A text file that decodes with replacement characters was not UTF-8 (or is
 * not text at all). Treated as a hard error rather than importing mojibake,
 * because a mangled Amharic name looks plausible enough to reach the database.
 */
export function looksLikeBinaryText(text: string): boolean {
  if (text.length === 0) return false;
  let bad = 0;
  const sample = text.slice(0, 4000);
  for (const char of sample) {
    const code = char.codePointAt(0)!;
    // Replacement char, or a control code that is not tab/CR/LF.
    if (code === 0xfffd || (code < 0x09) || (code > 0x0d && code < 0x20) || code === 0x00) bad++;
  }
  return bad / Math.max(sample.length, 1) > 0.02;
}
