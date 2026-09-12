import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthContext } from '../../../../lib/auth/context.ts';
import { PageHeader } from '../../../../components/ui.tsx';
import ImportWizard from './ImportWizard.tsx';

export const dynamic = 'force-dynamic';

export default async function ImportStudentsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.has('student.import')) notFound();

  return (
    <>
      <div className="mb-3">
        <Link href="/students" className="text-sm text-brand-600 hover:underline">
          ← All students
        </Link>
      </div>
      <PageHeader
        title="Import students"
        description="Upload a spreadsheet. Nothing is saved until you have seen what will happen."
      />
      <ImportWizard canCreate={ctx.has('student.create')} />
    </>
  );
}
