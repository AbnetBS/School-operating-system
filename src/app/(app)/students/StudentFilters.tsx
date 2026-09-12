'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, useTransition } from 'react';

type Grade = { id: string; name: string; level: number };
type Section = { id: string; name: string; gradeName: string; level: number };

/**
 * Search and filter controls.
 *
 * The search box is debounced so typing does not fire a request per keystroke
 * — relevant on the slow connections these schools often have.
 */
export default function StudentFilters({
  grades,
  sections,
  current,
}: {
  grades: Grade[];
  sections: Section[];
  current: { search: string; status: string; gradeLevelId: string; sectionId: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(current.search);

  function apply(changes: Record<string, string>) {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) sp.set(key, value);
      else sp.delete(key);
    }
    sp.delete('page'); // any filter change returns to page 1
    startTransition(() => router.push(`/students?${sp.toString()}`));
  }

  useEffect(() => {
    if (search === current.search) return;
    const timer = setTimeout(() => apply({ search }), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const hasFilters =
    current.status || current.gradeLevelId || current.sectionId || current.search;

  return (
    <div className="card p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or student ID…"
            className="tap-target w-full rounded-lg border border-ink-300 px-3 py-2 text-base placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 sm:text-sm"
            aria-label="Search students"
          />
          {pending && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-400">
              …
            </span>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          <select
            value={current.gradeLevelId}
            onChange={(e) => apply({ gradeLevelId: e.target.value, sectionId: '' })}
            className="tap-target shrink-0 rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            aria-label="Filter by grade"
          >
            <option value="">All grades</option>
            {grades.map((grade) => (
              <option key={grade.id} value={grade.id}>
                {grade.name}
              </option>
            ))}
          </select>

          <select
            value={current.sectionId}
            onChange={(e) => apply({ sectionId: e.target.value })}
            className="tap-target shrink-0 rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            aria-label="Filter by section"
          >
            <option value="">All sections</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.gradeName} {section.name}
              </option>
            ))}
          </select>

          <select
            value={current.status}
            onChange={(e) => apply({ status: e.target.value })}
            className="tap-target shrink-0 rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="transferred">Transferred</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="graduated">Graduated</option>
            <option value="suspended">Suspended</option>
            <option value="inactive">Inactive</option>
          </select>

          {hasFilters && (
            <button
              onClick={() => {
                setSearch('');
                startTransition(() => router.push('/students'));
              }}
              className="tap-target shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
