import Link from 'next/link';
import type { AuthContext } from '../../lib/auth/context.ts';
import { resolvePortalStudentPage } from './resolve-student.ts';
import {
  listPortalStudents,
  getPortalTerms,
  getPortalResults,
  getPortalAttendance,
  getPortalSubjects,
  getPortalProgress,
} from '../../lib/portal/service.ts';

/**
 * The portal home, shared by the student and parent views.
 *
 * The only difference between them is that a parent may have more than one
 * child and therefore gets a switcher. Everything else — results, attendance,
 * subjects — is identical, so it lives here once.
 */
export default async function PortalHome({
  ctx,
  basePath,
  requestedStudentId,
  requestedTermId,
}: {
  ctx: AuthContext;
  basePath: string;
  requestedStudentId?: string;
  requestedTermId?: string;
}) {
  const students = await listPortalStudents(ctx);

  if (students.length === 0) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm font-medium text-ink-900">No student record is linked yet</p>
        <p className="mt-1 text-sm text-ink-500">
          Please contact the school office so they can link your account.
        </p>
      </div>
    );
  }

  // resolvePortalStudent refuses anything outside the permitted set, so a
  // guessed id in the URL cannot widen access.
  const student = await resolvePortalStudentPage(ctx, requestedStudentId ?? null);

  const [terms, attendance, subjects, progress] = await Promise.all([
    getPortalTerms(ctx, student.id),
    getPortalAttendance(ctx, student.id),
    getPortalSubjects(ctx, student.id),
    getPortalProgress(ctx, student.id),
  ]);

  const term = terms.find((t) => t.id === requestedTermId) ?? terms.find((t) => t.isCurrent) ?? terms[0];
  const results = term ? await getPortalResults(ctx, student.id, term.id) : null;

  const studentQuery = `studentId=${student.id}`;

  return (
    <div className="space-y-5">
      {/* ---- who am I looking at ---- */}
      <section className="card p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-800">
            {student.name.charAt(0)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink-900">{student.name}</p>
            <p className="truncate text-sm text-ink-500">
              {student.studentCode}
              {student.gradeName ? ` · ${student.gradeName} ${student.sectionName ?? ''}` : ''}
            </p>
          </div>
        </div>

        {students.length > 1 && (
          <nav className="mt-3 flex flex-wrap gap-2" aria-label="Choose child">
            {students.map((s) => (
              <Link
                key={s.id}
                href={`${basePath}?studentId=${s.id}`}
                className={`tap-target rounded-full px-3 py-1.5 text-sm font-medium ${
                  s.id === student.id
                    ? 'bg-brand-600 text-white'
                    : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                }`}
              >
                {s.name.split(' ')[0]}
              </Link>
            ))}
          </nav>
        )}
      </section>

      {/* ---- attendance ---- */}
      {attendance && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink-900">Attendance</h2>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-ink-900">
              {attendance.percent === null ? '—' : `${attendance.percent}%`}
            </span>
            <span className="text-sm text-ink-500">
              {attendance.present} present · {attendance.absent} absent · {attendance.late} late
            </span>
          </div>

          {attendance.recent.length > 0 && (
            <ul className="mt-3 divide-y divide-ink-100 text-sm">
              {attendance.recent.slice(0, 5).map((r, i) => (
                <li key={`${r.date}-${i}`} className="flex items-center justify-between py-2">
                  <span className="text-ink-700">{r.date}</span>
                  <span className="text-ink-500">
                    {r.subjectName ? `${r.subjectName} · ` : ''}
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ---- results ---- */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-900">Results</h2>
          {terms.length > 1 && (
            <nav className="flex flex-wrap gap-1.5" aria-label="Term">
              {terms.map((t) => (
                <Link
                  key={t.id}
                  href={`${basePath}?${studentQuery}&termId=${t.id}`}
                  className={`tap-target rounded-full px-2.5 py-1 text-xs font-medium ${
                    t.id === term?.id ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700'
                  }`}
                >
                  {t.name}
                  {!t.hasReportCard && ' ·'}
                </Link>
              ))}
            </nav>
          )}
        </div>

        {!results || !results.published || !results.card ? (
          <p className="mt-3 rounded-lg bg-ink-100 px-3 py-3 text-sm text-ink-600">
            {results?.message ?? 'Results for this term have not been published yet.'}
          </p>
        ) : (
          <ResultsTable card={results.card} />
        )}
      </section>

      {/* ---- progress across terms ---- */}
      {progress.length > 1 && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink-900">Progress</h2>
          <ul className="mt-2 space-y-2">
            {progress.map((p) => (
              <li key={p.sequence} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 truncate text-ink-600">{p.termName}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                  <span
                    className="block h-full rounded-full bg-brand-500"
                    style={{ width: `${Math.max(0, Math.min(100, p.average ?? 0))}%` }}
                  />
                </span>
                <span className="w-12 shrink-0 text-right font-medium text-ink-900">
                  {p.average === null ? '—' : `${p.average}%`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- subjects ---- */}
      {subjects.length > 0 && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink-900">Subjects</h2>
          <ul className="mt-2 divide-y divide-ink-100 text-sm">
            {subjects.map((s, i) => (
              <li key={`${s.subjectName}-${i}`} className="flex items-center justify-between py-2">
                <span className="text-ink-800">{s.subjectName}</span>
                <span className="text-ink-500">{s.teacherName ?? '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="px-1 text-xs text-ink-500">
        Contact the school office if any detail here looks wrong.
      </p>
    </div>
  );
}

/** The published report card, rendered from its frozen snapshot. */
function ResultsTable({
  card,
}: {
  card: NonNullable<Awaited<ReturnType<typeof getPortalResults>>['card']>;
}) {
  const data = card.data;
  if (!data) {
    return <p className="mt-3 text-sm text-ink-500">This report card has no content yet.</p>;
  }
  // Which columns appear is the school's decision, not this component's.
  const { showRank, showAttendance, showTeacherComment, showPrincipalComment } = card.settings;
  const showGpa = data.gpa !== null;

  return (
    <div className="mt-3">
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="px-4 py-2 font-medium">Subject</th>
              <th className="px-4 py-2 text-right font-medium">Mark</th>
              <th className="px-4 py-2 text-right font-medium">Grade</th>
              {showRank && <th className="px-4 py-2 text-right font-medium">Rank</th>}
            </tr>
          </thead>
          <tbody>
            {data.subjects.map((s) => (
              <tr key={s.subjectName} className="border-b border-ink-100">
                <td className="px-4 py-2 text-ink-800">{s.subjectName}</td>
                <td className="px-4 py-2 text-right font-medium text-ink-900">
                  {s.percentage === null ? '—' : `${s.percentage}%`}
                </td>
                <td className="px-4 py-2 text-right text-ink-700">{s.letter ?? '—'}</td>
                {showRank && (
                  <td className="px-4 py-2 text-right text-ink-700">{s.rank ?? '—'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-500">Average</dt>
          <dd className="font-semibold text-ink-900">
            {data.average === null ? '—' : `${data.average}%`}
          </dd>
        </div>
        {showRank && (
          <div>
            <dt className="text-xs text-ink-500">Rank</dt>
            <dd className="font-semibold text-ink-900">
              {data.rankInSection === null
                ? '—'
                : `${data.rankInSection}${data.classSize ? ` of ${data.classSize}` : ''}`}
            </dd>
          </div>
        )}
        {showGpa && (
          <div>
            <dt className="text-xs text-ink-500">GPA</dt>
            <dd className="font-semibold text-ink-900">{data.gpa ?? '—'}</dd>
          </div>
        )}
        {showAttendance && data.attendancePercent !== null && (
          <div>
            <dt className="text-xs text-ink-500">Attendance</dt>
            <dd className="font-semibold text-ink-900">{data.attendancePercent}%</dd>
          </div>
        )}
      </dl>

      {((showTeacherComment && card.classTeacherComment) ||
        (showPrincipalComment && card.principalComment)) && (
        <div className="mt-3 space-y-2 border-t border-ink-200 pt-3 text-sm">
          {showTeacherComment && card.classTeacherComment && (
            <p className="text-ink-700">
              <span className="font-medium text-ink-900">Class teacher: </span>
              {card.classTeacherComment}
            </p>
          )}
          {showPrincipalComment && card.principalComment && (
            <p className="text-ink-700">
              <span className="font-medium text-ink-900">Principal: </span>
              {card.principalComment}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
