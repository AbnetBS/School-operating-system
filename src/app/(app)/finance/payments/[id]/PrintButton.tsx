'use client';

/**
 * Print the receipt.
 *
 * The sheet itself is produced by the print stylesheet, so this button is pure
 * convenience — Ctrl+P gives exactly the same output for anyone who never sees
 * it, including someone browsing with JavaScript disabled.
 */
export default function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="tap-target rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
    >
      {label}
    </button>
  );
}
