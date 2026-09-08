import { redirect } from 'next/navigation';
import { getAuthContext } from '../lib/auth/context.ts';

export const dynamic = 'force-dynamic';

/**
 * Route users to the right home screen for their role.
 * A parent should never land on an admin dashboard, and a teacher's first
 * screen should be their classes rather than school-wide statistics.
 */
export default async function Home() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  if (ctx.has('portal.parent')) redirect('/portal/parent');
  if (ctx.has('portal.student')) redirect('/portal/student');
  redirect('/dashboard');
}
