'use client';

/**
 * The lending desk.
 *
 * Built around what actually happens at a school library counter: a queue of
 * children, one book each, and a librarian who must not have to think about
 * the software. So:
 *
 *   - the borrower stays selected after an issue, because the same child often
 *     takes two books, but the copy field clears and refocuses;
 *   - returns are found by typing the accession number written in the book,
 *     which is the only identifier physically present at the desk;
 *   - availability is never sent by this component. It asks the server what is
 *     available and shows the answer; the server re-checks under a row lock
 *     when the issue is actually attempted.
 *
 * A copy that is out is shown, greyed, with who has it — telling a librarian
 * "no copies available" without saying where they went is useless.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  Select,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  SecondaryButton,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type Student = {
  id: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string | null;
  studentCode: string;
};

type StaffMember = {
  id: string;
  givenName: string;
  fatherName: string;
  staffCode: string;
  jobTitle: string | null;
};

type Copy = {
  id: string;
  accessionNumber: string;
  status: string;
  condition: string;
  loanId: string | null;
  borrowerName: string | null;
  dueOn: string | null;
};

type Item = {
  id: string;
  title: string;
  author: string | null;
  totalCopies: number;
  availableCopies: number;
};

type Loan = {
  id: string;
  title: string;
  accessionNumber: string;
  borrowerName: string;
  borrowerRef: string | null;
  issuedOn: string;
  dueOn: string;
  daysOverdue: number;
};

/** Interpolate the same way the server translator does. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

export default function LendingDesk({
  labels,
  today,
  conditions,
  canIssue,
}: {
  labels: Labels;
  today: string;
  conditions: string[];
  canIssue: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();

  const [tab, setTab] = useState<'issue' | 'return'>('issue');

  return (
    <Card>
      <div
        role="tablist"
        aria-label={t('library.desk')}
        className="mb-4 flex gap-2 border-b border-ink-200"
      >
        {(['issue', 'return'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`tap-target -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
              tab === key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-500 hover:text-ink-700'
            }`}
          >
            {key === 'issue' ? t('library.issue') : t('library.return')}
          </button>
        ))}
      </div>

      {tab === 'issue' ? (
        <IssuePanel labels={labels} t={t} today={today} canIssue={canIssue} router={router} />
      ) : (
        <ReturnPanel labels={labels} t={t} conditions={conditions} router={router} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

function IssuePanel({
  labels,
  t,
  today,
  canIssue,
  router,
}: {
  labels: Labels;
  t: (k: string) => string;
  today: string;
  canIssue: boolean;
  router: ReturnType<typeof useRouter>;
}) {
  const { saving, error, fieldErrors, submit, reset } = useSubmit();

  const [borrowerType, setBorrowerType] = useState<'student' | 'staff'>('student');
  const [borrowerQuery, setBorrowerQuery] = useState('');
  const [borrowerResults, setBorrowerResults] = useState<(Student | StaffMember)[]>([]);
  const [borrower, setBorrower] = useState<{ id: string; name: string; ref: string } | null>(null);
  const [searching, setSearching] = useState(false);

  const [titleQuery, setTitleQuery] = useState('');
  const [titleResults, setTitleResults] = useState<Item[]>([]);
  const [item, setItem] = useState<Item | null>(null);
  const [copies, setCopies] = useState<Copy[]>([]);
  const [loadingCopies, setLoadingCopies] = useState(false);
  const [copyId, setCopyId] = useState('');
  const [dueOn, setDueOn] = useState('');

  const [success, setSuccess] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  // --- borrower search ------------------------------------------------------
  useEffect(() => {
    if (borrower) return;
    const term = borrowerQuery.trim();
    if (term.length < 2) {
      setBorrowerResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const url =
          borrowerType === 'student'
            ? `/api/students?search=${encodeURIComponent(term)}&pageSize=8&status=active`
            : `/api/staff?search=${encodeURIComponent(term)}&pageSize=8&status=active`;
        const res = await fetch(url, { signal: controller.signal });
        if (res.ok) {
          const body = await res.json();
          // The two endpoints return different envelopes: students under
          // `data`, staff under `rows`.
          setBorrowerResults(borrowerType === 'student' ? (body.data ?? []) : (body.rows ?? []));
        }
      } catch {
        // An aborted keystroke is not an error worth showing.
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [borrowerQuery, borrowerType, borrower]);

  // --- title search ---------------------------------------------------------
  useEffect(() => {
    if (item) return;
    const term = titleQuery.trim();
    if (term.length < 2) {
      setTitleResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/library/items?q=${encodeURIComponent(term)}&pageSize=8`,
          { signal: controller.signal },
        );
        if (res.ok) {
          const body = await res.json();
          setTitleResults(body.data ?? []);
        }
      } catch {
        /* aborted */
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [titleQuery, item]);

  // --- copies for the chosen title -----------------------------------------
  const loadCopies = useCallback(async (itemId: string) => {
    setLoadingCopies(true);
    try {
      const res = await fetch(`/api/library/items/${itemId}`);
      if (res.ok) {
        const body = await res.json();
        const list: Copy[] = body.copies ?? [];
        setCopies(list);
        // Pre-select the first copy that can actually go out, so the common
        // case is one tap.
        const free = list.find((c) => c.status === 'available' && !c.loanId);
        setCopyId(free?.id ?? '');
      }
    } finally {
      setLoadingCopies(false);
    }
  }, []);

  useEffect(() => {
    if (item) void loadCopies(item.id);
  }, [item, loadCopies]);

  function clearBorrower() {
    setBorrower(null);
    setBorrowerQuery('');
    setBorrowerResults([]);
  }

  function clearTitle() {
    setItem(null);
    setTitleQuery('');
    setTitleResults([]);
    setCopies([]);
    setCopyId('');
  }

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    if (!borrower || !copyId) return;
    setSuccess(null);

    const result = await submit<{ id: string; dueOn: string; accessionNumber: string }>(
      '/api/library/loans',
      {
        method: 'POST',
        body: {
          copyId,
          studentId: borrowerType === 'student' ? borrower.id : null,
          staffId: borrowerType === 'staff' ? borrower.id : null,
          dueOn: dueOn || null,
          note: null,
        },
      },
    );

    if (!result) return; // The banner shows why; no success is claimed.

    setSuccess(fill(labels['library.issued'] ?? '', { date: result.dueOn }));
    // Keep the borrower — the next book is usually for the same child.
    clearTitle();
    setDueOn('');
    router.refresh();
    titleInput.current?.focus();
  }

  if (!canIssue) {
    return <EmptyState title={t('ops.readOnly')} />;
  }

  const available = copies.filter((c) => c.status === 'available' && !c.loanId);

  return (
    <form onSubmit={issue} className="space-y-5">
      {/* --- borrower ------------------------------------------------------ */}
      <div>
        <p className="mb-2 text-sm font-semibold text-ink-900">{t('library.issueTo')}</p>

        {borrower ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink-900">
                {borrower.name}
              </span>
              <span className="block font-mono text-xs text-ink-500">{borrower.ref}</span>
            </span>
            <button
              type="button"
              onClick={clearBorrower}
              className="shrink-0 text-xs font-semibold text-brand-700 underline"
            >
              {t('ops.change')}
            </button>
          </div>
        ) : (
          <>
            <div className="mb-2 flex gap-2">
              {(['student', 'staff'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setBorrowerType(kind);
                    setBorrowerResults([]);
                  }}
                  aria-pressed={borrowerType === kind}
                  className={`tap-target rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    borrowerType === kind
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-ink-300 bg-white text-ink-700'
                  }`}
                >
                  {kind === 'student' ? t('library.borrowerStudent') : t('library.borrowerStaff')}
                </button>
              ))}
            </div>
            <TextInput
              type="search"
              value={borrowerQuery}
              onChange={(e) => setBorrowerQuery(e.target.value)}
              placeholder={
                borrowerType === 'student' ? t('ops.searchStudent') : t('ops.searchStaff')
              }
              invalid={Boolean(fieldErrors.studentId ?? fieldErrors.staffId)}
            />
            {searching && <p className="mt-1 text-xs text-ink-400">{t('ops.loading')}</p>}
            {borrowerResults.length > 0 && (
              <ul className="mt-2 max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
                {borrowerResults.map((row) => {
                  const isStudent = 'studentCode' in row;
                  const name = isStudent
                    ? [row.givenName, row.fatherName, (row as Student).grandfatherName]
                        .filter(Boolean)
                        .join(' ')
                    : [row.givenName, row.fatherName].filter(Boolean).join(' ');
                  const ref = isStudent
                    ? (row as Student).studentCode
                    : (row as StaffMember).staffCode;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setBorrower({ id: row.id, name, ref })}
                        className="tap-target flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-ink-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-ink-900">{name}</span>
                          <span className="block font-mono text-xs text-ink-500">{ref}</span>
                        </span>
                        <span aria-hidden className="text-ink-400">
                          →
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {borrowerQuery.trim().length >= 2 &&
              !searching &&
              borrowerResults.length === 0 && (
                <p className="mt-1 text-xs text-ink-500">{t('ops.noResults')}</p>
              )}
          </>
        )}
      </div>

      {/* --- title and copy ------------------------------------------------ */}
      <div>
        <p className="mb-2 text-sm font-semibold text-ink-900">{t('library.item')}</p>

        {item ? (
          <div className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink-900">
                  {item.title}
                </span>
                {item.author && (
                  <span className="block truncate text-xs text-ink-500">{item.author}</span>
                )}
              </span>
              <button
                type="button"
                onClick={clearTitle}
                className="shrink-0 text-xs font-semibold text-brand-700 underline"
              >
                {t('ops.change')}
              </button>
            </div>

            {loadingCopies ? (
              <p className="mt-2 text-xs text-ink-500">{t('ops.loading')}</p>
            ) : copies.length === 0 ? (
              <p className="mt-2 text-xs text-amber-700">{t('library.noCopies')}</p>
            ) : available.length === 0 ? (
              <p className="mt-2 text-sm font-medium text-amber-800">
                {t('library.noAvailableCopies')}
              </p>
            ) : null}

            {copies.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {copies.map((copy) => {
                  const free = copy.status === 'available' && !copy.loanId;
                  return (
                    <li key={copy.id}>
                      <label
                        className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 ${
                          free
                            ? 'cursor-pointer border-ink-200 bg-white hover:border-brand-300'
                            : 'cursor-not-allowed border-ink-100 bg-ink-50 opacity-70'
                        }`}
                      >
                        <input
                          type="radio"
                          name="copyId"
                          value={copy.id}
                          checked={copyId === copy.id}
                          disabled={!free}
                          onChange={() => setCopyId(copy.id)}
                          className="size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 font-mono text-xs text-ink-800">
                          {copy.accessionNumber}
                        </span>
                        {free ? (
                          <Badge tone="good">{t('library.copyStatus.available')}</Badge>
                        ) : copy.loanId ? (
                          <span className="shrink-0 text-xs text-ink-500">
                            {fill(labels['library.onLoanTo'] ?? '', {
                              name: copy.borrowerName ?? '—',
                            })}
                          </span>
                        ) : (
                          <Badge tone="warn">{t(`library.copyStatus.${copy.status}`)}</Badge>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <>
            <TextInput
              ref={titleInput}
              type="search"
              value={titleQuery}
              onChange={(e) => setTitleQuery(e.target.value)}
              placeholder={t('library.searchPlaceholder')}
              invalid={Boolean(fieldErrors.copyId)}
            />
            {titleResults.length > 0 && (
              <ul className="mt-2 max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
                {titleResults.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setItem(row)}
                      className="tap-target flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-ink-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink-900">{row.title}</span>
                        {row.author && (
                          <span className="block truncate text-xs text-ink-500">{row.author}</span>
                        )}
                      </span>
                      <Badge tone={row.availableCopies > 0 ? 'good' : 'warn'}>
                        {row.availableCopies}/{row.totalCopies}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <Field
        label={t('library.dueDate')}
        htmlFor="dueOn"
        hint={t('library.dueDateHelp')}
        error={fieldErrors.dueOn}
      >
        <TextInput
          id="dueOn"
          name="dueOn"
          type="date"
          min={today}
          value={dueOn}
          onChange={(e) => setDueOn(e.target.value)}
          invalid={Boolean(fieldErrors.dueOn)}
        />
      </Field>

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      <div className="flex items-center justify-between gap-3">
        {borrower && item && available.length === 0 ? (
          <span className="text-xs font-medium text-amber-800">{t('library.cannotIssue')}</span>
        ) : (
          <span />
        )}
        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={!borrower || !copyId}
        >
          {t('library.issue')}
        </SubmitButton>
      </div>
      {(success || error) && (
        <SecondaryButton
          onClick={() => {
            setSuccess(null);
            reset();
            clearBorrower();
            clearTitle();
          }}
        >
          {t('ops.done')}
        </SecondaryButton>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

function ReturnPanel({
  labels,
  t,
  conditions,
  router,
}: {
  labels: Labels;
  t: (k: string) => string;
  conditions: string[];
  router: ReturnType<typeof useRouter>;
}) {
  const { saving, error, submit } = useSubmit();
  const [query, setQuery] = useState('');
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(false);
  const [condition, setCondition] = useState('good');
  const [success, setSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const search = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/library/loans?status=open&pageSize=15${term ? `&q=${encodeURIComponent(term)}` : ''}`,
      );
      if (res.ok) {
        const body = await res.json();
        setLoans(body.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void search(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query, search]);

  async function act(loan: Loan, action: 'return' | 'renew') {
    setSuccess(null);
    setBusyId(loan.id);
    try {
      const body =
        action === 'return'
          ? { action, condition, fineCents: null, waiveFine: false, note: null }
          : { action };

      const result = await submit<{ dueOn?: string }>(`/api/library/loans/${loan.id}`, {
        method: 'PATCH',
        body,
      });
      if (!result) return;

      setSuccess(
        action === 'return'
          ? `${loan.title} — ${t('library.returned')}`
          : fill(labels['library.renewed'] ?? '', { date: result.dueOn ?? '' }),
      );
      // Show the resulting state: the row leaves the open list on return.
      await search(query.trim());
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <TextInput
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('library.accession')}
        autoFocus
      />

      <Field label={t('library.returnCondition')} htmlFor="returnCondition">
        <Select
          id="returnCondition"
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
        >
          {conditions.map((c) => (
            <option key={c} value={c}>
              {t(`library.condition.${c}`)}
            </option>
          ))}
        </Select>
      </Field>

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      {loading ? (
        <p className="text-sm text-ink-500">{t('ops.loading')}</p>
      ) : loans.length === 0 ? (
        <EmptyState title={t('library.noLoans')} />
      ) : (
        <ul className="divide-y divide-ink-100">
          {loans.map((loan) => (
            <li key={loan.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{loan.title}</p>
                  <p className="truncate text-xs text-ink-600">
                    {loan.borrowerName}
                    {loan.borrowerRef && ` · ${loan.borrowerRef}`}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-ink-400">{loan.accessionNumber}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {loan.daysOverdue > 0 ? (
                    <Badge tone="bad">
                      {fill(labels['library.overdueBy'] ?? '', {
                        days: String(loan.daysOverdue),
                      })}
                    </Badge>
                  ) : (
                    <span className="text-xs text-ink-500">
                      {t('library.dueOn')} {loan.dueOn}
                    </span>
                  )}
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void act(loan, 'renew')}
                      disabled={saving && busyId === loan.id}
                      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                    >
                      {t('library.renew')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(loan, 'return')}
                      disabled={saving && busyId === loan.id}
                      className="tap-target rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {busyId === loan.id && saving ? '…' : t('library.return')}
                    </button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
