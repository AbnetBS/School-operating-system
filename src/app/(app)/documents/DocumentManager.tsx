'use client';

/**
 * Documents: upload, browse, download, delete.
 *
 * The list is deliberately owner-first. A flat list of "all documents in the
 * school" is both useless and a privacy problem, so the screen asks who the
 * document is about before it shows anything — which happens to be the same
 * question the server asks before it will answer.
 *
 * Downloads go through a normal link to `/api/documents/<id>`. There is no
 * pre-signed URL and no path in the markup: the id alone proves nothing, and
 * the route re-checks the session, the school and the owner on every request.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  ConfirmButton,
  Disclosure,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;

type Doc = {
  id: string;
  ownerType: string;
  ownerId: string | null;
  ownerName: string | null;
  title: string;
  category: string;
  description: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  visibleToPortal: boolean;
  expiresOn: string | null;
  uploadedByName: string | null;
};

type Person = { id: string; name: string; ref: string };

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentManager({
  labels,
  categories,
  ownerTypes,
  maxSizeMb,
  canUpload,
  canDelete,
  canSeeStaff,
}: {
  labels: Labels;
  categories: string[];
  ownerTypes: string[];
  maxSizeMb: number;
  canUpload: boolean;
  canDelete: boolean;
  canSeeStaff: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();

  const [ownerType, setOwnerType] = useState<string>('school');
  const [owner, setOwner] = useState<Person | null>(null);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Person[]>([]);

  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // --- person lookup --------------------------------------------------------
  useEffect(() => {
    if (ownerType === 'school' || owner) return;
    const term = query.trim();
    if (term.length < 2) {
      setPeople([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const url =
        ownerType === 'student'
          ? `/api/students?search=${encodeURIComponent(term)}&pageSize=8&status=active`
          : `/api/staff?search=${encodeURIComponent(term)}&pageSize=8&status=active`;
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return;
        const body = await res.json();
        const rows = ownerType === 'student' ? (body.data ?? []) : (body.rows ?? []);
        setPeople(
          rows.map((r: Record<string, string | null>) => ({
            id: r.id!,
            name: [r.givenName, r.fatherName, r.grandfatherName].filter(Boolean).join(' '),
            ref: (r.studentCode ?? r.staffCode ?? '') as string,
          })),
        );
      } catch {
        /* aborted */
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, ownerType, owner]);

  // --- the list -------------------------------------------------------------
  const load = useCallback(async () => {
    if (ownerType !== 'school' && !owner) {
      setDocs(null);
      return;
    }
    setListError(null);
    const params = new URLSearchParams({ ownerType, pageSize: '50' });
    if (owner) params.set('ownerId', owner.id);
    const res = await fetch(`/api/documents?${params.toString()}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setListError(body.error ?? 'Could not load documents.');
      setDocs([]);
      return;
    }
    setDocs(body.data ?? []);
  }, [ownerType, owner]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Card title={t('document.uploadFor')} className="mb-6">
        <div className="flex flex-wrap gap-2">
          {ownerTypes
            .filter((kind) => kind !== 'staff' || canSeeStaff)
            .map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  setOwnerType(kind);
                  setOwner(null);
                  setQuery('');
                  setPeople([]);
                }}
                aria-pressed={ownerType === kind}
                className={`tap-target rounded-lg border px-4 py-2 text-sm font-medium transition ${
                  ownerType === kind
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
                }`}
              >
                {t(`document.owner.${kind}`)}
              </button>
            ))}
        </div>

        {ownerType !== 'school' && (
          <div className="mt-4">
            {owner ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink-900">
                    {owner.name}
                  </span>
                  <span className="block font-mono text-xs text-ink-500">{owner.ref}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setOwner(null)}
                  className="shrink-0 text-xs font-semibold text-brand-700 underline"
                >
                  {t('ops.change')}
                </button>
              </div>
            ) : (
              <>
                <TextInput
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    ownerType === 'student' ? t('ops.searchStudent') : t('ops.searchStaff')
                  }
                />
                {people.length > 0 && (
                  <ul className="mt-2 max-h-56 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
                    {people.map((person) => (
                      <li key={person.id}>
                        <button
                          type="button"
                          onClick={() => setOwner(person)}
                          className="tap-target flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-ink-50"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-ink-900">
                              {person.name}
                            </span>
                            <span className="block font-mono text-xs text-ink-500">
                              {person.ref}
                            </span>
                          </span>
                          <span aria-hidden className="text-ink-400">
                            →
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {canUpload && (ownerType === 'school' || owner) && (
          <div className="mt-4">
            <UploadForm
              labels={labels}
              t={t}
              categories={categories}
              ownerType={ownerType}
              ownerId={owner?.id ?? null}
              maxSizeMb={maxSizeMb}
              busy={uploading}
              setBusy={setUploading}
              onDone={() => {
                void load();
                router.refresh();
              }}
            />
          </div>
        )}
      </Card>

      <Card title={t('document.title')}>
        {listError && <ErrorBanner message={listError} />}

        {docs === null ? (
          <EmptyState title={t('ops.searchStudent')} />
        ) : docs.length === 0 ? (
          <EmptyState title={t('document.noDocuments')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {docs.map((doc) => (
              <li key={doc.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{doc.title}</p>
                    <p className="truncate text-xs text-ink-500">
                      {doc.fileName} · {formatSize(doc.sizeBytes)}
                      {doc.ownerName && ` · ${doc.ownerName}`}
                      {doc.uploadedByName && ` · ${doc.uploadedByName}`}
                    </p>
                    {doc.description && (
                      <p className="mt-0.5 text-xs text-ink-600">{doc.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge tone="neutral">{t(`document.category.${doc.category}`)}</Badge>
                    {doc.visibleToPortal && (
                      <Badge tone="good">{t('document.visibleToPortal')}</Badge>
                    )}
                    {/* A plain link. The route decides whether it is allowed. */}
                    <a
                      href={`/api/documents/${doc.id}`}
                      className="tap-target rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                    >
                      {t('document.download')}
                    </a>
                    {canDelete && (
                      <DeleteDocument
                        labels={labels}
                        t={t}
                        documentId={doc.id}
                        onDone={() => {
                          void load();
                          router.refresh();
                        }}
                      />
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function UploadForm({
  labels,
  t,
  categories,
  ownerType,
  ownerId,
  maxSizeMb,
  busy,
  setBusy,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  categories: string[];
  ownerType: string;
  ownerId: string | null;
  maxSizeMb: number;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(categories[0] ?? 'other');
  const [description, setDescription] = useState('');
  const [visibleToPortal, setVisibleToPortal] = useState(false);
  const [expiresOn, setExpiresOn] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The server refuses an oversize file too; catching it here saves the user
  // uploading ten megabytes before being told.
  const tooLarge = file !== null && file.size > maxSizeMb * 1024 * 1024;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !file || tooLarge) return;

    inFlight.current = true;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setSuccess(null);

    try {
      // FormData, not JSON: this request carries bytes.
      const form = new FormData();
      form.set('file', file);
      form.set('ownerType', ownerType);
      if (ownerId) form.set('ownerId', ownerId);
      form.set('title', title.trim());
      form.set('category', category);
      if (description.trim()) form.set('description', description.trim());
      form.set('visibleToPortal', String(visibleToPortal));
      if (expiresOn) form.set('expiresOn', expiresOn);

      const res = await fetch('/api/documents', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.error ?? 'The document could not be uploaded.');
        if (body.fields) setFieldErrors(body.fields);
        return;
      }

      setSuccess(`${t('document.uploaded')}: ${body.title}`);
      setTitle('');
      setDescription('');
      setExpiresOn('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onDone();
    } catch {
      setError('The upload could not be sent. Check your connection and try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Disclosure
      open={open}
      onToggle={setOpen}
      openLabel={t('document.upload')}
      closeLabel={t('action.cancel')}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label={t('document.chooseFile')}
          hint={fill(labels['document.maxSize'] ?? '', { size: String(maxSizeMb) })}
          error={fieldErrors.file}
          required
        >
          <input
            ref={fileInput}
            type="file"
            required
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="tap-target w-full rounded-lg border border-ink-300 bg-white px-3 py-2.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-sm"
          />
        </Field>
        {tooLarge && (
          <p className="text-xs font-medium text-red-700">
            {fill(labels['document.tooLarge'] ?? '', { size: String(maxSizeMb) })}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('document.title')}
            error={fieldErrors.title}
            required
            className="sm:col-span-2"
          >
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              invalid={Boolean(fieldErrors.title)}
            />
          </Field>

          <Field label={t('document.category')} error={fieldErrors.category}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {t(`document.category.${c}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('document.expiresOn')} error={fieldErrors.expiresOn}>
            <TextInput
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>

          <Field
            label={t('document.description')}
            error={fieldErrors.description}
            className="sm:col-span-2"
          >
            <TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </Field>
        </div>

        {/* Defaults to off: an internal note must not become visible to a
            family by omission. */}
        {ownerType === 'student' && (
          <CheckboxRow
            id="doc-portal"
            label={t('document.visibleToPortal')}
            checked={visibleToPortal}
            onChange={setVisibleToPortal}
          />
        )}

        <ErrorBanner message={error} />
        {!error && <SuccessBanner message={success} />}

        <SubmitButton
          saving={busy}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={!file || tooLarge || title.trim().length === 0}
        >
          {t('document.upload')}
        </SubmitButton>
      </form>
    </Disclosure>
  );
}

function DeleteDocument({
  labels,
  t,
  documentId,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  documentId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'The document could not be deleted.');
        return;
      }
      onDone();
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ConfirmButton
        label={t('action.delete')}
        confirmLabel={t('action.delete')}
        question={t('document.confirmDelete')}
        cancelLabel={t('action.cancel')}
        onConfirm={() => void remove()}
        saving={busy}
        savingLabel={labels['ops.saving'] ?? '…'}
      />
      <ErrorBanner message={error} />
    </div>
  );
}
