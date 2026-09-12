/**
 * Audit log.
 *
 * Read-only by construction: there is no route that edits or deletes an entry,
 * because an audit trail that can be tidied up is not an audit trail.
 *
 * Every query goes through `queryAuditLog` with `schoolId` taken from the
 * session. The filter form cannot widen that — there is no school field, and
 * the route-contract test asserts that no handler reads a school id from a
 * request.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { queryAuditLog, describeAuditEntry, AUDIT_ACTIONS } from '../../../lib/audit/index.ts';
import { auditLog } from '../../../db/schema/core.ts';
import { PageHeader, Card, EmptyState, Badge } from '../../../components/ui.tsx';
import AuditFilters from './AuditFilters.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const LABEL_KEYS = [
  'audit.filter',
  'audit.action',
  'audit.actor',
  'audit.entity',
  'audit.from',
  'audit.to',
  'audit.anyAction',
  'audit.anyUser',
  'audit.anyEntity',
  'audit.clear',
];

/** Render a changed-value map compactly, without dumping raw JSON at a user. */
function summarise(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries
    .slice(0, 6)
    .map(([key, v]) => `${key}: ${v === null || v === undefined ? '—' : String(v)}`)
    .join(', ');
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    entityType?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  // Server-side, as always. The nav hides the link without this permission,
  // but hiding is not enforcing.
  if (!ctx.has('audit.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const from = isoDate.test(params.from ?? '') ? new Date(`${params.from}T00:00:00Z`) : undefined;
  // `to` is inclusive of the whole day, which is what a person means by it.
  const to = isoDate.test(params.to ?? '') ? new Date(`${params.to}T23:59:59Z`) : undefined;

  const { rows, total } = await queryAuditLog(ctx.db, {
    // The school id comes from the session, never from the query string.
    schoolId: ctx.schoolId,
    entityType: params.entityType || undefined,
    action: params.action || undefined,
    actorUserId: params.actor || undefined,
    from,
    to,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  // Filter options, drawn only from this school's own log.
  const [actorRows, entityRows, actionRows] = await Promise.all([
    ctx.db
      .selectDistinct({ id: auditLog.actorUserId, name: auditLog.actorName })
      .from(auditLog)
      .where(and(eq(auditLog.schoolId, ctx.schoolId), sql`${auditLog.actorUserId} is not null`))
      .orderBy(desc(auditLog.actorName))
      .limit(100),
    ctx.db
      .selectDistinct({ entityType: auditLog.entityType })
      .from(auditLog)
      .where(eq(auditLog.schoolId, ctx.schoolId))
      .limit(100),
    ctx.db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.schoolId, ctx.schoolId))
      .limit(200),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  const qs = (nextPage: number) => {
    const sp = new URLSearchParams();
    if (params.action) sp.set('action', params.action);
    if (params.actor) sp.set('actor', params.actor);
    if (params.entityType) sp.set('entityType', params.entityType);
    if (params.from) sp.set('from', params.from);
    if (params.to) sp.set('to', params.to);
    if (nextPage > 1) sp.set('page', String(nextPage));
    return sp.toString() ? `/audit?${sp.toString()}` : '/audit';
  };

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />

      <Card>
        <AuditFilters
          labels={labels}
          actions={actionRows
            .map((r) => ({
              value: r.action,
              label: AUDIT_ACTIONS[r.action as keyof typeof AUDIT_ACTIONS] ?? r.action,
            }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          actors={actorRows
            .filter((r): r is { id: string; name: string | null } => Boolean(r.id))
            .map((r) => ({ value: r.id, label: r.name ?? r.id }))}
          entityTypes={entityRows
            .map((r) => ({ value: r.entityType, label: r.entityType }))
            .sort((a, b) => a.label.localeCompare(b.label))}
        />

        {rows.length === 0 ? (
          <EmptyState title={t('audit.empty')} />
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-500">
              {t('audit.results', { count: String(total) })}
            </p>

            <ul className="divide-y divide-ink-100">
              {rows.map((entry) => {
                const before = summarise(entry.previousValue);
                const after = summarise(entry.newValue);
                return (
                  <li key={entry.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm text-ink-800">
                        {describeAuditEntry(entry)}
                      </p>
                      <Badge tone="neutral">{entry.entityType}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {entry.createdAt.toISOString().replace('T', ' ').slice(0, 19)}
                      {entry.ipAddress && ` · ${entry.ipAddress}`}
                    </p>
                    {entry.reason && (
                      <p className="mt-1 text-xs italic text-ink-600">“{entry.reason}”</p>
                    )}
                    {/* Before/after, when the entry actually carries them.
                        Shown as a disclosure so the list stays scannable. */}
                    {(before || after) && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs font-medium text-brand-700">
                          {t('audit.showDetail')}
                        </summary>
                        <dl className="mt-1.5 space-y-1 rounded-lg bg-ink-50 p-2.5 text-xs">
                          {before && (
                            <div>
                              <dt className="font-medium text-ink-600">{t('audit.before')}</dt>
                              <dd className="break-words text-ink-700">{before}</dd>
                            </div>
                          )}
                          {after && (
                            <div>
                              <dt className="font-medium text-ink-600">{t('audit.after')}</dt>
                              <dd className="break-words text-ink-700">{after}</dd>
                            </div>
                          )}
                        </dl>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>

            {pages > 1 && (
              <nav className="mt-4 flex items-center justify-between gap-2 text-sm">
                {page > 1 ? (
                  <Link
                    href={qs(page - 1)}
                    className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-ink-700 hover:bg-ink-50"
                  >
                    {t('action.back')}
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-ink-500">
                  {page} / {pages}
                </span>
                {page < pages ? (
                  <Link
                    href={qs(page + 1)}
                    className="tap-target rounded-lg border border-ink-300 px-3 py-2 text-ink-700 hover:bg-ink-50"
                  >
                    {t('action.next')}
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </>
        )}
      </Card>
    </>
  );
}
