/**
 * CSV / spreadsheet parsing.
 *
 * Schools send whatever their office produced: a CSV exported from Excel, a
 * tab-separated dump, a file with a UTF-8 BOM, quoted fields containing commas
 * and newlines, and Amharic column headers. This parser handles those without
 * pulling in a heavyweight dependency.
 *
 * Real .xlsx is a ZIP of XML and is NOT parsed here — the upload UI asks for
 * "Save as CSV" instead, which every version of Excel can do, rather than
 * pretending to support a format we would only half-implement.
 */

export type ParsedSheet = {
  headers: string[];
  rows: Record<string, string>[];
  /** Row numbers as the user sees them in their spreadsheet (header = 1). */
  rowNumbers: number[];
  /**
   * Set when the file held more rows than the limit. Silently dropping the
   * remainder would let a school believe a 2,500-row upload succeeded when 500
   * students were never imported, so the caller must surface this.
   */
  truncatedAt?: number;
};

/** Detect the delimiter by counting candidates outside quoted regions. */
function detectDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;

  for (const candidate of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < sample.length; i++) {
      const char = sample[i];
      if (char === '"') {
        if (inQuotes && sample[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && char === candidate) {
        count++;
      } else if (!inQuotes && char === '\n') {
        break; // first line is enough
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/** Split CSV text into rows of raw cells, honouring RFC-4180 quoting. */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // handled by the \n branch
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * A record with no prototype.
 *
 * Row keys come from a user-supplied file. A plain `{}` would let a column
 * literally named "__proto__" or "constructor" reach Object.prototype during
 * assignment; a null-prototype object cannot be polluted that way.
 */
export function blankRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** Normalise a header cell so 'Given Name', 'given_name' and 'GIVENNAME' match. */
export function normaliseHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    // Drop separators AND punctuation, so "Given Name (Amharic)" and
    // "given_name_amharic" collapse to the same key.
    .replace(/[\s_\-./()[\]{}'"`,:;#]+/g, '');
}

export function parseSheet(text: string, maxRows = 2000): ParsedSheet {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean.slice(0, 4000));
  const raw = splitRows(clean, delimiter);

  // Drop entirely blank lines but remember original positions for error messages.
  const indexed = raw
    .map((cells, index) => ({ cells, lineNumber: index + 1 }))
    .filter((entry) => entry.cells.some((cell) => cell.trim() !== ''));

  if (indexed.length === 0) {
    return { headers: [], rows: [], rowNumbers: [] };
  }

  const headers = (indexed[0]?.cells ?? []).map((cell) => cell.trim());
  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];

  const dataRows = indexed.slice(1);
  for (const entry of dataRows.slice(0, maxRows)) {
    const record = blankRecord();
    headers.forEach((header, index) => {
      record[normaliseHeader(header)] = (entry.cells[index] ?? '').trim();
    });
    rows.push(record);
    rowNumbers.push(entry.lineNumber);
  }

  return {
    headers,
    rows,
    rowNumbers,
    ...(dataRows.length > maxRows ? { truncatedAt: maxRows } : {}),
  };
}

/** Serialise rows to CSV, quoting anything that needs it. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  // BOM so Excel opens Amharic correctly instead of showing mojibake.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
