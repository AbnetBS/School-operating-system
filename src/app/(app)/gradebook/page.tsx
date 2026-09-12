import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getTeachableClassSubjects } from '../../../lib/gradebook/service.ts';
import { terms } from '../../../db/schema/core.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { PageHeader, Card, EmptyState } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export default async function GradebookPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  if (!modules.gradebook) {
    return (
      <Card>
        <EmptyState
          title="The gradebook is switched off for this school"
          description="An administrator can enable it in Settings."
        />
      </Card>
    );
  }

  if (!ctx.hasAny('grade.view', 'grade.enter')) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to the gradebook"
          description="Ask an administrator if you believe this is wrong."
        />
      </Card>
    );
  }

  const [currentTerm] = await ctx.db
    .select({ id: terms.id, name: terms.name })
    .from(terms)
    .where(and(eq(terms.schoolId, ctx.schoolId), eq(terms.isCurrent, true)))
    .limit(1);

  const classes = await getTeachableClassSubjects(ctx);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gradebook"
        description={
          currentTerm
            ? `Choose a class to enter or review marks for ${currentTerm.name}.`
            : 'Choose a class to enter or review marks.'
        }
      />

      {!currentTerm ? (
        <Card>
          <EmptyState
            title="No current term"
            description="An administrator must set the current term before marks can be recorded."
          />
        </Card>
      ) : classes.length === 0 ? (
        <Card>
          <EmptyState
            title="You are not assigned to any class subjects yet"
            description="Once you are assigned to teach a subject it will appear here."
          />
        </Card>
      ) : (
        <Card>
          {/* Mobile: cards. Desktop: table. Same data, appropriate density. */}
          <ul className="divide-y divide-ink-100 sm:hidden">
            {classes.map((c) => (
              <li key={c.sectionSubjectId}>
                <Link
                  href={`/gradebook/${c.sectionSubjectId}?termId=${currentTerm.id}`}
                  className="tap-target -mx-4 flex items-center gap-3 px-4 py-3 active:bg-ink-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{c.subjectName}</p>
                    <p className="truncate text-xs text-ink-500">
                      {c.gradeName} {c.sectionName} · {c.studentCount} students
                    </p>
                  </div>
                  <span aria-hidden className="text-ink-400">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="-mx-4 hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2.5 font-medium">Subject</th>
                  <th className="px-4 py-2.5 font-medium">Class</th>
                  <th className="px-4 py-2.5 font-medium">Students</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.sectionSubjectId} className="border-b border-ink-100">
                    <td className="px-4 py-2.5 font-medium text-ink-900">{c.subjectName}</td>
                    <td className="px-4 py-2.5 text-ink-600">
                      {c.gradeName} {c.sectionName}
                    </td>
                    <td className="px-4 py-2.5 text-ink-600">{c.studentCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link
                        href={`/gradebook/${c.sectionSubjectId}?termId=${currentTerm.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
