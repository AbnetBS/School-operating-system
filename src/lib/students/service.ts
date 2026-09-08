/**
 * Student service.
 *
 * All student reads and writes go through here so that tenancy, permission
 * scoping, audit logging and event emission are applied consistently. Route
 * handlers stay thin.
 *
 * The listing query is the one most likely to be hit hard (a registrar
 * searching while 900 students exist), so it is a single paginated SQL query
 * with the current enrolment joined in — not N+1 lookups per row.
 */

import { and, asc, desc, eq, ilike, isNull, or, sql, count, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  students,
  enrollments,
  guardians,
  studentGuardians,
  studentStatusHistory,
} from '../../db/schema/people.ts';
import { academicYears, gradeLevels, sections } from '../../db/schema/core.ts';
import { recordAudit, diffValues } from '../audit/index.ts';
import { emitEvent } from '../events/index.ts';
import { getSetting } from '../settings/service.ts';
import { normalisePhone, type CreateStudentInput, type StudentListQuery } from './schema.ts';
import type { AuthContext } from '../auth/context.ts';
import { todayIso } from '../calendar/ethiopian.ts';

export type StudentListRow = {
  id: string;
  studentCode: string;
  givenName: string;
  fatherName: string;
  grandfatherName: string | null;
  gender: string | null;
  status: string;
  photoUrl: string | null;
  gradeName: string | null;
  sectionName: string | null;
  sectionId: string | null;
  gradeLevelId: string | null;
  rollNumber: number | null;
  guardianPhone: string | null;
};

/**
 * List students with search, filters and pagination.
 *
 * `restrictToSectionIds` is how a teacher's view is narrowed: it is applied as
 * a WHERE clause here rather than filtered after loading, so a teacher's query
 * never even reads other sections' rows.
 */
export async function listStudents(
  db: Database,
  schoolId: string,
  query: StudentListQuery,
  options: { restrictToSectionIds?: string[]; academicYearId?: string | null } = {},
): Promise<{ rows: StudentListRow[]; total: number }> {
  const conditions: SQL[] = [eq(students.schoolId, schoolId), isNull(students.deletedAt)];

  if (query.status) {
    conditions.push(eq(students.status, query.status));
  }
  if (query.gender) {
    conditions.push(eq(students.gender, query.gender));
  }

  if (query.search) {
    const term = `%${query.search}%`;
    const match = or(
      ilike(students.givenName, term),
      ilike(students.fatherName, term),
      ilike(students.grandfatherName, term),
      ilike(students.studentCode, term),
      ilike(students.givenNameAm, term),
      ilike(students.fatherNameAm, term),
    );
    if (match) conditions.push(match);
  }

  // Join the student's current enrolment so grade/section can be shown and
  // filtered without a second query per row.
  const currentEnrolment = and(
    eq(enrollments.studentId, students.id),
    isNull(enrollments.endedOn),
    options.academicYearId ? eq(enrollments.academicYearId, options.academicYearId) : undefined,
  );

  if (query.sectionId) {
    conditions.push(eq(enrollments.sectionId, query.sectionId));
  }
  if (query.gradeLevelId) {
    conditions.push(eq(enrollments.gradeLevelId, query.gradeLevelId));
  }

  // Teacher scoping: restrict to their own sections.
  if (options.restrictToSectionIds) {
    if (options.restrictToSectionIds.length === 0) {
      return { rows: [], total: 0 };
    }
    const inSections = or(
      ...options.restrictToSectionIds.map((id) => eq(enrollments.sectionId, id)),
    );
    if (inSections) conditions.push(inSections);
  }

  const where = and(...conditions);

  const orderBy =
    query.sort === 'code'
      ? [asc(students.studentCode)]
      : query.sort === 'created'
        ? [desc(students.createdAt)]
        : query.sort === 'grade'
          ? [asc(gradeLevels.level), asc(sections.name), asc(students.givenName)]
          : [asc(students.givenName), asc(students.fatherName)];

  const offset = (query.page - 1) * query.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: students.id,
        studentCode: students.studentCode,
        givenName: students.givenName,
        fatherName: students.fatherName,
        grandfatherName: students.grandfatherName,
        gender: students.gender,
        status: students.status,
        photoUrl: students.photoUrl,
        gradeName: gradeLevels.name,
        gradeLevelId: gradeLevels.id,
        sectionName: sections.name,
        sectionId: sections.id,
        rollNumber: enrollments.rollNumber,
        guardianPhone: sql<string | null>`(
          select g.phone from ${guardians} g
          join ${studentGuardians} sg on sg.guardian_id = g.id
          where sg.student_id = ${students.id}
          order by sg.is_primary desc
          limit 1
        )`,
      })
      .from(students)
      .leftJoin(enrollments, currentEnrolment)
      .leftJoin(gradeLevels, eq(gradeLevels.id, enrollments.gradeLevelId))
      .leftJoin(sections, eq(sections.id, enrollments.sectionId))
      .where(where)
      .orderBy(...orderBy)
      .limit(query.pageSize)
      .offset(offset),

    db
      .select({ total: count() })
      .from(students)
      .leftJoin(enrollments, currentEnrolment)
      .where(where),
  ]);

  return { rows, total: totals[0]?.total ?? 0 };
}

/** Full profile for one student, including enrolment history and guardians. */
export async function getStudentProfile(db: Database, schoolId: string, studentId: string) {
  const [student] = await db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.id, studentId),
        isNull(students.deletedAt),
      ),
    )
    .limit(1);

  if (!student) return null;

  const [enrolmentRows, guardianRows, history] = await Promise.all([
    db
      .select({
        id: enrollments.id,
        academicYearId: enrollments.academicYearId,
        yearName: academicYears.name,
        gradeName: gradeLevels.name,
        sectionName: sections.name,
        sectionId: sections.id,
        rollNumber: enrollments.rollNumber,
        enrolledOn: enrollments.enrolledOn,
        endedOn: enrollments.endedOn,
        status: enrollments.status,
        registrationStatus: enrollments.registrationStatus,
      })
      .from(enrollments)
      .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
      .leftJoin(gradeLevels, eq(gradeLevels.id, enrollments.gradeLevelId))
      .leftJoin(sections, eq(sections.id, enrollments.sectionId))
      .where(and(eq(enrollments.schoolId, schoolId), eq(enrollments.studentId, studentId)))
      .orderBy(desc(academicYears.startDate)),

    db
      .select({
        id: guardians.id,
        givenName: guardians.givenName,
        fatherName: guardians.fatherName,
        phone: guardians.phone,
        altPhone: guardians.altPhone,
        email: guardians.email,
        occupation: guardians.occupation,
        relationship: studentGuardians.relationship,
        isPrimary: studentGuardians.isPrimary,
        canPickUp: studentGuardians.canPickUp,
      })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(
        and(eq(studentGuardians.schoolId, schoolId), eq(studentGuardians.studentId, studentId)),
      )
      .orderBy(desc(studentGuardians.isPrimary)),

    db
      .select()
      .from(studentStatusHistory)
      .where(
        and(
          eq(studentStatusHistory.schoolId, schoolId),
          eq(studentStatusHistory.studentId, studentId),
        ),
      )
      .orderBy(desc(studentStatusHistory.createdAt))
      .limit(20),
  ]);

  return {
    student,
    enrolments: enrolmentRows,
    currentEnrolment: enrolmentRows.find((e) => e.endedOn === null) ?? null,
    guardians: guardianRows,
    statusHistory: history,
  };
}

/**
 * Generate the next student code from the school's configured pattern.
 * Falls back safely if the pattern is unusual.
 */
export async function generateStudentCode(
  db: Database,
  schoolId: string,
  ethiopianYear: number | null,
): Promise<string> {
  const academic = await getSetting(db, schoolId, 'academic');
  const pattern = academic.studentCodeFormat || '{year}/{seq}';
  const padding = academic.studentCodeSeqPadding ?? 4;

  const [row] = await db
    .select({ total: count() })
    .from(students)
    .where(eq(students.schoolId, schoolId));

  // Find a free sequence number rather than assuming count+1 is unused —
  // deleted or imported records can leave gaps.
  let seq = (row?.total ?? 0) + 1;
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = pattern
      .replace('{year}', String(ethiopianYear ?? new Date().getFullYear()))
      .replace('{seq}', String(seq).padStart(padding, '0'));
    const [existing] = await db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), eq(students.studentCode, candidate)))
      .limit(1);
    if (!existing) return candidate;
    seq++;
  }
  // Extremely unlikely fallback.
  return `${Date.now()}`;
}

/**
 * Create a student, their first enrolment and optionally a guardian, as one
 * unit of work.
 *
 * This is the "enter once, reuse everywhere" entry point: after this call the
 * student is immediately usable by attendance, the gradebook, report cards,
 * fees and the portals, with no further data entry.
 */
export async function createStudent(
  ctx: AuthContext,
  input: CreateStudentInput,
  academicYearId: string,
): Promise<{ id: string; studentCode: string }> {
  const { db, schoolId } = ctx;
  const localeSettings = await getSetting(db, schoolId, 'locale');
  const today = todayIso(localeSettings.timezone);

  // Verify the grade level and section belong to this school and year. The
  // composite foreign keys would also catch this, but failing here produces a
  // clear message instead of a constraint error.
  const [grade] = await db
    .select({ id: gradeLevels.id })
    .from(gradeLevels)
    .where(and(eq(gradeLevels.schoolId, schoolId), eq(gradeLevels.id, input.gradeLevelId)))
    .limit(1);
  if (!grade) throw new Error('The selected grade level does not exist at this school.');

  if (input.sectionId) {
    const [section] = await db
      .select({ id: sections.id })
      .from(sections)
      .where(
        and(
          eq(sections.schoolId, schoolId),
          eq(sections.id, input.sectionId),
          eq(sections.academicYearId, academicYearId),
        ),
      )
      .limit(1);
    if (!section) {
      throw new Error('The selected section does not belong to the current academic year.');
    }
  }

  const [student] = await db
    .insert(students)
    .values({
      schoolId,
      studentCode: input.studentCode,
      givenName: input.givenName,
      fatherName: input.fatherName,
      grandfatherName: input.grandfatherName || null,
      givenNameAm: input.givenNameAm || null,
      fatherNameAm: input.fatherNameAm || null,
      grandfatherNameAm: input.grandfatherNameAm || null,
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth || null,
      phone: normalisePhone(input.phone),
      email: input.email || null,
      address: input.address || null,
      subCity: input.subCity || null,
      woreda: input.woreda || null,
      kebele: input.kebele || null,
      emergencyContactName: input.emergencyContactName || null,
      emergencyContactPhone: normalisePhone(input.emergencyContactPhone),
      emergencyContactRelation: input.emergencyContactRelation || null,
      medicalNotes: input.medicalNotes || null,
      bloodGroup: input.bloodGroup || null,
      previousSchool: input.previousSchool || null,
      admissionDate: input.admissionDate || today,
      admissionYearId: academicYearId,
      status: input.status ?? 'active',
      notes: input.notes || null,
      customFields: input.customFields ?? {},
    })
    .returning({ id: students.id, studentCode: students.studentCode });

  const studentId = student!.id;

  await db.insert(enrollments).values({
    schoolId,
    studentId,
    academicYearId,
    gradeLevelId: input.gradeLevelId,
    sectionId: input.sectionId || null,
    rollNumber: input.rollNumber ?? null,
    enrolledOn: input.enrolledOn || today,
    status: 'enrolled',
    registrationStatus: 'approved',
  });

  if (input.guardian?.givenName) {
    const [guardian] = await db
      .insert(guardians)
      .values({
        schoolId,
        givenName: input.guardian.givenName,
        fatherName: input.guardian.fatherName || null,
        phone: normalisePhone(input.guardian.phone),
        email: input.guardian.email || null,
      })
      .returning({ id: guardians.id });

    await db.insert(studentGuardians).values({
      schoolId,
      studentId,
      guardianId: guardian!.id,
      relationship: input.guardian.relationship || 'father',
      isPrimary: true,
    });
  }

  await db.insert(studentStatusHistory).values({
    schoolId,
    studentId,
    fromStatus: null,
    toStatus: input.status ?? 'active',
    reason: 'Student registered',
    effectiveDate: input.enrolledOn || today,
    changedBy: ctx.user.userId,
  });

  await recordAudit(db, {
    schoolId,
    actorUserId: ctx.user.userId,
    actorName: ctx.displayName(),
    action: 'student.create',
    entityType: 'student',
    entityId: studentId,
    summary: `${input.givenName} ${input.fatherName} (${input.studentCode})`,
    newValue: { studentCode: input.studentCode, gradeLevelId: input.gradeLevelId },
    ipAddress: ctx.ipAddress,
  });

  if (input.sectionId) {
    await emitEvent(db, schoolId, 'student.enrolled', {
      studentId,
      sectionId: input.sectionId,
      academicYearId,
    });
  }

  return { id: studentId, studentCode: student!.studentCode };
}

/** Update a student, recording exactly what changed. */
export async function updateStudent(
  ctx: AuthContext,
  studentId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { db, schoolId } = ctx;

  const [before] = await db
    .select()
    .from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.id, studentId)))
    .limit(1);

  if (!before) throw new Error('Student not found');

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    updates[key] = value === '' ? null : value;
  }
  if (typeof updates.phone === 'string') updates.phone = normalisePhone(updates.phone);

  const statusChanged =
    typeof updates.status === 'string' && updates.status !== before.status;
  if (statusChanged) {
    updates.statusChangedAt = new Date();
  }

  const [after] = await db
    .update(students)
    .set(updates)
    .where(and(eq(students.schoolId, schoolId), eq(students.id, studentId)))
    .returning();

  const diff = diffValues(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
  );

  if (diff) {
    await recordAudit(db, {
      schoolId,
      actorUserId: ctx.user.userId,
      actorName: ctx.displayName(),
      action: statusChanged ? 'student.statusChange' : 'student.update',
      entityType: 'student',
      entityId: studentId,
      summary: `${before.givenName} ${before.fatherName} (${before.studentCode})`,
      previousValue: diff.previous,
      newValue: diff.next,
      reason: (patch.statusReason as string) ?? null,
      ipAddress: ctx.ipAddress,
    });
  }

  if (statusChanged) {
    const localeSettings = await getSetting(db, schoolId, 'locale');
    await db.insert(studentStatusHistory).values({
      schoolId,
      studentId,
      fromStatus: before.status,
      toStatus: updates.status as string,
      reason: (patch.statusReason as string) ?? null,
      effectiveDate: todayIso(localeSettings.timezone),
      changedBy: ctx.user.userId,
    });

    await emitEvent(db, schoolId, 'student.statusChanged', {
      studentId,
      from: before.status,
      to: updates.status as string,
    });
  }
}

/** Distinct filter options for the student list, in one query each. */
export async function getStudentFilters(
  db: Database,
  schoolId: string,
  academicYearId: string | null,
) {
  const [grades, sectionRows] = await Promise.all([
    db
      .select({ id: gradeLevels.id, name: gradeLevels.name, level: gradeLevels.level })
      .from(gradeLevels)
      .where(and(eq(gradeLevels.schoolId, schoolId), eq(gradeLevels.isActive, true)))
      .orderBy(gradeLevels.level),
    academicYearId
      ? db
          .select({
            id: sections.id,
            name: sections.name,
            gradeName: gradeLevels.name,
            level: gradeLevels.level,
          })
          .from(sections)
          .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
          .where(
            and(eq(sections.schoolId, schoolId), eq(sections.academicYearId, academicYearId)),
          )
          .orderBy(gradeLevels.level, sections.name)
      : Promise.resolve([]),
  ]);

  return { grades, sections: sectionRows };
}
