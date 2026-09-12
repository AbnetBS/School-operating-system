'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type Row = {
  reportCardId: string | null;
  studentId: string;
  studentName: string;
  studentCode: string;
  status: string;
  average: number | null;
  rank: number | null;
};

const TONE: Record<string, string> = {
  not_generated: 'bg-ink-100 text-ink-600',
  draft: 'bg-ink-100 text-ink-700',
  pending_approval: 'bg-amber-100 text-amber-800',
  approved: 'bg-brand-100 text-brand-800',
  published: 'bg-emerald-100 text-emerald-800',
};

const LABEL: Record<string, string> = {
  not_generated: 'Not generated',
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  published: 'Published',
};

/**
 * Report-card progress for a class, with the two bulk actions that matter:
 * generate the term's cards, and publish them to the portals.
 *
 * Publishing is deliberately a separate, explicit step — generating a card
 * must never make it visible to parents on its own.
 */
export default function SectionReportCards({
  termId,
  sectionId,
  initialRows,
  canGenerate,
  canApprove,
  canPublish,
}: {
  termId: string;
  sectionId: string;
  initialRows: Row[];
  canGenerate: boolean;
  canApprove: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function refresh() {
    const res = await fetch(`/api/report-cards?termId=${termId}&sectionId=${sectionId}`);
    if (res.ok) {
      const data = await res.json();
      setRows(data.students);
    }
    router.refresh();
  }

  async function generate() {
    setBusy(true);
    setMessage(null);
    const res = await fetch('/api/report-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ termId, sectionId }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMessage({ tone: 'bad', text: body.error ?? 'The report cards could not be generated.' });
      return;
    }
    setMessage({
      tone: 'ok',
      text: `${body.generated} generated, ${body.skipped} left unchanged.`,
    });
    await refresh();
  }

  async function publishAll() {
    setBusy(true);
    setMessage(null);
    const res = await fetch('/api/report-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publishSection', termId, sectionId }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMessage({ tone: 'bad', text: body.error ?? 'The report cards could not be published.' });
      return;
    }
    setMessage({
      tone: 'ok',
      text:
        body.blocked > 0
          ? `${body.published} published. ${body.blocked} still need approval first.`
          : `${body.published} published to the portals.`,
    });
    await refresh();
  }

  async function act(id: string, action: string) {
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/report-cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMessage({ tone: 'bad', text: body.error ?? 'That action could not be completed.' });
      return;
    }
    await refresh();
  }

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {message && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canGenerate && (
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Generate report cards'}
          </button>
        )}
        {canPublish && (
          <button
            type="button"
            onClick={publishAll}
            disabled={busy}
            className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 disabled:opacity-50"
          >
            Publish to portals
          </button>
        )}
        <span className="text-xs text-ink-500">
          {Object.entries(counts)
            .map(([k, n]) => `${n} ${LABEL[k]?.toLowerCase() ?? k}`)
            .join(' · ')}
        </span>
      </div>

      <section className="card">
        {/* Mobile: cards. Desktop: table. */}
        <ul className="divide-y divide-ink-100 sm:hidden">
          {rows.map((r) => (
            <li key={r.studentId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">{r.studentName}</p>
                <p className="truncate text-xs text-ink-500">
                  {r.studentCode}
                  {r.average !== null ? ` · ${r.average}%` : ''}
                  {r.rank !== null ? ` · rank ${r.rank}` : ''}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  TONE[r.status] ?? 'bg-ink-100 text-ink-600'
                }`}
              >
                {LABEL[r.status] ?? r.status}
              </span>
              {r.reportCardId && (
                <Link
                  href={`/report-cards/${r.reportCardId}`}
                  className="tap-target shrink-0 text-sm font-medium text-brand-700"
                >
                  View
                </Link>
              )}
            </li>
          ))}
        </ul>

        <div className="-mx-4 hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-4 py-2.5 font-medium">Student</th>
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 text-right font-medium">Average</th>
                <th className="px-4 py-2.5 text-right font-medium">Rank</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId} className="border-b border-ink-100">
                  <td className="px-4 py-2.5 font-medium text-ink-900">{r.studentName}</td>
                  <td className="px-4 py-2.5 text-ink-600">{r.studentCode}</td>
                  <td className="px-4 py-2.5 text-right text-ink-700">
                    {r.average === null ? '—' : `${r.average}%`}
                  </td>
                  <td className="px-4 py-2.5 text-right text-ink-700">{r.rank ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        TONE[r.status] ?? 'bg-ink-100 text-ink-600'
                      }`}
                    >
                      {LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      {r.reportCardId && canApprove && r.status === 'pending_approval' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(r.reportCardId!, 'approve')}
                          className="text-xs font-medium text-brand-700 hover:underline disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                      {r.reportCardId && (
                        <Link
                          href={`/report-cards/${r.reportCardId}`}
                          className="text-xs font-medium text-brand-700 hover:underline"
                        >
                          View
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
