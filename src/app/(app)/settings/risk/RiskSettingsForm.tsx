'use client';

import { useState } from 'react';
import {
  useSubmit,
  Field,
  TextInput,
  CheckboxRow,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
} from '../../../../components/form.tsx';

type Settings = {
  enabled: boolean;
  attendanceEnabled: boolean;
  attendanceThresholdPercent: number;
  attendanceWeight: number;
  consecutiveAbsenceEnabled: boolean;
  consecutiveAbsenceDays: number;
  consecutiveAbsenceWeight: number;
  academicEnabled: boolean;
  academicThresholdPercent: number;
  academicWeight: number;
  declineEnabled: boolean;
  declinePoints: number;
  declineWeight: number;
  financeEnabled: boolean;
  financeWeight: number;
  attentionScore: number;
};

/**
 * Early-warning configuration.
 *
 * The running total is shown live because the single most confusing way to
 * misconfigure this is to set an attention score no combination of signals can
 * reach — the list then stays empty and the school concludes, wrongly, that
 * no child needs help. The server rejects that too; this just makes it
 * visible before saving.
 */
export default function RiskSettingsForm({
  initial,
  labels,
}: {
  initial: Settings;
  labels: Record<string, string>;
}) {
  const [settings, setSettings] = useState<Settings>(initial);
  const [saved, setSaved] = useState<string | null>(null);
  const { submit, saving, error, fieldErrors } = useSubmit();

  const label = (key: string) => labels[key] ?? key;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSaved(null);
  };

  const maxReachable =
    (settings.attendanceEnabled ? settings.attendanceWeight : 0) +
    (settings.consecutiveAbsenceEnabled ? settings.consecutiveAbsenceWeight : 0) +
    (settings.academicEnabled ? settings.academicWeight : 0) +
    (settings.declineEnabled ? settings.declineWeight : 0) +
    (settings.financeEnabled ? settings.financeWeight : 0);

  const unreachable = settings.enabled && maxReachable < settings.attentionScore;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(null);
    const result = await submit<{ settings: Settings }>('/api/settings/risk', {
      method: 'PATCH',
      body: settings,
    });
    if (result) {
      setSettings(result.settings);
      setSaved(label('settings.saved'));
    }
  };

  const number = (
    key: keyof Settings,
    labelKey: string,
    options: { min: number; max: number; suffix?: string },
  ) => (
    <Field label={label(labelKey)} error={fieldErrors[key as string]}>
      <div className="flex items-center gap-2">
        <TextInput
          type="number"
          inputMode="numeric"
          min={options.min}
          max={options.max}
          value={String(settings[key] as number)}
          onChange={(event) => set(key, Number(event.target.value) as never)}
          invalid={Boolean(fieldErrors[key as string])}
          className="max-w-[7rem]"
        />
        {options.suffix && <span className="text-sm text-ink-500">{options.suffix}</span>}
      </div>
    </Field>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <ErrorBanner message={error} />
      <SuccessBanner message={saved} />

      <CheckboxRow
        id="risk-enabled"
        label={label('risk.settings.enabled')}
        hint={label('risk.settings.enabledHint')}
        checked={settings.enabled}
        onChange={(checked) => set('enabled', checked)}
      />

      <fieldset disabled={!settings.enabled} className="space-y-6 disabled:opacity-50">
        <section className="space-y-3">
          <CheckboxRow
            id="risk-attendance"
            label={label('analytics.attendance')}
            checked={settings.attendanceEnabled}
            onChange={(checked) => set('attendanceEnabled', checked)}
          />
          {settings.attendanceEnabled && (
            <div className="grid gap-3 pl-2 sm:grid-cols-2">
              {number('attendanceThresholdPercent', 'risk.settings.attendanceThreshold', {
                min: 0,
                max: 100,
                suffix: '%',
              })}
              {number('attendanceWeight', 'risk.settings.weight', { min: 0, max: 100 })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <CheckboxRow
            id="risk-consecutive"
            label={label('risk.settings.consecutive')}
            checked={settings.consecutiveAbsenceEnabled}
            onChange={(checked) => set('consecutiveAbsenceEnabled', checked)}
          />
          {settings.consecutiveAbsenceEnabled && (
            <div className="grid gap-3 pl-2 sm:grid-cols-2">
              {number('consecutiveAbsenceDays', 'risk.settings.consecutiveDays', {
                min: 1,
                max: 60,
              })}
              {number('consecutiveAbsenceWeight', 'risk.settings.weight', { min: 0, max: 100 })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <CheckboxRow
            id="risk-academic"
            label={label('analytics.academic')}
            checked={settings.academicEnabled}
            onChange={(checked) => set('academicEnabled', checked)}
          />
          {settings.academicEnabled && (
            <div className="grid gap-3 pl-2 sm:grid-cols-2">
              {number('academicThresholdPercent', 'risk.settings.academicThreshold', {
                min: 0,
                max: 100,
                suffix: '%',
              })}
              {number('academicWeight', 'risk.settings.weight', { min: 0, max: 100 })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <CheckboxRow
            id="risk-decline"
            label={label('risk.settings.decline')}
            checked={settings.declineEnabled}
            onChange={(checked) => set('declineEnabled', checked)}
          />
          {settings.declineEnabled && (
            <div className="grid gap-3 pl-2 sm:grid-cols-2">
              {number('declinePoints', 'risk.settings.declinePoints', { min: 1, max: 100 })}
              {number('declineWeight', 'risk.settings.weight', { min: 0, max: 100 })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <CheckboxRow
            id="risk-finance"
            label={label('risk.settings.finance')}
            hint={label('risk.settings.financeHint')}
            checked={settings.financeEnabled}
            onChange={(checked) => set('financeEnabled', checked)}
          />
          {settings.financeEnabled && (
            <div className="grid gap-3 pl-2 sm:grid-cols-2">
              {number('financeWeight', 'risk.settings.weight', { min: 0, max: 100 })}
            </div>
          )}
        </section>

        <section className="space-y-3 border-t border-ink-200 pt-4">
          {number('attentionScore', 'risk.settings.attentionScore', { min: 1, max: 200 })}
          <p className={`text-xs ${unreachable ? 'font-medium text-red-700' : 'text-ink-500'}`}>
            {label('risk.settings.maxReachable').replace('{max}', String(maxReachable))}
          </p>
        </section>
      </fieldset>

      <SubmitButton saving={saving} savingLabel={label('action.saving')} disabled={unreachable}>
        {label('action.save')}
      </SubmitButton>
    </form>
  );
}
