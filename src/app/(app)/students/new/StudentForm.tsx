'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

type Grade = { id: string; name: string; level: number };
type Section = { id: string; name: string; gradeName: string; level: number; gradeLevelId: string };

type FieldErrors = Record<string, string>;

/**
 * New student form.
 *
 * Only the genuinely required fields are marked required: a school registering
 * a student mid-year often does not yet have a birth certificate, a photo or a
 * guardian's email. The server applies the same Zod schema, so nothing here is
 * trusted.
 */
export default function StudentForm({
  grades,
  sections,
  defaultAdmissionDate,
  canSeeSensitive,
}: {
  grades: Grade[];
  sections: Section[];
  defaultAdmissionDate: string;
  canSeeSensitive: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [gradeLevelId, setGradeLevelId] = useState('');
  const [addGuardian, setAddGuardian] = useState(true);

  // Only offer sections belonging to the chosen grade.
  const availableSections = gradeLevelId
    ? sections.filter((s) => s.gradeLevelId === gradeLevelId)
    : [];

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
      grandfatherNameAm: value('grandfatherNameAm'),
      gender: value('gender') || null,
      dateOfBirth: value('dateOfBirth'),
      phone: value('phone'),
      email: value('email'),
      subCity: value('subCity'),
      woreda: value('woreda'),
      kebele: value('kebele'),
      address: value('address'),
      emergencyContactName: value('emergencyContactName'),
      emergencyContactPhone: value('emergencyContactPhone'),
      emergencyContactRelation: value('emergencyContactRelation'),
      previousSchool: value('previousSchool'),
      admissionDate: value('admissionDate'),
      gradeLevelId: value('gradeLevelId'),
      sectionId: value('sectionId'),
      status: 'active',
    };

    if (canSeeSensitive) {
      payload.medicalNotes = value('medicalNotes');
      payload.bloodGroup = value('bloodGroup');
    }

    const studentCode = value('studentCode');
    if (studentCode) payload.studentCode = studentCode;

    if (addGuardian && value('guardianGivenName')) {
      payload.guardian = {
        givenName: value('guardianGivenName'),
        fatherName: value('guardianFatherName'),
        phone: value('guardianPhone'),
        relationship: value('guardianRelationship') || 'father',
      };
    }

    try {
      const response = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setErrors(data.fields ?? {});
        setFormError(data.error ?? 'Could not save this student. Please try again.');
        setSubmitting(false);
        // Bring the first problem into view rather than leaving the user
        // staring at an unchanged form.
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      router.push(`/students/${data.student.id}`);
      router.refresh();
    } catch {
      setFormError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {formError}
        </div>
      )}

      <Section title="Student name" hint="Ethiopian naming: given name, father's name, grandfather's name.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field name="givenName" label="Given name" required error={errors.givenName} />
          <Field name="fatherName" label="Father's name" required error={errors.fatherName} />
          <Field name="grandfatherName" label="Grandfather's name" error={errors.grandfatherName} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field name="givenNameAm" label="ስም (Amharic)" lang="am" error={errors.givenNameAm} />
          <Field name="fatherNameAm" label="የአባት ስም" lang="am" error={errors.fatherNameAm} />
          <Field name="grandfatherNameAm" label="የአያት ስም" lang="am" error={errors.grandfatherNameAm} />
        </div>
      </Section>

      <Section title="Placement" hint="A student can be admitted at any point in the year.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="gradeLevelId" required>
              Grade level
            </Label>
            <select
              id="gradeLevelId"
              name="gradeLevelId"
              required
              value={gradeLevelId}
              onChange={(e) => setGradeLevelId(e.target.value)}
              className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base sm:text-sm"
            >
              <option value="">Select a grade…</option>
              {grades.map((grade) => (
                <option key={grade.id} value={grade.id}>
                  {grade.name}
                </option>
              ))}
            </select>
            <FieldError message={errors.gradeLevelId} />
          </div>

          <div>
            <Label htmlFor="sectionId">Section</Label>
            <select
              id="sectionId"
              name="sectionId"
              disabled={!gradeLevelId}
              className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base disabled:bg-ink-50 disabled:text-ink-400 sm:text-sm"
            >
              <option value="">
                {gradeLevelId ? 'Assign later' : 'Choose a grade first'}
              </option>
              {availableSections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.gradeName} {section.name}
                </option>
              ))}
            </select>
            <FieldError message={errors.sectionId} />
          </div>

          <Field
            name="studentCode"
            label="Student ID"
            hint="Leave blank to generate automatically."
            error={errors.studentCode}
          />
          <Field
            name="admissionDate"
            label="Admission date"
            type="date"
            defaultValue={defaultAdmissionDate}
            error={errors.admissionDate}
          />
        </div>
      </Section>

      <Section title="Personal details">
        <div className="grid gap-3 sm:grid-cols-2">
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
          <Field name="phone" label="Phone" type="tel" placeholder="09xxxxxxxx" error={errors.phone} />
          <Field name="email" label="Email" type="email" error={errors.email} />
          <Field name="subCity" label="Sub-city" error={errors.subCity} />
          <Field name="woreda" label="Woreda" error={errors.woreda} />
          <Field name="kebele" label="Kebele" error={errors.kebele} />
          <Field name="previousSchool" label="Previous school" error={errors.previousSchool} />
        </div>
      </Section>

      <Section
        title="Parent or guardian"
        hint="Needed for attendance alerts and report cards. You can add more later."
      >
        <label className="mb-3 flex items-center gap-2 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={addGuardian}
            onChange={(e) => setAddGuardian(e.target.checked)}
            className="h-4 w-4 rounded border-ink-300"
          />
          Add a guardian now
        </label>
        {addGuardian && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              name="guardianGivenName"
              label="Guardian's given name"
              error={errors['guardian.givenName']}
            />
            <Field name="guardianFatherName" label="Guardian's father's name" />
            <Field
              name="guardianPhone"
              label="Phone"
              type="tel"
              placeholder="09xxxxxxxx"
              error={errors['guardian.phone']}
            />
            <div>
              <Label htmlFor="guardianRelationship">Relationship</Label>
              <select
                id="guardianRelationship"
                name="guardianRelationship"
                defaultValue="father"
                className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-base sm:text-sm"
              >
                <option value="father">Father</option>
                <option value="mother">Mother</option>
                <option value="grandparent">Grandparent</option>
                <option value="uncle">Uncle</option>
                <option value="aunt">Aunt</option>
                <option value="sibling">Sibling</option>
                <option value="guardian">Other guardian</option>
              </select>
            </div>
          </div>
        )}
      </Section>

      <Section title="Emergency contact">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field name="emergencyContactName" label="Name" />
          <Field name="emergencyContactPhone" label="Phone" type="tel" error={errors.emergencyContactPhone} />
          <Field name="emergencyContactRelation" label="Relationship" />
        </div>
      </Section>

      {canSeeSensitive && (
        <Section title="Medical information" hint="Visible only to staff with permission.">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field name="bloodGroup" label="Blood group" placeholder="e.g. O+" />
            <div className="sm:col-span-2">
              <Label htmlFor="medicalNotes">Notes</Label>
              <textarea
                id="medicalNotes"
                name="medicalNotes"
                rows={2}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-base sm:text-sm"
                placeholder="Allergies, conditions, medication…"
              />
            </div>
          </div>
        </Section>
      )}

      <div className="sticky bottom-16 z-10 flex gap-2 border-t border-ink-200 bg-white/95 py-3 backdrop-blur lg:bottom-0">
        <button
          type="submit"
          disabled={submitting}
          className="tap-target flex-1 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 sm:flex-none sm:px-6"
        >
          {submitting ? 'Saving…' : 'Register student'}
        </button>
        <Link
          href="/students"
          className="tap-target rounded-lg border border-ink-300 px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
      {hint && <p className="mt-0.5 mb-3 text-xs text-ink-500">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Label({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-700">
      {children}
      {required && <span className="ml-0.5 text-red-600">*</span>}
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-red-600">{message}</p>;
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
  defaultValue,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  lang?: string;
  placeholder?: string;
  defaultValue?: string;
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
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        className={`tap-target w-full rounded-lg border px-3 py-2 text-base sm:text-sm ${
          error ? 'border-red-400 bg-red-50' : 'border-ink-300'
        }`}
      />
      {hint && !error && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
      <FieldError message={error} />
    </div>
  );
}
