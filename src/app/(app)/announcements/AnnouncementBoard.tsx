'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';

type Announcement = {
  id: string;
  title: string;
  titleAm: string | null;
  body: string;
  bodyAm: string | null;
  audience: string;
  isPinned: boolean;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  authorName: string | null;
  isRead: boolean;
};

type Option = { id: string; name: string };

const AUDIENCE_LABELS: Record<string, string> = {
  everyone: 'Everyone',
  staff: 'Staff',
  parents: 'Parents',
  students: 'Students',
  section: 'Selected classes',
  grade: 'Selected grades',
};

export default function AnnouncementBoard({
  visible,
  manageable,
  canCreate,
  schoolWide,
  sectionOptions,
  gradeOptions,
  locale,
}: {
  visible: Announcement[];
  manageable: Announcement[];
  canCreate: boolean;
  schoolWide: boolean;
  sectionOptions: Option[];
  gradeOptions: Option[];
  locale: string;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [tab, setTab] = useState<'inbox' | 'manage'>('inbox');

  const list = tab === 'inbox' ? visible : manageable;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {canCreate ? (
          <div className="flex gap-1 rounded-lg bg-ink-100 p-1">
            <TabButton active={tab === 'inbox'} onClick={() => setTab('inbox')}>
              Received
            </TabButton>
            <TabButton active={tab === 'manage'} onClick={() => setTab('manage')}>
              Mine &amp; drafts
            </TabButton>
          </div>
        ) : (
          <span />
        )}

        {canCreate && (
          <button
            type="button"
            onClick={() => setComposing((c) => !c)}
            className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {composing ? 'Cancel' : 'New announcement'}
          </button>
        )}
      </div>

      {composing && (
        <ComposeForm
          schoolWide={schoolWide}
          sectionOptions={sectionOptions}
          gradeOptions={gradeOptions}
          onDone={() => {
            setComposing(false);
            router.refresh();
          }}
        />
      )}

      {list.length === 0 ? (
        <Card>
          <EmptyState
            title="No announcements yet"
            description={
              tab === 'manage'
                ? 'Anything you write will appear here, including drafts.'
                : 'Notices from the school will appear here.'
            }
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {list.map((a) => (
            <li key={a.id}>
              <AnnouncementCard
                announcement={a}
                locale={locale}
                showState={tab === 'manage'}
                onRead={() => router.refresh()}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap-target rounded-md px-3 py-1.5 text-sm font-medium ${
        active ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900'
      }`}
    >
      {children}
    </button>
  );
}

function AnnouncementCard({
  announcement,
  locale,
  showState,
  onRead,
}: {
  announcement: Announcement;
  locale: string;
  showState: boolean;
  onRead: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Show the Amharic version when the reader's language is Amharic and the
  // school supplied one; otherwise fall back rather than showing nothing.
  const title = locale === 'am' && announcement.titleAm ? announcement.titleAm : announcement.title;
  const body = locale === 'am' && announcement.bodyAm ? announcement.bodyAm : announcement.body;

  const when = announcement.publishedAt ?? announcement.createdAt;

  function open() {
    setExpanded((e) => !e);
    if (!announcement.isRead && !expanded) {
      startTransition(async () => {
        await fetch(`/api/announcements/${announcement.id}`, { method: 'POST' });
        onRead();
      });
    }
  }

  return (
    <Card>
      <button type="button" onClick={open} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {announcement.isPinned && <Badge tone="info">Pinned</Badge>}
              {!announcement.isRead && !showState && <Badge tone="warn">New</Badge>}
              {showState && (
                <Badge tone={announcement.isPublished ? 'good' : 'neutral'}>
                  {announcement.isPublished ? 'Published' : 'Draft'}
                </Badge>
              )}
              <Badge tone="neutral">
                {AUDIENCE_LABELS[announcement.audience] ?? announcement.audience}
              </Badge>
            </div>
            <h3
              className={`mt-2 text-base ${
                announcement.isRead ? 'font-medium text-ink-800' : 'font-semibold text-ink-900'
              }`}
            >
              {title}
            </h3>
            <p className="mt-1 text-sm text-ink-500">
              {announcement.authorName ? `${announcement.authorName} · ` : ''}
              {new Date(when).toLocaleDateString()}
            </p>
          </div>
          <span aria-hidden className="text-ink-400">
            {expanded ? '−' : '+'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 border-t border-ink-100 pt-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{body}</p>
          {isPending && <p className="mt-2 text-xs text-ink-400">Marking as read…</p>}
        </div>
      )}
    </Card>
  );
}

function ComposeForm({
  schoolWide,
  sectionOptions,
  gradeOptions,
  onDone,
}: {
  schoolWide: boolean;
  sectionOptions: Option[];
  gradeOptions: Option[];
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [titleAm, setTitleAm] = useState('');
  const [body, setBody] = useState('');
  const [bodyAm, setBodyAm] = useState('');
  // A teacher has no whole-school option, so the sensible default is the
  // classes they teach.
  const [audience, setAudience] = useState(schoolWide ? 'everyone' : 'section');
  const [selectedSections, setSelectedSections] = useState<string[]>([]);
  const [selectedGrades, setSelectedGrades] = useState<string[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [sendSms, setSendSms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(publish: boolean) {
    setBusy(true);
    setError(null);
    setFields({});

    const response = await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        titleAm,
        body,
        bodyAm,
        audience,
        sectionIds: audience === 'section' ? selectedSections : [],
        gradeLevelIds: audience === 'grade' ? selectedGrades : [],
        isPinned,
        publish,
        sendSms,
      }),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      setError(payload.error ?? 'Could not save the announcement.');
      setFields(payload.fields ?? {});
      return;
    }

    onDone();
  }

  const audiences = schoolWide
    ? ['everyone', 'staff', 'parents', 'students', 'section', 'grade']
    : ['section'];

  return (
    <Card title="New announcement">
      <div className="space-y-4">
        <Field label="Title" error={fields.title}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            placeholder="School closed on Friday"
          />
        </Field>

        <Field label="Title in Amharic (optional)" error={fields.titleAm}>
          <input
            value={titleAm}
            onChange={(e) => setTitleAm(e.target.value)}
            maxLength={200}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            placeholder="ትምህርት ቤቱ ዓርብ ዝግ ነው"
          />
        </Field>

        <Field label="Message" error={fields.body}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={5000}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Message in Amharic (optional)" error={fields.bodyAm}>
          <textarea
            value={bodyAm}
            onChange={(e) => setBodyAm(e.target.value)}
            rows={3}
            maxLength={5000}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Who should see this" error={fields.audience}>
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          >
            {audiences.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABELS[a]}
              </option>
            ))}
          </select>
          {!schoolWide && (
            <p className="mt-1 text-xs text-ink-500">
              You can only write to the classes you teach.
            </p>
          )}
        </Field>

        {audience === 'section' && (
          <Field label="Classes" error={fields.sectionIds}>
            <CheckboxList
              options={sectionOptions}
              selected={selectedSections}
              onChange={setSelectedSections}
              emptyText="You are not assigned to any class."
            />
          </Field>
        )}

        {audience === 'grade' && (
          <Field label="Grades" error={fields.gradeLevelIds}>
            <CheckboxList
              options={gradeOptions}
              selected={selectedGrades}
              onChange={setSelectedGrades}
              emptyText="No grades are configured."
            />
          </Field>
        )}

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={isPinned}
              onChange={(e) => setIsPinned(e.target.checked)}
              className="h-4 w-4"
            />
            Pin to the top
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={sendSms}
              onChange={(e) => setSendSms(e.target.checked)}
              className="h-4 w-4"
            />
            Also send by SMS
          </label>
        </div>

        {sendSms && (
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
            SMS is only sent if the school has connected a provider. Otherwise the messages are
            held in the outbox and nothing is sent.
          </p>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => submit(true)}
            className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Publish'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit(false)}
            className="tap-target rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            Save as draft
          </button>
        </div>
      </div>
    </Card>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink-700">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function CheckboxList({
  options,
  selected,
  onChange,
  emptyText,
}: {
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyText: string;
}) {
  if (options.length === 0) {
    return <p className="text-sm text-ink-500">{emptyText}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const isOn = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() =>
              onChange(
                isOn ? selected.filter((id) => id !== option.id) : [...selected, option.id],
              )
            }
            className={`tap-target rounded-lg border px-3 py-1.5 text-sm ${
              isOn
                ? 'border-brand-500 bg-brand-50 text-brand-700'
                : 'border-ink-200 text-ink-700 hover:bg-ink-50'
            }`}
          >
            {option.name}
          </button>
        );
      })}
    </div>
  );
}
