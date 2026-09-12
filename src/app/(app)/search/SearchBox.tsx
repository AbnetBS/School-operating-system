'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type Hit = {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

type Labels = Record<string, string>;

/**
 * The search field and its results.
 *
 * Two behaviours matter more than they look:
 *
 *  - **Debounced.** A request per keystroke would put a query on the database
 *    for every letter of every search by every user. 250 ms is long enough to
 *    collapse a typed word into one request and short enough to feel instant.
 *  - **Ordered responses.** A slow reply for "Ab" must not overwrite a fast
 *    reply for "Abebe". Each request carries a sequence number and a stale one
 *    is discarded, which is a real bug in most hand-rolled search boxes.
 */
export default function SearchBox({
  labels,
  minLength,
  initialQuery,
}: {
  labels: Labels;
  minLength: number;
  initialQuery: string;
}) {
  const router = useRouter();
  // A label that failed to resolve must degrade to its key, never crash the
  // page with "cannot read property of undefined".
  const label = (key: string) => labels[key] ?? key;
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<Hit[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const sequence = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < minLength) {
      setHits([]);
      setState('idle');
      return;
    }

    const mine = ++sequence.current;
    setState('loading');

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          headers: { accept: 'application/json' },
        });
        // A response that arrived after a newer request was issued is stale.
        if (mine !== sequence.current) return;

        if (!response.ok) {
          setHits([]);
          setState('done');
          return;
        }
        const body = (await response.json()) as { hits?: Hit[] };
        if (mine !== sequence.current) return;
        setHits(body.hits ?? []);
        setState('done');
      } catch {
        if (mine !== sequence.current) return;
        setHits([]);
        setState('done');
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query, minLength]);

  return (
    <div>
      <label className="block">
        <span className="sr-only">{label('search.title')}</span>
        <input
          type="search"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder={label('search.placeholder')}
          className="w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-base outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
      </label>

      <div className="mt-4">
        {query.trim().length > 0 && query.trim().length < minLength && (
          <p className="text-sm text-ink-500">
            {label('search.minLength').replace('{count}', String(minLength))}
          </p>
        )}

        {state === 'loading' && hits.length === 0 && (
          <p className="text-sm text-ink-500">{label('search.searching')}</p>
        )}

        {state === 'done' && hits.length === 0 && query.trim().length >= minLength && (
          <div className="rounded-xl border border-ink-200 bg-white p-6 text-center">
            <p className="text-sm font-medium text-ink-900">
              {label('search.noResults').replace('{query}', query.trim())}
            </p>
            <p className="mt-1 text-sm text-ink-500">{label('search.noResultsHelp')}</p>
          </div>
        )}

        {hits.length > 0 && (
          <>
            <p className="mb-2 text-xs text-ink-500">
              {label('search.results').replace('{count}', String(hits.length))}
            </p>
            <ul className="divide-y divide-ink-100 overflow-hidden rounded-xl border border-ink-200 bg-white">
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <Link
                    href={hit.href}
                    onClick={() => router.push(hit.href)}
                    className="tap-target flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-ink-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">{hit.title}</p>
                      {hit.subtitle && (
                        <p className="truncate text-xs text-ink-500">{hit.subtitle}</p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
                      {labels[`search.kind.${hit.kind}`] ?? hit.kind}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
