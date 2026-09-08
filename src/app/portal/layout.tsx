import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAuthContext } from '../../lib/auth/context.ts';
import { schools } from '../../db/schema/core.ts';
import SignOut from './SignOut.tsx';

export const dynamic = 'force-dynamic';

/**
 * The portal shell.
 *
 * Deliberately separate from the staff application: a parent should see a
 * small, calm surface with no staff navigation, and none of the staff screens
 * should be reachable from here.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  // Staff who are not also portal users belong in the main application.
  if (!ctx.hasAny('portal.student', 'portal.parent')) redirect('/dashboard');

  const [school] = await ctx.db
    .select({ name: schools.name, nameAm: schools.nameAm })
    .from(schools)
    .where(eq(schools.id, ctx.schoolId))
    .limit(1);

  const isParent = ctx.has('portal.parent');
  const home = isParent ? '/portal/parent' : '/portal/student';

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link href={home} className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">
              {school?.name ?? 'School'}
            </p>
            <p className="truncate text-xs text-ink-500">
              {isParent ? 'Parent portal' : 'Student portal'}
            </p>
          </Link>
          <SignOut />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 pb-24">{children}</main>
    </div>
  );
}
