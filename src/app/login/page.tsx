import { redirect } from 'next/navigation';
import { getAuthContext } from '../../lib/auth/context.ts';
import { getDb } from '../../db/client.ts';
import { schools } from '../../db/schema/core.ts';
import { eq } from 'drizzle-orm';
import LoginForm from './LoginForm.tsx';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Already signed in? Go straight to the dashboard.
  const ctx = await getAuthContext();
  if (ctx) redirect('/dashboard');

  const db = await getDb();
  const available = await db
    .select({ code: schools.code, name: schools.name, nameAm: schools.nameAm })
    .from(schools)
    .where(eq(schools.isActive, true))
    .orderBy(schools.name);

  return <LoginForm schools={available} />;
}
