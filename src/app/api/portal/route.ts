/**
 * Portal API for students and parents.
 *
 * Every read here is scoped by the session's own relationships, never by an id
 * the caller supplies. A `studentId` in the query string can only *select*
 * among students the viewer already has access to; anything else is a 404.
 */

import type { NextRequest } from 'next/server';
import { requireAuth } from '../../../lib/auth/context.ts';
import { route, ok, badRequest, forbidden } from '../../../lib/api/respond.ts';
import {
  listPortalStudents,
  resolvePortalStudent,
  getPortalTerms,
  getPortalResults,
  getPortalAttendance,
  getPortalSubjects,
  getPortalProgress,
  getPortalGuardianProfile,
} from '../../../lib/portal/service.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const ctx = await requireAuth();

  // Only portal roles use this endpoint. Staff have the full application, and
  // letting a staff token read here would bypass the relationship checks the
  // portal is built on.
  if (!ctx.hasAny('portal.student', 'portal.parent')) {
    return forbidden('This is the student and parent portal.');
  }

  const url = new URL(request.url);
  const view = url.searchParams.get('view') ?? 'overview';
  const requestedStudentId = url.searchParams.get('studentId');

  // Throws 404 for any id the viewer is not entitled to.
  const student = await resolvePortalStudent(ctx, requestedStudentId);

  switch (view) {
    case 'students':
      return ok({ students: await listPortalStudents(ctx) });

    case 'terms':
      return ok({ student, terms: await getPortalTerms(ctx, student.id) });

    case 'results': {
      const termId = url.searchParams.get('termId');
      if (!termId) return badRequest('A term must be specified.');
      return ok({ student, ...(await getPortalResults(ctx, student.id, termId)) });
    }

    case 'attendance': {
      const termId = url.searchParams.get('termId') ?? undefined;
      return ok({ student, attendance: await getPortalAttendance(ctx, student.id, { termId }) });
    }

    case 'subjects':
      return ok({ student, subjects: await getPortalSubjects(ctx, student.id) });

    case 'overview':
    default: {
      const [students, terms, attendance, subjects, progress, guardian] = await Promise.all([
        listPortalStudents(ctx),
        getPortalTerms(ctx, student.id),
        getPortalAttendance(ctx, student.id),
        getPortalSubjects(ctx, student.id),
        getPortalProgress(ctx, student.id),
        ctx.has('portal.parent') ? getPortalGuardianProfile(ctx) : Promise.resolve(null),
      ]);
      return ok({ student, students, terms, attendance, subjects, progress, guardian });
    }
  }
});
