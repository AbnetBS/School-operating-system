'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

type RowResult = {
  rowNumber: number;
  status: 'ready' | 'error' | 'imported' | 'skipped';
  errors: Record<string, string>;
  warnings: string[];
  preview: {
    studentCode: string;
    name: string;
    gradeLevel: string;
    section: string;
    guardian: string;
    dateOfBirth: string;
  };
};

type Report = {
  mode: 'validate' | 'commit';
  format: 'csv' | 'xlsx';
  sheetUsed?: string;
  sheetNames?: string[];
  totalRows: number;
  readyCount: number;
  errorCount: number;
  importedCount: number;
  unknownColumns: string[];
  missingRequiredColumns: string[];
  rows: RowResult[];
};

/**
 * Two-step import: check, then commit.
 *
 * The preview is the whole point — a school pasting 400 students needs to see
 * exactly which rows will fail and why *before* anything is written, and needs
 * to be able to exclude individual rows without editing the file.
 */
export default function ImportWizard({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<string>('');
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [committed, setCommitted] = useState(false);

  async function handleFile(chosen: File) {
    setError(null);
    setReport(null);
    setCommitted(false);
    setSkipped(new Set());
    setSheet('');

    if (chosen.size === 0) {
      setError('That file is empty.');
      return;
    }
    if (chosen.size > 5 * 1024 * 1024) {
      setError('That file is larger than 5 MB. Split it into smaller files.');
      return;
    }

    setFileName(chosen.name);
    setFile(chosen);
    await send(chosen, 'validate', '');
  }

  /**
   * One request shape for both passes. The file is sent as multipart so a
   * binary .xlsx survives intact — base64 in JSON would inflate it by a third
   * for no benefit.
   */
  async function send(
    target: File,
    mode: 'validate' | 'commit',
    sheetName: string,
    skipRows?: number[],
  ) {
    setBusy(true);
    setError(null);

    const form = new FormData();
    form.append('file', target);
    form.append('mode', mode);
    if (sheetName) form.append('sheet', sheetName);
    if (skipRows && skipRows.length > 0) form.append('skipRows', skipRows.join(','));

    try {
      const response = await fetch('/api/students/import', { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          data.error ??
            (mode === 'commit' ? 'The import failed.' : 'Could not read that file.'),
        );
        setBusy(false);
        return;
      }

      setReport(data);
      if (mode === 'commit') {
        setCommitted(true);
        router.refresh();
      }
    } catch {
      setError(
        mode === 'commit'
          ? 'Could not reach the server. No students were imported.'
          : 'Could not reach the server.',
      );
    }
    setBusy(false);
  }

  async function runCommit() {
    if (!file) return;
    await send(file, 'commit', sheet, [...skipped]);
  }

  async function changeSheet(name: string) {
    setSheet(name);
    setSkipped(new Set());
    if (file) await send(file, 'validate', name);
  }

  function toggleSkip(rowNumber: number) {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  const willImport = report ? report.rows.filter((r) => r.status === 'ready' && !skipped.has(r.rowNumber)).length : 0;

  return (
    <div className="space-y-4">
      {/* Step 1 — the file */}
      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">1. Choose your file</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              An Excel workbook (.xlsx) or a CSV file. Amharic text is supported in both.
            </p>
          </div>
          <a
            href="/api/students/import"
            className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-xs font-semibold text-ink-700 hover:bg-ink-50"
          >
            Download template
          </a>
        </div>

        <label className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-ink-300 px-4 py-6 text-center hover:border-brand-400 hover:bg-brand-50/40">
          <input
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <span className="text-sm font-medium text-ink-900">
            {fileName ?? 'Tap to choose an Excel or CSV file'}
          </span>
          <span className="mt-0.5 text-xs text-ink-500">
            {fileName ? 'Tap again to choose a different file' : '.xlsx or .csv, up to 5 MB'}
          </span>
        </label>

        {busy && <p className="mt-3 text-sm text-ink-500">Checking the file…</p>}
        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
      </section>

      {report && report.missingRequiredColumns.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <h3 className="text-sm font-semibold text-red-900">Required columns are missing</h3>
          <p className="mt-1 text-sm text-red-800">
            Add {report.missingRequiredColumns.join(', ')} to your file and try again.
          </p>
        </div>
      )}

      {/* Step 2 — the preview */}
      {report && report.rows.length > 0 && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink-900">
            {committed ? '3. Result' : '2. Check before importing'}
          </h2>

          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-ink-50 px-2 py-2.5">
              <p className="text-lg font-bold text-ink-900">{report.totalRows}</p>
              <p className="text-xs text-ink-500">rows in file</p>
            </div>
            <div className="rounded-lg bg-emerald-50 px-2 py-2.5">
              <p className="text-lg font-bold text-emerald-700">
                {committed ? report.importedCount : willImport}
              </p>
              <p className="text-xs text-emerald-700">
                {committed ? 'imported' : 'will import'}
              </p>
            </div>
            <div className="rounded-lg bg-red-50 px-2 py-2.5">
              <p className="text-lg font-bold text-red-700">{report.errorCount}</p>
              <p className="text-xs text-red-700">need fixing</p>
            </div>
          </div>

          {report.format === 'xlsx' && report.sheetUsed && (
            <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700">
              Read from the Excel sheet <strong>{report.sheetUsed}</strong>.
              {report.sheetNames && report.sheetNames.length > 1 && !committed && (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-ink-500">Wrong sheet?</span>
                  {report.sheetNames
                    .filter((name) => name !== report.sheetUsed)
                    .map((name) => (
                      <button
                        key={name}
                        type="button"
                        disabled={busy}
                        onClick={() => void changeSheet(name)}
                        className="tap-target rounded-lg border border-ink-300 bg-white px-2.5 py-1 font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                      >
                        Use “{name}”
                      </button>
                    ))}
                </span>
              )}
            </div>
          )}

          {report.unknownColumns.length > 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              These columns were not recognised and will be ignored:{' '}
              {report.unknownColumns.join(', ')}
            </p>
          )}

          {committed && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
              {report.importedCount} student{report.importedCount === 1 ? '' : 's'} imported.
              {report.errorCount > 0 && ' Rows with errors were left out — fix them and import again.'}
            </div>
          )}

          {/* Row list */}
          <ul className="mt-3 divide-y divide-ink-100">
            {report.rows.map((row) => {
              const isSkipped = skipped.has(row.rowNumber);
              return (
                <li key={row.rowNumber} className="py-2.5">
                  <div className="flex items-start gap-2.5">
                    {!committed && row.status !== 'error' && (
                      <input
                        type="checkbox"
                        checked={!isSkipped}
                        onChange={() => toggleSkip(row.rowNumber)}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-ink-300"
                        aria-label={`Import row ${row.rowNumber}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs text-ink-400">Row {row.rowNumber}</span>
                        <span className="text-sm font-medium text-ink-900">
                          {row.preview.name || <em className="text-ink-400">no name</em>}
                        </span>
                        {row.status === 'imported' && (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
                            imported
                          </span>
                        )}
                        {row.status === 'error' && (
                          <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">
                            error
                          </span>
                        )}
                        {isSkipped && !committed && (
                          <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600">
                            skipped
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ink-500">
                        {row.preview.studentCode} · {row.preview.gradeLevel}
                        {row.preview.section ? ` ${row.preview.section}` : ''}
                        {row.preview.dateOfBirth ? ` · born ${row.preview.dateOfBirth}` : ''}
                        {row.preview.guardian ? ` · ${row.preview.guardian}` : ''}
                      </p>
                      {Object.entries(row.errors).map(([field, message]) => (
                        <p key={field} className="mt-0.5 text-xs text-red-600">
                          {field === '_' ? '' : `${field}: `}
                          {message}
                        </p>
                      ))}
                      {row.warnings.map((warning) => (
                        <p key={warning} className="mt-0.5 text-xs text-amber-700">
                          {warning}
                        </p>
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex flex-wrap gap-2">
            {!committed ? (
              <>
                <button
                  type="button"
                  onClick={runCommit}
                  disabled={busy || willImport === 0 || !canCreate}
                  className="tap-target rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {busy
                    ? 'Importing…'
                    : `Import ${willImport} student${willImport === 1 ? '' : 's'}`}
                </button>
                <Link
                  href="/students"
                  className="tap-target rounded-lg border border-ink-300 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50"
                >
                  Cancel
                </Link>
              </>
            ) : (
              <Link
                href="/students"
                className="tap-target rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
              >
                View students
              </Link>
            )}
          </div>

          {!canCreate && (
            <p className="mt-2 text-xs text-amber-700">
              You can check files but not import them — that needs permission to register students.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
