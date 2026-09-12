import { redirect } from 'next/navigation';
import { getAuthContext } from '../../../lib/auth/context.ts';
import PortalHome from '../PortalHome.tsx';

export const dynamic = 'force-dynamic';

export default async function StudentPortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.has('portal.student')) redirect('/portal/parent');

  const query = await searchParams;
  return (
    <PortalHome
      ctx={ctx}
      basePath="/portal/student"
      requestedTermId={typeof query.termId === 'string' ? query.termId : undefined}
    />
  );
}
