'use client';

/**
 * Audit filters.
 *
 * A plain GET form, so a filtered view is a shareable URL and survives a
 * reload. The options are built from this school's own actors and the action
 * catalogue; the school id is never a field, because it comes from the session
 * on the server and nothing the browser sends can change it.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

type Option = { value: string; label: string };

export default function AuditFilters({
  actions,
  actors,
  entityTypes,
  labels,
}: {
  actions: Option[];
  actors: Option[];
  entityTypes: Option[];
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const [action, setAction] = useState(params.get('action') ?? '');
  const [actor, setActor] = useState(params.get('actor') ?? '');
  const [entityType, setEntityType] = useState(params.get('entityType') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');

  const t = (key: string) => labels[key] ?? key;

  function apply(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (action) next.set('action', action);
    if (actor) next.set('actor', actor);
    if (entityType) next.set('entityType', entityType);
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    router.push(`/audit${next.toString() ? `?${next.toString()}` : ''}`);
  }

  function clear() {
    setAction('');
    setActor('');
    setEntityType('');
    setFrom('');
    setTo('');
    router.push('/audit');
  }

  const control =
    'tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900';

  return (
    <form onSubmit={apply} className="mb-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">{t('audit.action')}</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className={control}
          >
            <option value="">{t('audit.anyAction')}</option>
            {actions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">{t('audit.actor')}</span>
          <select value={actor} onChange={(e) => setActor(e.target.value)} className={control}>
            <option value="">{t('audit.anyUser')}</option>
            {actors.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">{t('audit.entity')}</span>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className={control}
          >
            <option value="">{t('audit.anyEntity')}</option>
            {entityTypes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">{t('audit.from')}</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={control}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-600">{t('audit.to')}</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={control}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t('audit.filter')}
        </button>
        <button
          type="button"
          onClick={clear}
          className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
        >
          {t('audit.clear')}
        </button>
      </div>
    </form>
  );
}
