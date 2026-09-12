'use client';

/**
 * Shared form primitives for the operations write screens.
 *
 * Every Group 8 form needs the same six behaviours, and writing them once
 * means a screen cannot accidentally omit one:
 *
 *   - a submit that disables itself while in flight (double-tap protection),
 *   - field-level errors keyed the way `zodFields()` returns them,
 *   - a server error banner that is shown INSTEAD of success, never beside it,
 *   - a success confirmation that reports the resulting state,
 *   - 44px touch targets and 16px inputs, so Android does not zoom on focus,
 *   - labels supplied by the server, because a client component cannot call
 *     `createTranslator` — see the i18n note in the layout.
 *
 * There is deliberately no client-side "is this allowed?" logic here. Hiding a
 * control is a courtesy; the server decides.
 */

import { useCallback, useRef, useState } from 'react';

export type Fields = Record<string, string>;

/** The error shape every route returns via `src/lib/api/respond.ts`. */
type ApiError = { error?: string; fields?: Fields };

export type SubmitState = {
  saving: boolean;
  error: string | null;
  fieldErrors: Fields;
};

/**
 * Perform a mutating request with consistent state handling.
 *
 * Returns the parsed body on success and `null` on failure, so a caller can
 * write `const created = await submit(...); if (!created) return;` and be sure
 * that no success path runs after a server rejection.
 *
 * Concurrent calls are refused rather than queued: the guard is a ref, so a
 * second click during the round trip is dropped even though React has not
 * re-rendered the disabled button yet.
 */
export function useSubmit() {
  const [state, setState] = useState<SubmitState>({
    saving: false,
    error: null,
    fieldErrors: {},
  });
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setState({ saving: false, error: null, fieldErrors: {} });
  }, []);

  const submit = useCallback(
    async <T,>(
      url: string,
      options: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown },
    ): Promise<T | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setState({ saving: true, error: null, fieldErrors: {} });

      try {
        const response = await fetch(url, {
          method: options.method,
          headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        if (response.status === 204) {
          setState({ saving: false, error: null, fieldErrors: {} });
          return {} as T;
        }

        const body = (await response.json().catch(() => ({}))) as ApiError & Record<string, unknown>;

        if (!response.ok) {
          // The server's message is the honest one — it knows about module
          // switches, permissions and stock levels that the browser does not.
          setState({
            saving: false,
            error: body.error ?? 'The change could not be saved.',
            fieldErrors: body.fields ?? {},
          });
          return null;
        }

        setState({ saving: false, error: null, fieldErrors: {} });
        return body as T;
      } catch {
        // A network failure is not a validation failure, and must never be
        // reported as success.
        setState({
          saving: false,
          error: 'The request could not be sent. Check your connection and try again.',
          fieldErrors: {},
        });
        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [],
  );

  return { ...state, submit, reset };
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

const CONTROL =
  'tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2.5 text-base text-ink-900 disabled:bg-ink-50 disabled:text-ink-500';

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className = '',
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-700">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </label>
      <div className="mt-1">{children}</div>
      {hint && !error && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  invalid,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** React 19 passes ref as an ordinary prop; no forwardRef needed. */
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={`${CONTROL} ${invalid ? 'border-red-400' : ''} ${props.className ?? ''}`}
    />
  );
}

export function TextArea({
  invalid,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...props}
      aria-invalid={invalid || undefined}
      className={`${CONTROL} min-h-[5rem] ${invalid ? 'border-red-400' : ''} ${props.className ?? ''}`}
    />
  );
}

export function Select({
  invalid,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...props}
      aria-invalid={invalid || undefined}
      className={`${CONTROL} ${invalid ? 'border-red-400' : ''} ${props.className ?? ''}`}
    >
      {children}
    </select>
  );
}

/** A labelled checkbox with a touch-sized hit area. */
export function CheckboxRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 py-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 rounded border-ink-300"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-800">{label}</span>
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

/** The server's rejection. Rendered in place of, never alongside, a success. */
export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm font-medium text-red-800">
      {message}
    </p>
  );
}

export function SuccessBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="mt-4 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-800">
      {message}
    </p>
  );
}

/**
 * Submit button.
 *
 * `disabled` while saving is the visible half of double-submit protection; the
 * ref guard inside `useSubmit` is the half that actually works when a user
 * double-taps faster than React re-renders.
 */
export function SubmitButton({
  saving,
  children,
  savingLabel,
  disabled,
  tone = 'primary',
  onClick,
  type = 'submit',
}: {
  saving: boolean;
  children: React.ReactNode;
  savingLabel: string;
  disabled?: boolean;
  tone?: 'primary' | 'danger';
  onClick?: () => void;
  type?: 'submit' | 'button';
}) {
  const palette =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-700'
      : 'bg-brand-600 hover:bg-brand-700';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={saving || disabled}
      aria-busy={saving || undefined}
      className={`tap-target rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 ${palette}`}
    >
      {saving ? savingLabel : children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'submit' | 'button';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="tap-target rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/**
 * A disclosure that holds a form.
 *
 * Operations screens are read-first: the list is the point, and the form is
 * something you open when you have a job to do. Keeping it closed by default
 * also keeps the mobile view short.
 */
export function Disclosure({
  open,
  onToggle,
  openLabel,
  closeLabel,
  children,
}: {
  open: boolean;
  onToggle: (next: boolean) => void;
  openLabel: string;
  closeLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="tap-target rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
      >
        {open ? closeLabel : openLabel}
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

/**
 * Two-step confirmation for an action that changes an important record.
 *
 * Not `window.confirm`: that is unstyled, untranslatable and blocked in some
 * embedded browsers. This renders the consequence in the page, in the user's
 * language.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  question,
  cancelLabel,
  onConfirm,
  saving,
  savingLabel,
  tone = 'danger',
}: {
  label: string;
  confirmLabel: string;
  question: string;
  cancelLabel: string;
  onConfirm: () => void;
  saving: boolean;
  savingLabel: string;
  tone?: 'primary' | 'danger';
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className={`tap-target rounded-lg border px-3 py-2 text-sm font-medium transition ${
          tone === 'danger'
            ? 'border-red-300 text-red-700 hover:bg-red-50'
            : 'border-ink-300 text-ink-700 hover:bg-ink-50'
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-3">
      <p className="text-xs font-medium text-red-900">{question}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <SubmitButton
          type="button"
          tone={tone}
          saving={saving}
          savingLabel={savingLabel}
          onClick={onConfirm}
        >
          {confirmLabel}
        </SubmitButton>
        <SecondaryButton onClick={() => setArmed(false)} disabled={saving}>
          {cancelLabel}
        </SecondaryButton>
      </div>
    </div>
  );
}
