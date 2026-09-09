import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import AppShell, { type NavItem } from '../../components/AppShell.tsx';
import { getAuthContext } from '../../lib/auth/context.ts';
import { schools } from '../../db/schema/core.ts';
import { todayIso, formatDate } from '../../lib/calendar/ethiopian.ts';
import { getSetting } from '../../lib/settings/service.ts';
import type { Permission } from '../../lib/auth/permissions.ts';

export const dynamic = 'force-dynamic';

/**
 * Navigation is derived from permissions and enabled modules, so a user is
 * never shown a link they cannot use. This is convenience, not security — the
 * endpoints behind each link enforce the same rules independently.
 */
function buildNav(
  has: (p: Permission) => boolean,
  modules: Record<string, boolean>,
): NavItem[] {
  const items: NavItem[] = [];

  items.push({ href: '/dashboard', label: 'Dashboard', icon: '◆' });

  if (modules.attendance && (has('attendance.take') || has('attendance.view'))) {
    items.push({ href: '/attendance', label: 'Attendance', icon: '✓' });
  }
  if (modules.gradebook && (has('grade.view') || has('grade.enter'))) {
    items.push({ href: '/gradebook', label: 'Gradebook', icon: '▦' });
  }
  if (modules.reportCards && (has('reportCard.view') || has('reportCard.generate'))) {
    items.push({ href: '/report-cards', label: 'Report cards', icon: '▣' });
  }
  if (modules.announcements && has('announcement.view')) {
    items.push({ href: '/announcements', label: 'Announcements', icon: '❋' });
  }
  if (has('message.send')) {
    items.push({ href: '/messages', label: 'Messages', icon: '✉' });
  }
  // Every signed-in person has a notification feed — it needs no permission.
  items.push({ href: '/notifications', label: 'Notifications', icon: '◔' });
  if (has('student.view')) {
    items.push({ href: '/students', label: 'Students', icon: '☺' });
  }
  if (has('guardian.view')) {
    items.push({ href: '/guardians', label: 'Guardians', icon: '♥' });
  }
  if (has('academic.view')) {
    items.push({ href: '/academics', label: 'Academics', icon: '▤' });
  }
  if (has('staff.view')) {
    items.push({ href: '/staff', label: 'Staff', icon: '✦' });
  }
  if (has('audit.view')) {
    items.push({ href: '/audit', label: 'Audit log', icon: '⏱' });
  }
  if (has('school.manage') || has('notification.manageTemplates')) {
    items.push({ href: '/settings', label: 'Settings', icon: '⚙' });
  }

  return items;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  // Parents and students belong in their portals, not the staff application.
  if (ctx.has('portal.parent') && !ctx.has('student.view')) redirect('/portal/parent');
  if (ctx.has('portal.student') && !ctx.has('student.view')) redirect('/portal/student');

  const [school] = await ctx.db
    .select({ name: schools.name, nameAm: schools.nameAm })
    .from(schools)
    .where(eq(schools.id, ctx.schoolId))
    .limit(1);

  const [modules, localeSettings] = await Promise.all([
    getSetting(ctx.db, ctx.schoolId, 'modules'),
    getSetting(ctx.db, ctx.schoolId, 'locale'),
  ]);

  const today = todayIso(localeSettings.timezone);
  const nav = buildNav((p) => ctx.has(p), modules as unknown as Record<string, boolean>);

  const schoolName =
    ctx.locale === 'am' && school?.nameAm ? school.nameAm : (school?.name ?? 'School');

  return (
    <AppShell
      nav={nav}
      userName={ctx.displayName()}
      roleLabel={ctx.roleKeys.map(humanRole).join(', ') || 'Staff'}
      schoolName={schoolName}
      ethiopianDate={formatDate(today, { calendar: 'ethiopian', locale: ctx.locale })}
      gregorianDate={formatDate(today, { calendar: 'gregorian', locale: ctx.locale })}
    >
      {children}
    </AppShell>
  );
}

function humanRole(key: string): string {
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
