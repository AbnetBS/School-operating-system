/**
 * Documents.
 *
 * Filed against a pupil, a member of staff, or the school itself. There is no
 * "all documents" view on purpose: a school's document store contains medical
 * notes and contracts, and a list that spans them is a disclosure waiting to
 * happen. The screen asks who first.
 */

import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { DOCUMENT_CATEGORIES, DOCUMENT_OWNER_TYPES } from '../../../lib/operations/schema.ts';
import { MAX_UPLOAD_BYTES } from '../../../lib/operations/storage.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';
import DocumentManager from './DocumentManager.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.cancel',
  'action.delete',
  'ops.saving',
  'ops.loading',
  'ops.change',
  'ops.searchStudent',
  'ops.searchStaff',
  'document.title',
  'document.upload',
  'document.uploadFor',
  'document.uploaded',
  'document.download',
  'document.chooseFile',
  'document.category',
  'document.description',
  'document.expiresOn',
  'document.visibleToPortal',
  'document.noDocuments',
  'document.confirmDelete',
  'document.deleted',
  'document.maxSize',
  'document.tooLarge',
  'document.badType',
  'document.noFile',
  'document.owner.student',
  'document.owner.staff',
  'document.owner.school',
  'document.category.birth_certificate',
  'document.category.transcript',
  'document.category.report_card',
  'document.category.contract',
  'document.category.certificate',
  'document.category.identification',
  'document.category.medical',
  'document.category.policy',
  'document.category.photo',
  'document.category.other',
];

export default async function DocumentsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.documents) {
    return (
      <Card>
        <EmptyState title={t('document.disabled')} />
      </Card>
    );
  }
  if (!ctx.has('document.view')) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader title={t('document.title')} />
      <DocumentManager
        labels={labels}
        categories={[...DOCUMENT_CATEGORIES]}
        ownerTypes={[...DOCUMENT_OWNER_TYPES]}
        maxSizeMb={MAX_UPLOAD_BYTES / (1024 * 1024)}
        canUpload={ctx.has('document.upload')}
        canDelete={ctx.has('document.delete')}
        // A staff document is personal data; seeing one needs staff.view, and
        // `getDocumentForAccess` enforces that independently.
        canSeeStaff={ctx.has('staff.view')}
      />
    </>
  );
}
