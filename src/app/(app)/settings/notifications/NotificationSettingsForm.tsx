'use client';

import { useState } from 'react';
import { Card, Badge, ActionAlert } from '../../../../components/ui.tsx';

/**
 * Mirrors `SmsAvailability` from src/lib/sms/provider.ts, reduced to what can
 * cross the server/client boundary — the real type carries the provider
 * object, which is not serialisable.
 */
type Availability =
  | { available: true; providerLabel: string }
  | { available: false; reason: 'no-provider' | 'disabled' | 'not-implemented'; detail: string };

type Settings = {
  channels: { inApp: boolean; sms: boolean; email: boolean; push: boolean };
  events: Record<string, boolean>;
  quietHoursStart: string;
  quietHoursEnd: string;
  sms: {
    provider: string;
    senderId: string;
    apiKeyRef: string;
    endpoint: string;
    isEnabled: boolean;
  };
};

const EVENT_LABELS: { key: string; label: string; hint: string }[] = [
  { key: 'attendanceAbsent', label: 'Absence', hint: "Tell guardians the day their child is marked absent." },
  { key: 'attendanceRisk', label: 'Attendance risk', hint: 'When attendance falls below the school threshold.' },
  { key: 'gradePublished', label: 'Marks published', hint: 'When results are released to the portal.' },
  { key: 'reportCardPublished', label: 'Report card published', hint: 'When a report card becomes visible.' },
  { key: 'paymentRecorded', label: 'Payment received', hint: 'Receipt confirmation. Available once fees are in use.' },
  { key: 'feeDue', label: 'Fee due', hint: 'Reminder before a due date. Available once fees are in use.' },
  { key: 'homeworkAssigned', label: 'Homework set', hint: 'Available once homework is in use.' },
  { key: 'announcement', label: 'Announcements', hint: 'When a notice is published to an audience.' },
];

// Events whose source module is not built yet. The setting is still stored, so
// a school can decide now, but we must not imply it does something today.
const PENDING = new Set(['paymentRecorded', 'feeDue', 'homeworkAssigned']);

export default function NotificationSettingsForm({
  initial,
  canConfigureSms,
  providers,
  availability,
}: {
  initial: Settings;
  canConfigureSms: boolean;
  providers: { key: string; label: string }[];
  availability: Availability;
}) {
  const [settings, setSettings] = useState<Settings>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  function setEvent(key: string, value: boolean) {
    setSettings((s) => ({ ...s, events: { ...s.events, [key]: value } }));
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    setError(null);
    setFields({});

    const payload: Record<string, unknown> = {
      channels: settings.channels,
      events: settings.events,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
    };
    // Only send the SMS block when this user is allowed to change it —
    // the server rejects it otherwise, and we should not provoke a 403.
    if (canConfigureSms) payload.sms = settings.sms;

    const response = await fetch('/api/settings/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      setError(body.error ?? 'Could not save the settings.');
      setFields(body.fields ?? {});
      setStatus('idle');
      return;
    }

    setStatus('saved');
  }

  return (
    <div className="space-y-4">
      {error && <ActionAlert tone="bad" title={error} />}

      <Card title="Delivery channels">
        <p className="mb-3 text-sm text-ink-500">
          In-app notifications always appear in the portal. Other channels need to be
          connected before they do anything.
        </p>
        <div className="space-y-2">
          <Toggle
            label="In-app"
            checked={settings.channels.inApp}
            onChange={(v) => {
              setSettings((s) => ({ ...s, channels: { ...s.channels, inApp: v } }));
              setStatus('idle');
            }}
          />
          <Toggle
            label="SMS"
            checked={settings.channels.sms}
            disabled={!canConfigureSms}
            hint={
              availability.available
                ? `Connected via ${availability.providerLabel}`
                : availability.detail
            }
            onChange={(v) => {
              setSettings((s) => ({ ...s, channels: { ...s.channels, sms: v } }));
              setStatus('idle');
            }}
          />
          <Toggle label="Email" checked={false} disabled hint="Not built yet." onChange={() => {}} />
          <Toggle label="Push" checked={false} disabled hint="Not built yet." onChange={() => {}} />
        </div>
      </Card>

      <Card title="Which events notify people">
        <ul className="divide-y divide-ink-100">
          {EVENT_LABELS.map((event) => (
            <li key={event.key} className="py-2.5 first:pt-0 last:pb-0">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={settings.events[event.key] ?? false}
                  onChange={(e) => setEvent(event.key, e.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink-800">{event.label}</span>
                    {PENDING.has(event.key) && <Badge tone="neutral">Not active yet</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-500">{event.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Quiet hours">
        <p className="mb-3 text-sm text-ink-500">
          Automated messages are held outside these hours so families are not woken at night.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start" error={fields.quietHoursStart}>
            <input
              type="time"
              value={settings.quietHoursStart}
              onChange={(e) => {
                setSettings((s) => ({ ...s, quietHoursStart: e.target.value }));
                setStatus('idle');
              }}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="End" error={fields.quietHoursEnd}>
            <input
              type="time"
              value={settings.quietHoursEnd}
              onChange={(e) => {
                setSettings((s) => ({ ...s, quietHoursEnd: e.target.value }));
                setStatus('idle');
              }}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </Field>
        </div>
      </Card>

      {canConfigureSms && (
        <Card title="SMS provider">
          <SmsStatus availability={availability} />

          <div className="mt-3 space-y-3">
            <Field label="Provider">
              <select
                value={settings.sms.provider}
                onChange={(e) => {
                  setSettings((s) => ({ ...s, sms: { ...s.sms, provider: e.target.value } }));
                  setStatus('idle');
                }}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="none">None — do not send SMS</option>
                {providers.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
                {/* Preserve a provider key configured before its integration shipped. */}
                {settings.sms.provider !== 'none' &&
                  !providers.some((p) => p.key === settings.sms.provider) && (
                    <option value={settings.sms.provider}>
                      {settings.sms.provider} (not installed)
                    </option>
                  )}
              </select>
            </Field>

            <Field label="Sender ID" hint="The short name recipients see, e.g. the school's name.">
              <input
                value={settings.sms.senderId}
                maxLength={32}
                onChange={(e) => {
                  setSettings((s) => ({ ...s, sms: { ...s.sms, senderId: e.target.value } }));
                  setStatus('idle');
                }}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              />
            </Field>

            <Field
              label="API key reference"
              hint="The name of the environment variable holding the key. The key itself is never stored in the database."
            >
              <input
                value={settings.sms.apiKeyRef}
                maxLength={120}
                placeholder="SMS_API_KEY"
                onChange={(e) => {
                  setSettings((s) => ({ ...s, sms: { ...s.sms, apiKeyRef: e.target.value } }));
                  setStatus('idle');
                }}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 font-mono text-sm"
              />
            </Field>

            <Field label="Endpoint" hint="Leave blank to use the provider's default.">
              <input
                value={settings.sms.endpoint}
                maxLength={300}
                onChange={(e) => {
                  setSettings((s) => ({ ...s, sms: { ...s.sms, endpoint: e.target.value } }));
                  setStatus('idle');
                }}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              />
            </Field>

            <Toggle
              label="Send SMS"
              checked={settings.sms.isEnabled}
              hint="Turn off to hold all outgoing SMS without losing the configuration."
              onChange={(v) => {
                setSettings((s) => ({ ...s, sms: { ...s.sms, isEnabled: v } }));
                setStatus('idle');
              }}
            />
          </div>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={status === 'saving'}
          className="tap-target w-full rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 sm:w-auto"
        >
          {status === 'saving' ? 'Saving…' : 'Save settings'}
        </button>
        {status === 'saved' && <span className="text-sm text-green-700">Saved.</span>}
      </div>
    </div>
  );
}

function SmsStatus({ availability }: { availability: Availability }) {
  // Say exactly what will happen. A school must never believe SMS is going out
  // when it is not, so the negative cases are spelled out rather than reduced
  // to a single "not configured".
  const state = availability.available
    ? { tone: 'good' as const, label: 'Connected', text: `Messages will be sent via ${availability.providerLabel}.` }
    : availability.reason === 'disabled'
      ? { tone: 'neutral' as const, label: 'Switched off', text: availability.detail }
      : availability.reason === 'not-implemented'
        ? { tone: 'bad' as const, label: 'Not installed', text: availability.detail }
        : { tone: 'warn' as const, label: 'No provider', text: availability.detail };

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg bg-ink-50 px-3 py-2">
      <Badge tone={state.tone}>{state.label}</Badge>
      <p className="min-w-0 flex-1 text-sm text-ink-600">{state.text}</p>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium text-ink-800">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink-700">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
