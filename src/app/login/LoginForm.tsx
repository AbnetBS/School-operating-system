'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

type School = { code: string; name: string; nameAm: string | null };

export default function LoginForm({ schools }: { schools: School[] }) {
  const router = useRouter();
  const [schoolCode, setSchoolCode] = useState(schools[0]?.code ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Remember the last school on this device — most users belong to one.
    const saved = window.localStorage.getItem('sos.schoolCode');
    if (saved && schools.some((s) => s.code === saved)) setSchoolCode(saved);
  }, [schools]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFields({});
    setSubmitting(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolCode, username, password }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? 'Sign-in failed. Please try again.');
        setFields(data.fields ?? {});
        setSubmitting(false);
        return;
      }

      window.localStorage.setItem('sos.schoolCode', schoolCode);
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Cannot reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-ink-50 px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-2xl font-bold text-white shadow-lg shadow-brand-600/20">
            ት
          </div>
          <h1 className="text-2xl font-bold text-ink-900">School Operating System</h1>
          <p className="mt-1 text-sm text-ink-500">Sign in to your school account</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="card space-y-5 p-6 shadow-sm"
          noValidate
        >
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {error}
            </div>
          )}

          <div>
            <label htmlFor="school" className="mb-1.5 block text-sm font-medium text-ink-700">
              School
            </label>
            <select
              id="school"
              value={schoolCode}
              onChange={(e) => setSchoolCode(e.target.value)}
              className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2.5 text-base text-ink-900 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              required
            >
              {schools.length === 0 && <option value="">No schools available</option>}
              {schools.map((school) => (
                <option key={school.code} value={school.code}>
                  {school.name}
                </option>
              ))}
            </select>
            {fields.schoolCode && (
              <p className="mt-1 text-xs text-red-600">{fields.schoolCode}</p>
            )}
          </div>

          <div>
            <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-ink-700">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="tap-target w-full rounded-lg border border-ink-300 px-3 py-2.5 text-base text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="e.g. teacher1"
              required
            />
            {fields.username && <p className="mt-1 text-xs text-red-600">{fields.username}</p>}
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink-700">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="tap-target w-full rounded-lg border border-ink-300 px-3 py-2.5 pr-20 text-base text-ink-900 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 px-3 text-sm font-medium text-ink-500 hover:text-ink-700"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            {fields.password && <p className="mt-1 text-xs text-red-600">{fields.password}</p>}
          </div>

          <button
            type="submit"
            disabled={submitting || schools.length === 0}
            className="tap-target w-full rounded-lg bg-brand-600 px-4 py-3 text-base font-semibold text-white transition hover:bg-brand-700 focus:ring-2 focus:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <DemoAccounts />
      </div>
    </div>
  );
}

/**
 * Shown only in development, so the demo data is discoverable without hunting
 * through the seed script. This block does not render in production.
 */
function DemoAccounts() {
  if (process.env.NODE_ENV === 'production') return null;
  return (
    <details className="card mt-4 p-4 text-sm">
      <summary className="cursor-pointer font-medium text-ink-700">Demo accounts</summary>
      <div className="mt-3 space-y-3 text-ink-600">
        <p>
          Password for all demo accounts: <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs">Demo@2018</code>
        </p>
        <div>
          <p className="font-medium text-ink-800">Bright Future Academy — 3 terms, ranking on</p>
          <p className="text-xs">admin · principal · registrar · finance · teacher1…teacher12 · parent · student</p>
        </div>
        <div>
          <p className="font-medium text-ink-800">Addis Preparatory School — 2 semesters, GPA, Amharic</p>
          <p className="text-xs">admin · principal · coordinator · teacher1…teacher14</p>
        </div>
        <p className="text-xs text-ink-500">
          Both schools use the username “admin” — usernames are unique per school, not globally.
        </p>
      </div>
    </details>
  );
}
