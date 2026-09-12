/**
 * Global search.
 *
 * The page itself renders nothing sensitive: it resolves the caller's labels
 * and hands off to a client island that queries `/api/search`. All of the
 * permission, module and section logic lives on the server side of that route
 * — the browser is never told what it is not allowed to find.
 */

import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';
import { MIN_QUERY_LENGTH } from '../../../lib/analytics/search.ts';
import SearchBox from './SearchBox.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'search.title',
  'search.placeholder',
  'search.minLength',
  'search.noResults',
  'search.noResultsHelp',
  'search.searching',
  'search.results',
  'search.kind.student',
  'search.kind.guardian',
  'search.kind.staff',
  'search.kind.section',
  'search.kind.subject',
  'search.kind.fee',
  'search.kind.library',
  'search.kind.inventory',
  'search.kind.asset',
  'search.kind.vehicle',
  'search.kind.route',
  'search.kind.document',
];

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);

  // The same gate the API applies. Showing a search box to someone whose every
  // query would return nothing is worse than showing them a clear refusal.
  const canSearch = ctx.hasAny(
    'student.view',
    'staff.view',
    'guardian.view',
    'academic.view',
    'fee.view',
    'library.view',
    'inventory.view',
    'asset.view',
    'transport.view',
    'document.view',
  );

  if (!canSearch) {
    return (
      <Card>
        <EmptyState
          title={t('analytics.noPermission')}
          description={t('analytics.noPermissionHelp')}
        />
      </Card>
    );
  }

  const raw = await searchParams;
  const initial = raw.q;
  const initialQuery = (Array.isArray(initial) ? initial[0] : initial) ?? '';

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('search.title')} />
      <SearchBox labels={labels} minLength={MIN_QUERY_LENGTH} initialQuery={initialQuery} />
    </>
  );
}
