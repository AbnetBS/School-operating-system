'use client';

/** Print via the browser; the print stylesheet hides the application chrome. */
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white"
    >
      Print
    </button>
  );
}
