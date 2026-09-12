'use client';

/**
 * Calendar events.
 *
 * The audience control matters more than it looks. An event addressed to
 * "everyone" is seen by all staff; addressed to sections or grades it reaches
 * exactly those families through the portal, and the filtering happens in SQL
 * in `listPortalEvents`, not here. The options offered are the roles, sections
 * and grades of THIS school, passed in from the server — there is no way to
 * type an id belonging to another one.
 *
 * "Visible in the portal" is separate from the audience and defaults to the
 * server's own default, because an internal staff meeting and a parents'
 * evening are both events and only one of them is anyone else's business.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  CheckboxRow,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  SecondaryButton,
  ConfirmButton,
  Disclosure,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;
type Option = { id: string; name: string };

type Audience =
  | { kind: 'all' }
  | { kind: 'roles'; roles: string[] }
  | { kind: 'sections'; sectionIds: string[] }
  | { kind: 'grades'; gradeIds: string[] };

type SchoolEvent = {
  id: string;
  title: string;
  description: string | null;
  eventType: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  location: string | null;
  audience: Audience;
  visibleToPortal: boolean;
};

type Draft = {
  title: string;
  description: string;
  eventType: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  location: string;
  audienceKind: Audience['kind'];
  roles: string[];
  sectionIds: string[];
  gradeIds: string[];
  visibleToPortal: boolean;
};

function draftFrom(event: SchoolEvent): Draft {
  const audience = event.audience ?? { kind: 'all' };
  return {
    title: event.title,
    description: event.description ?? '',
    eventType: event.eventType,
    startDate: event.startDate,
    endDate: event.endDate ?? '',
    startTime: event.startTime ?? '',
    endTime: event.endTime ?? '',
    allDay: event.allDay,
    location: event.location ?? '',
    audienceKind: audience.kind,
    roles: audience.kind === 'roles' ? audience.roles : [],
    sectionIds: audience.kind === 'sections' ? audience.sectionIds : [],
    gradeIds: audience.kind === 'grades' ? audience.gradeIds : [],
    visibleToPortal: event.visibleToPortal,
  };
}

function emptyDraft(today: string, portalDefault: boolean): Draft {
  return {
    title: '',
    description: '',
    eventType: 'activity',
    startDate: today,
    endDate: '',
    startTime: '',
    endTime: '',
    allDay: true,
    location: '',
    audienceKind: 'all',
    roles: [],
    sectionIds: [],
    gradeIds: [],
    visibleToPortal: portalDefault,
  };
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export default function EventManager({
  labels,
  events,
  eventTypes,
  roles,
  sections,
  grades,
  today,
  canManage,
  showPast,
}: {
  labels: Labels;
  events: SchoolEvent[];
  eventTypes: string[];
  roles: Option[];
  sections: Option[];
  grades: Option[];
  today: string;
  canManage: boolean;
  showPast: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Card title={showPast ? t('calendar.past') : t('calendar.upcoming')}>
      {canManage && !showPast && (
        <Disclosure
          open={creating}
          onToggle={(next) => {
            setCreating(next);
            setEditingId(null);
          }}
          openLabel={t('calendar.newEvent')}
          closeLabel={t('action.cancel')}
        >
          <EventForm
            labels={labels}
            t={t}
            initial={emptyDraft(today, true)}
            eventTypes={eventTypes}
            roles={roles}
            sections={sections}
            grades={grades}
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </Disclosure>
      )}

      {events.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={showPast ? t('calendar.noPast') : t('calendar.noEvents')} />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {events.map((event) => (
            <li key={event.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">{event.title}</p>
                  <p className="text-sm text-ink-600">
                    {event.startDate}
                    {event.endDate && event.endDate !== event.startDate && ` — ${event.endDate}`}
                    {!event.allDay && event.startTime && ` · ${event.startTime}`}
                  </p>
                  {event.location && <p className="text-xs text-ink-500">{event.location}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{t(`calendar.eventType.${event.eventType}`)}</Badge>
                  {event.visibleToPortal ? (
                    <Badge tone="good">{t('calendar.showInPortal')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('calendar.internalOnly')}</Badge>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === event.id ? null : event.id)}
                      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                    >
                      {t('action.edit')}
                    </button>
                  )}
                </div>
              </div>

              {canManage && editingId === event.id && (
                <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                  <EventForm
                    labels={labels}
                    t={t}
                    eventId={event.id}
                    initial={draftFrom(event)}
                    eventTypes={eventTypes}
                    roles={roles}
                    sections={sections}
                    grades={grades}
                    onDone={() => {
                      setEditingId(null);
                      router.refresh();
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EventForm({
  labels,
  t,
  initial,
  eventId,
  eventTypes,
  roles,
  sections,
  grades,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  initial: Draft;
  eventId?: string;
  eventTypes: string[];
  roles: Option[];
  sections: Option[];
  grades: Option[];
  onDone: () => void;
}) {
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();
  const [draft, setDraft] = useState<Draft>(initial);
  const [success, setSuccess] = useState<string | null>(null);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function toggle(key: 'roles' | 'sectionIds' | 'gradeIds', id: string) {
    setDraft((prev) => {
      const list = prev[key];
      return {
        ...prev,
        [key]: list.includes(id) ? list.filter((v) => v !== id) : [...list, id],
      };
    });
  }

  function buildAudience(): Audience {
    switch (draft.audienceKind) {
      case 'roles':
        return { kind: 'roles', roles: draft.roles };
      case 'sections':
        return { kind: 'sections', sectionIds: draft.sectionIds };
      case 'grades':
        return { kind: 'grades', gradeIds: draft.gradeIds };
      default:
        return { kind: 'all' };
    }
  }

  // The audience schema demands at least one selection for a targeted event.
  const audienceIncomplete =
    (draft.audienceKind === 'roles' && draft.roles.length === 0) ||
    (draft.audienceKind === 'sections' && draft.sectionIds.length === 0) ||
    (draft.audienceKind === 'grades' && draft.gradeIds.length === 0);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);

    const body = {
      title: draft.title.trim(),
      description: orNull(draft.description),
      eventType: draft.eventType,
      startDate: draft.startDate,
      endDate: draft.endDate || null,
      // An all-day event has no times; sending them anyway would be stored and
      // then ignored, which is worse than not sending them.
      startTime: draft.allDay ? null : draft.startTime || null,
      endTime: draft.allDay ? null : draft.endTime || null,
      allDay: draft.allDay,
      location: orNull(draft.location),
      audience: buildAudience(),
      visibleToPortal: draft.visibleToPortal,
      colour: null,
      termId: null,
    };

    const result = eventId
      ? await submit(`/api/events/${eventId}`, { method: 'PATCH', body })
      : await submit('/api/events', { method: 'POST', body });

    if (!result) return;
    setSuccess(t('calendar.eventSaved'));
    onDone();
  }

  async function remove() {
    if (!eventId) return;
    const result = await submit(`/api/events/${eventId}`, { method: 'DELETE' });
    if (!result) return;
    router.refresh();
    onDone();
  }

  const AUDIENCE_KINDS: Audience['kind'][] = ['all', 'roles', 'sections', 'grades'];

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('calendar.event')}
          error={fieldErrors.title}
          required
          className="sm:col-span-2"
        >
          <TextInput
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            required
            maxLength={200}
            invalid={Boolean(fieldErrors.title)}
          />
        </Field>

        <Field label={t('calendar.eventTypeLabel')} error={fieldErrors.eventType}>
          <Select value={draft.eventType} onChange={(e) => set('eventType', e.target.value)}>
            {eventTypes.map((type) => (
              <option key={type} value={type}>
                {t(`calendar.eventType.${type}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('calendar.location')} error={fieldErrors.location}>
          <TextInput
            value={draft.location}
            onChange={(e) => set('location', e.target.value)}
            maxLength={200}
          />
        </Field>

        <Field label={t('calendar.startDate')} error={fieldErrors.startDate} required>
          <TextInput
            type="date"
            value={draft.startDate}
            onChange={(e) => set('startDate', e.target.value)}
            required
            invalid={Boolean(fieldErrors.startDate)}
          />
        </Field>

        <Field label={t('calendar.endDate')} error={fieldErrors.endDate}>
          <TextInput
            type="date"
            value={draft.endDate}
            min={draft.startDate}
            onChange={(e) => set('endDate', e.target.value)}
            invalid={Boolean(fieldErrors.endDate)}
          />
        </Field>

        {!draft.allDay && (
          <>
            <Field label={t('calendar.startTime')} error={fieldErrors.startTime} required>
              <TextInput
                type="time"
                value={draft.startTime}
                onChange={(e) => set('startTime', e.target.value)}
                required
                invalid={Boolean(fieldErrors.startTime)}
              />
            </Field>
            <Field label={t('calendar.endTime')} error={fieldErrors.endTime}>
              <TextInput
                type="time"
                value={draft.endTime}
                onChange={(e) => set('endTime', e.target.value)}
                invalid={Boolean(fieldErrors.endTime)}
              />
            </Field>
          </>
        )}

        <Field
          label={t('calendar.description')}
          error={fieldErrors.description}
          className="sm:col-span-2"
        >
          <TextArea
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={2000}
          />
        </Field>
      </div>

      <CheckboxRow
        id={`allDay-${eventId ?? 'new'}`}
        label={t('calendar.allDay')}
        checked={draft.allDay}
        onChange={(next) => set('allDay', next)}
      />

      {/* --- audience -------------------------------------------------------- */}
      <fieldset>
        <legend className="text-sm font-medium text-ink-700">{t('calendar.audience')}</legend>
        <p className="mt-0.5 text-xs text-ink-500">{t('calendar.audienceHelp')}</p>

        <div className="mt-2 flex flex-wrap gap-2">
          {AUDIENCE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => set('audienceKind', kind)}
              aria-pressed={draft.audienceKind === kind}
              className={`tap-target rounded-lg border px-3 py-2 text-sm font-medium transition ${
                draft.audienceKind === kind
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
              }`}
            >
              {t(`calendar.audience.${kind}`)}
            </button>
          ))}
        </div>

        {draft.audienceKind === 'roles' && (
          <ChoiceList
            title={t('calendar.chooseRoles')}
            options={roles}
            selected={draft.roles}
            onToggle={(id) => toggle('roles', id)}
          />
        )}
        {draft.audienceKind === 'sections' && (
          <ChoiceList
            title={t('calendar.chooseSections')}
            options={sections}
            selected={draft.sectionIds}
            onToggle={(id) => toggle('sectionIds', id)}
          />
        )}
        {draft.audienceKind === 'grades' && (
          <ChoiceList
            title={t('calendar.chooseGrades')}
            options={grades}
            selected={draft.gradeIds}
            onToggle={(id) => toggle('gradeIds', id)}
          />
        )}
        {fieldErrors.audience && (
          <p className="mt-1 text-xs text-red-700">{fieldErrors.audience}</p>
        )}
      </fieldset>

      <CheckboxRow
        id={`portal-${eventId ?? 'new'}`}
        label={t('calendar.showInPortal')}
        hint={t('calendar.portalHelp')}
        checked={draft.visibleToPortal}
        onChange={(next) => set('visibleToPortal', next)}
      />

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      <div className="flex flex-wrap items-start gap-2">
        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={draft.title.trim().length === 0 || audienceIncomplete}
        >
          {t('action.save')}
        </SubmitButton>
        {eventId && (
          <>
            <SecondaryButton onClick={onDone} disabled={saving}>
              {t('action.cancel')}
            </SecondaryButton>
            <ConfirmButton
              label={t('action.delete')}
              confirmLabel={t('action.delete')}
              question={t('calendar.confirmDelete')}
              cancelLabel={t('action.cancel')}
              onConfirm={() => void remove()}
              saving={saving}
              savingLabel={labels['ops.saving'] ?? '…'}
            />
          </>
        )}
      </div>
    </form>
  );
}

function ChoiceList({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: Option[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-ink-200 bg-white p-3">
      <p className="mb-2 text-xs font-medium text-ink-600">{title}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onToggle(option.id)}
              aria-pressed={active}
              className={`tap-target rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? 'border-brand-600 bg-brand-100 text-brand-800'
                  : 'border-ink-300 bg-white text-ink-600 hover:bg-ink-50'
              }`}
            >
              {option.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
