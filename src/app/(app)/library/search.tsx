'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * Catalogue search.
 *
 * A client island because it needs the URL and a form submit; the page around
 * it stays a server component so the query runs on the server with the
 * caller's own permissions.
 */
export function LibrarySearch({
  placeholder,
  initial,
}: {
  placeholder: string;
  initial: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(initial);

  return (
    <form
      className="mb-4 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const next = new URLSearchParams(params.toString());
        if (value.trim()) next.set('q', value.trim());
        else next.delete('q');
        router.push(`/library?${next.toString()}`);
      }}
    >
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        className="tap-target min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        {placeholder.split(' ')[0]}
      </button>
    </form>
  );
}
