'use client';

/**
 * Report a fault.
 *
 * This is the one operations form an ordinary teacher will ever use, so it is
 * deliberately the shortest: a sentence about what is wrong, roughly where,
 * and how urgent. Everything else is optional.
 *
 * `maintenance.report` is a separate permission from `maintenance.manage` on
 * purpose — a teacher may say the projector is broken without being able to
 * close the ticket. Both are enforced in `reportIssue`/`updateIssue`.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  Disclosure,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type AssetOption = { id: string; name: string; assetTag: string | null };

export default function FaultReporter({
  labels,
  priorities,
  assets,
  today,
}: {
  labels: Labels;
  priorities: string[];
  assets: AssetOption[];
  today: string;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();
  const { saving, error, fieldErrors, submit } = useSubmit();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [assetId, setAssetId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [success, setSuccess] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);

    const result = await submit('/api/maintenance', {
      method: 'POST',
      body: {
        title: title.trim(),
        description: description.trim() || null,
        assetId: assetId || null,
        location: location.trim() || null,
        priority,
        reportedOn: today,
      },
    });
    if (!result) return;

    setSuccess(t('maintenance.reported'));
    setTitle('');
    setDescription('');
    setLocation('');
    setAssetId('');
    setPriority('normal');
    router.refresh();
  }

  return (
    <Card>
      <Disclosure
        open={open}
        onToggle={setOpen}
        openLabel={t('maintenance.report')}
        closeLabel={t('action.cancel')}
      >
        <form onSubmit={save} className="space-y-4">
          <p className="text-sm text-ink-600">{t('maintenance.reportHelp')}</p>

          <Field label={t('maintenance.issue')} error={fieldErrors.title} required>
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              autoFocus
              invalid={Boolean(fieldErrors.title)}
            />
          </Field>

          <Field label={t('maintenance.description')} error={fieldErrors.description}>
            <TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('inventory.location')} error={fieldErrors.location}>
              <TextInput
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={200}
              />
            </Field>

            <Field label={t('maintenance.priority')} error={fieldErrors.priority}>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {t(`maintenance.priority.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>

            {/* Most real reports are about something untagged — a door, a tap.
                So the asset link is optional and defaults to none. */}
            {assets.length > 0 && (
              <Field
                label={t('maintenance.relatedAsset')}
                error={fieldErrors.assetId}
                className="sm:col-span-2"
              >
                <Select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">{t('maintenance.noAsset')}</option>
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                      {asset.assetTag ? ` (${asset.assetTag})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          <ErrorBanner message={error} />
          {!error && <SuccessBanner message={success} />}

          <SubmitButton
            saving={saving}
            savingLabel={labels['ops.saving'] ?? '…'}
            disabled={title.trim().length === 0}
          >
            {t('maintenance.report')}
          </SubmitButton>
        </form>
      </Disclosure>
    </Card>
  );
}
