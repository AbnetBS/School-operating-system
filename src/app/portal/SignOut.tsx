'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The logout endpoint answers with JSON rather than a redirect, so signing out
 * is a fetch followed by a client-side navigation — the same approach the
 * staff shell uses.
 */
export default function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/login');
        router.refresh();
      }}
      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-sm font-medium text-ink-700 disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
