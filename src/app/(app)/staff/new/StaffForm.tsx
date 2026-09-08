'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

type Role = { id: string; name: string; nameAm: string | null; description: string | null };

/**
 * New staff form.
 *
 * Creating a staff member also creates their login. The temporary password is
 * displayed once on success — it is never recoverable afterwards, only
 * resettable, so the screen makes clear it must be written down now.
 */
export default function StaffForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [result, setResult] = useState<{
    id: string;
    username: string;
    temporaryPassword: string | null;
    name: string;
  } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setFormError(null);

    const formData = new FormData(event.currentTarget);
    const value = (key: string) => String(formData.get(key) ?? '').trim();

    const payload: Record<string, unknown> = {
      givenName: value('givenName'),
      fatherName: value('fatherName'),
      grandfatherName: value('grandfatherName'),
      givenNameAm: value('givenNameAm'),
      fatherNameAm: value('fatherNameAm'),
      staffType: value('staffType') || 'teacher',
      jobTitle: value('jobTitle'),
      department: value('department'),
      gender: value('gender') || null,
      dateOfBirth: value('dateOfBirth'),
      phone: value('phone'),
      address: value('address'),
      qualification: value('qualification'),
      hireDate: value('hireDate'),
      employmentType: value('employmentType') || null,
      status: 'active',
      username: value('username'),
      email: value('email'),
      roleIds: selectedRoles,
    };

    const staffCode = value('staffCode');
    if (staffCode) payload.staffCode = staffCode;

    try {
      const response = await fetch('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setErrors(data.fields ?? {});
        setFormError(data.error ?? 'Could not save this staff member.');
        setSubmitting(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      setResult({
        id: data.id,
        username: data.username,
        temporaryPassword: data.temporaryPassword,
        name: `${payload.givenName} ${payload.fatherName}`,
      });
      setSubmitting(false);
    } catch {
      setFormError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  // Success screen: the one and only chance to see the password.
  if (result) {
    return (
      <div className="card p-5">
        <h2 className="text-lg font-semibold text-ink-900">{result.name} was added</h2>
        <p className="mt-1 text-sm text-ink-600">
          Give these sign-in details to them now. The password cannot be shown again — it can only
          be reset.
        </p>

        <dl className="mt-4 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-amber-800">Username</dt>
            <dd className="mt-0.5 font-mono text-lg font-semibold text-ink-900">
              {result.username}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-amber-800">
              Temporary password
            </dt>
            <dd className="mt-0.5 font-mono text-lg font-semibold text-ink-900">
              {result.temporaryPassword}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-ink-500">
          They will be asked to choose their own password the first time they sign in.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href={`/staff/${result.id}`}
            className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            View profile
          </Link>
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setSelectedRoles([]);
              router.refresh();
            }}
            className="tap-target rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
          >
            Add another
          </button>
          <Link
            href="/staff"
            className="tap-target rounded-lg px-4 py-2 text-sm font-semibold text-ink-600 hover:bg-ink-50"
          >
            Done
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {formError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formError}
        </div>
      )}

      <Section title="Name" hint="Ethiopian naming: given name, father's name, grandfather's name.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field name="givenName" label="Given name" required error={errors.givenName} />
          <Field name="fatherName" label="Father's name" required error={errors.fatherName} />
          <Field name="grandfatherName" label="Grandfather's name" />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field name="givenNameAm" label="ስም (Amharic)" lang="am" />
          <Field name="fatherNameAm" label="የአባት ስም" lang="am" />
        </div>
      </Section>

      <Section title="Position">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="staffType">Type</Label>
            <select
              id="staffType"
              name="staffType"
              defaultValue="teacher"
              className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base sm:text-sm"
            >
              <option value="teacher">Teacher</option>
              <option value="admin">Administration</option>
              <option value="finance">Finance</option>
              <option value="librarian">Librarian</option>
              <option value="counsellor">Counsellor</option>
              <option value="nurse">Nurse</option>
              <option value="driver">Driver</option>
              <option value="support">Support</option>
              <option value="other">Other</option>
            </select>
          </div>
          <Field name="jobTitle" label="Job title" placeholder="e.g. Mathematics Teacher" />
          <Field name="department" label="Department" />
          <div>
            <Label htmlFor="employmentType">Employment</Label>
            <select
              id="employmentType"
              name="employmentType"
              defaultValue=""
              className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base sm:text-sm"
            >
              <option value="">Not specified</option>
              <option value="permanent">Permanent</option>
              <option value="contract">Contract</option>
              <option value="part_time">Part time</option>
              <option value="volunteer">Volunteer</option>
            </select>
          </div>
          <Field
            name="staffCode"
            label="Staff ID"
            hint="Leave blank to generate automatically."
            error={errors.staffCode}
          />
          <Field name="hireDate" label="Hire date" type="date" error={errors.hireDate} />
          <Field name="qualification" label="Qualification" placeholder="e.g. BSc Mathematics" />
        </div>
      </Section>

      <Section title="Contact & personal">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field name="phone" label="Phone" type="tel" placeholder="09xxxxxxxx" error={errors.phone} />
          <Field name="email" label="Email" type="email" error={errors.email} />
          <div>
            <Label htmlFor="gender">Gender</Label>
            <select
              id="gender"
              name="gender"
              className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base sm:text-sm"
            >
              <option value="">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>
          <Field name="dateOfBirth" label="Date of birth" type="date" error={errors.dateOfBirth} />
          <div className="sm:col-span-2">
            <Field name="address" label="Address" />
          </div>
        </div>
      </Section>

      <Section
        title="Sign-in and permissions"
        hint="A temporary password is generated and shown once after saving."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="username"
            label="Username"
            hint="Leave blank to build one from their name."
            error={errors.username}
          />
        </div>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">
            Roles — what this person is allowed to do
          </legend>
          {roles.length === 0 ? (
            <p className="text-sm text-ink-500">No roles are defined yet.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {roles.map((role) => (
                <label
                  key={role.id}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${
                    selectedRoles.includes(role.id)
                      ? 'border-brand-400 bg-brand-50'
                      : 'border-ink-200 hover:bg-ink-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role.id)}
                    onChange={(e) =>
                      setSelectedRoles((prev) =>
                        e.target.checked ? [...prev, role.id] : prev.filter((r) => r !== role.id),
                      )
                    }
                    className="mt-0.5 h-4 w-4 rounded border-ink-300"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-900">{role.name}</span>
                    {role.description && (
                      <span className="block text-xs text-ink-500">{role.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
          {selectedRoles.length === 0 && (
            <p className="mt-2 text-xs text-amber-700">
              With no role, this person can sign in but will not be able to do anything.
            </p>
          )}
        </fieldset>
      </Section>

      <div className="sticky bottom-16 z-10 flex gap-2 border-t border-ink-200 bg-white/95 py-3 backdrop-blur lg:bottom-0">
        <button
          type="submit"
          disabled={submitting}
          className="tap-target flex-1 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 sm:flex-none sm:px-6"
        >
          {submitting ? 'Saving…' : 'Add staff member'}
        </button>
        <Link
          href="/staff"
          className="tap-target rounded-lg border border-ink-300 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
      {hint && <p className="mt-0.5 mb-3 text-xs text-ink-500">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Label({ htmlFor, required, children }: { htmlFor: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-700">
      {children}
      {required && <span className="ml-0.5 text-red-600">*</span>}
    </label>
  );
}

function Field({
  name,
  label,
  type = 'text',
  required,
  error,
  hint,
  lang,
  placeholder,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  lang?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <Label htmlFor={name} required={required}>
        {label}
      </Label>
      <input
        id={name}
        name={name}
        type={type}
        lang={lang}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`tap-target w-full rounded-lg border px-3 py-2 text-base sm:text-sm ${
          error ? 'border-red-400 bg-red-50' : 'border-ink-300'
        }`}
      />
      {hint && !error && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
