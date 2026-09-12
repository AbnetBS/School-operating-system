import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import PortalHome from '../PortalHome.tsx';

export const dynamic = 'force-dynamic';

export default async function ParentPortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  // A student account landing here is sent to its own portal rather than
  // being shown a parent's multi-child view.
  if (!ctx.has('portal.parent')) redirect('/portal/student');

  const query = await searchParams;
  return (
    <PortalHome
      ctx={ctx}
      basePath="/portal/parent"
      requestedStudentId={typeof query.studentId === 'string' ? query.studentId : undefined}
      requestedTermId={typeof query.termId === 'string' ? query.termId : undefined}
    />
  );
}
