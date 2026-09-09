'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Void a payment.
 *
 * Voiding is the only correction a payment allows — the row is never edited or
 * deleted, so the ledger keeps its history. A reason is mandatory, both here
 * and at the database, because a reversal with no explanation is worse than no
 * reversal at all.
 */
export default function VoidPaymentButton({
  paymentId,
  label,
  reasonLabel,
  confirmText,
}: {
  paymentId: string;
  label: string;
  reasonLabel: string;
  confirmText: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/payments/${paymentId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'The payment could not be voided.');
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap-target rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
      >
        {label}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="w-full rounded-lg border border-red-300 bg-red-50 p-3">
      <p className="text-xs text-red-800">{confirmText}</p>
      <label htmlFor="voidReason" className="mt-2 block text-xs font-medium text-red-900">
        {reasonLabel}
      </label>
      <input
        id="voidReason"
        name="voidReason"
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={3}
        autoFocus
        className="tap-target mt-1 w-full rounded-lg border border-red-300 px-3 py-2 text-sm"
      />
      {error && <p className="mt-1 text-xs text-red-800">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={busy || reason.trim().length < 3}
          className="tap-target rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? '…' : label}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2 text-sm font-medium text-ink-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
