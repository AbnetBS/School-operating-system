/**
 * Communication tests.
 *
 * A messaging system that leaks is worse than none: a private note about a
 * child's difficulties reaching the wrong parent is a real harm, not a bug
 * report. So most of this file is authorization.
 *
 * The cases that matter:
 *
 *   - a thread is readable only by its participants, not by role
 *   - a teacher may only address classes they actually teach
 *   - a parent may not message another parent
 *   - nothing crosses a school boundary, even with a valid id from elsewhere
 *   - a refused id returns 404, not 403
 *   - a retried event produces one notification, not two
 *   - a double-tapped send button produces one message
 *   - SMS is never reported as sent when no provider is configured
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  roles,
  rolePermissions,
  userRoles,
  academicYears,
  terms,
  gradeLevels,
  sections,
  subjects,
  sectionSubjects,
  schoolSettings,
} from '../src/db/schema/core.ts';
import { students, enrollments, guardians, studentGuardians, staff } from '../src/db/schema/people.ts';
import {
  announcements,
  announcementReads,
  messageThreads,
  messageParticipants,
  messages,
  notifications,
  smsMessages,
  notificationTemplates,
} from '../src/db/schema/comms.ts';
import { AuthError } from '../src/lib/auth/context.ts';
import {
  createAnnouncement,
  listVisibleAnnouncements,
  getAnnouncement,
  markAnnouncementRead,
  countUnreadAnnouncements,
  updateAnnouncement,
  CommsError,
} from '../src/lib/comms/announcements.ts';
import {
  listContacts,
  createThread,
  sendMessage,
  getThread,
  listThreads,
  countUnreadMessages,
} from '../src/lib/comms/messages.ts';
import {
  createNotifications,
  listNotifications,
  countUnread,
  markNotificationsRead,
  resolveStudentAudience,
  notifyAboutStudent,
} from '../src/lib/notifications/service.ts';
import { renderTemplate, DEFAULT_TEMPLATES } from '../src/lib/notifications/templates.ts';
import { queueSms, checkSmsAvailability, getSmsSummary } from '../src/lib/sms/service.ts';
import {
  registerSmsProvider,
  clearSmsProviders,
  resolveSmsAvailability,
} from '../src/lib/sms/provider.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';
import { emitEvent, clearHandlers } from '../src/lib/events/index.ts';
import { registerNotificationHandlers } from '../src/lib/notifications/handlers.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  termId: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
  subjectId: string;
  ssMathA: string;
  adminUserId: string;
  teacherAUserId: string;
  teacherBUserId: string;
  parentUserId: string;
  parent2UserId: string;
  studentUserId: string;
  guardianId: string;
  guardian2Id: string;
  childOne: string;
  childTwo: string;
  strangerStudent: string;
};

const A = {} as Fixture;
const B = {} as Fixture;

const STAFF_PERMS = ['school.view', 'student.view', 'message.send', 'announcement.view'];
const TEACHER_PERMS = ['message.send', 'announcement.view', 'announcement.create', 'grade.enter'];
const PARENT_PERMS = ['portal.parent', 'message.send', 'announcement.view'];

function makeContext(
  fixture: Fixture,
  userId: string,
  permissions: string[],
  relationships: {
    childStudentIds?: string[];
    ownStudentId?: string | null;
    guardianId?: string | null;
    sectionIds?: string[];
    sectionSubjectIds?: string[];
  },
) {
  return {
    db,
    schoolId: fixture.schoolId,
    user: { userId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    locale: 'en',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    require: (p: string) => {
      if (!permissions.includes(p)) throw new AuthError(`Missing permission: ${p}`, 403);
    },
    requireAny: (...list: string[]) => {
      if (!list.some((p) => permissions.includes(p))) {
        throw new AuthError('Missing permission', 403);
      }
    },
    requireModule: async () => {},
    canViewStudent: async (studentId: string) => {
      const rel = relationships.childStudentIds ?? [];
      if (rel.includes(studentId)) return true;
      if (relationships.ownStudentId === studentId) return true;
      if (permissions.includes('student.view')) {
        const [row] = await db
          .select({ id: students.id })
          .from(students)
          .where(and(eq(students.schoolId, fixture.schoolId), eq(students.id, studentId)))
          .limit(1);
        return Boolean(row);
      }
      return false;
    },
    displayName: () => 'Test User',
    relationships: {
      sectionIds: relationships.sectionIds ?? [],
      sectionSubjectIds: relationships.sectionSubjectIds ?? [],
      childStudentIds: relationships.childStudentIds ?? [],
      ownStudentId: relationships.ownStudentId ?? null,
      guardianId: relationships.guardianId ?? null,
    },
  } as never;
}

async function makeUser(
  schoolId: string,
  username: string,
  givenName: string,
  locale = 'en',
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      schoolId,
      username,
      givenName,
      fatherName: 'Test',
      passwordHash: 'x',
      locale,
      isActive: true,
    })
    .returning({ id: users.id });
  return row!.id;
}

async function seedSchool(code: string, fixture: Fixture) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `Comms ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values({
    schoolId: fixture.schoolId,
    key: 'notifications',
    value: {
      channels: { inApp: true, sms: false, email: false, push: false },
      events: {
        attendanceAbsent: true,
        attendanceRisk: true,
        gradePublished: true,
        reportCardPublished: true,
        paymentRecorded: true,
        feeDue: true,
        homeworkAssigned: false,
        announcement: true,
      },
      quietHoursStart: '21:00',
      quietHoursEnd: '06:30',
      sms: { provider: 'none', senderId: '', apiKeyRef: '', endpoint: '', isEnabled: false },
    },
  });
  invalidateSettingsCache(fixture.schoolId, 'notifications');

  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId: fixture.schoolId,
      name: '2018 E.C.',
      ethiopianYear: 2018,
      startDate: '2025-09-11',
      endDate: '2026-07-07',
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  fixture.yearId = year!.id;

  const [term] = await db
    .insert(terms)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      name: 'Term 1',
      sequence: 1,
      startDate: '2025-09-11',
      endDate: '2025-12-20',
      isCurrent: true,
    })
    .returning({ id: terms.id });
  fixture.termId = term!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  // Users
  fixture.adminUserId = await makeUser(fixture.schoolId, `${code}-admin`, 'Admin');
  fixture.teacherAUserId = await makeUser(fixture.schoolId, `${code}-teacherA`, 'TeacherA');
  fixture.teacherBUserId = await makeUser(fixture.schoolId, `${code}-teacherB`, 'TeacherB');
  fixture.parentUserId = await makeUser(fixture.schoolId, `${code}-parent`, 'Parent');
  fixture.parent2UserId = await makeUser(fixture.schoolId, `${code}-parent2`, 'Parent2', 'am');
  fixture.studentUserId = await makeUser(fixture.schoolId, `${code}-student`, 'Pupil');

  // Staff records so contact resolution can find them.
  await db.insert(staff).values([
    {
      schoolId: fixture.schoolId,
      userId: fixture.teacherAUserId,
      staffCode: `${code}-T1`,
      staffType: 'teaching',
      jobTitle: 'Teacher',
    },
    {
      schoolId: fixture.schoolId,
      userId: fixture.teacherBUserId,
      staffCode: `${code}-T2`,
      staffType: 'teaching',
      jobTitle: 'Teacher',
    },
    {
      schoolId: fixture.schoolId,
      userId: fixture.adminUserId,
      staffCode: `${code}-A1`,
      staffType: 'admin',
      jobTitle: 'Registrar',
    },
  ]);

  // The registrar role carries student.view, which is how "office staff" is
  // identified for parents — by permission, not by job title.
  const [officeRole] = await db
    .insert(roles)
    .values({
      schoolId: fixture.schoolId,
      key: 'registrar',
      name: 'Registrar',
      nameAm: 'መዝጋቢ',
      description: 'Front office',
      isSystem: true,
    })
    .returning({ id: roles.id });
  await db
    .insert(rolePermissions)
    .values({ roleId: officeRole!.id, permission: 'student.view' });
  await db.insert(userRoles).values({ userId: fixture.adminUserId, roleId: officeRole!.id });

  const [sectionA] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: '5A',
      classTeacherId: fixture.teacherAUserId,
    })
    .returning({ id: sections.id });
  fixture.sectionA = sectionA!.id;

  const [sectionB] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: '5B',
      classTeacherId: fixture.teacherBUserId,
    })
    .returning({ id: sections.id });
  fixture.sectionB = sectionB!.id;

  const [subject] = await db
    .insert(subjects)
    .values({ schoolId: fixture.schoolId, code: 'MATH', name: 'Mathematics' })
    .returning({ id: subjects.id });
  fixture.subjectId = subject!.id;

  const [ss] = await db
    .insert(sectionSubjects)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      sectionId: fixture.sectionA,
      subjectId: fixture.subjectId,
      teacherId: fixture.teacherAUserId,
    })
    .returning({ id: sectionSubjects.id });
  fixture.ssMathA = ss!.id;

  // Pupils: two siblings in 5A, one stranger in 5B.
  const pupilRows = await db
    .insert(students)
    .values([
      {
        schoolId: fixture.schoolId,
        studentCode: `${code}-S1`,
        givenName: 'Abel',
        fatherName: 'Bekele',
        userId: fixture.studentUserId,
      },
      {
        schoolId: fixture.schoolId,
        studentCode: `${code}-S2`,
        givenName: 'Bilen',
        fatherName: 'Bekele',
      },
      {
        schoolId: fixture.schoolId,
        studentCode: `${code}-S3`,
        givenName: 'Chala',
        fatherName: 'Dereje',
      },
    ])
    .returning({ id: students.id });

  fixture.childOne = pupilRows[0]!.id;
  fixture.childTwo = pupilRows[1]!.id;
  fixture.strangerStudent = pupilRows[2]!.id;

  await db.insert(enrollments).values([
    {
      schoolId: fixture.schoolId,
      studentId: fixture.childOne,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: fixture.sectionA,
      enrolledOn: '2025-09-11',
      status: 'enrolled',
    },
    {
      schoolId: fixture.schoolId,
      studentId: fixture.childTwo,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: fixture.sectionA,
      enrolledOn: '2025-09-11',
      status: 'enrolled',
    },
    {
      schoolId: fixture.schoolId,
      studentId: fixture.strangerStudent,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: fixture.sectionB,
      enrolledOn: '2025-09-11',
      status: 'enrolled',
    },
  ]);

  const [guardian] = await db
    .insert(guardians)
    .values({
      schoolId: fixture.schoolId,
      givenName: 'Tesfaye',
      fatherName: 'Worku',
      phone: '+251911234567',
      userId: fixture.parentUserId,
    })
    .returning({ id: guardians.id });
  fixture.guardianId = guardian!.id;

  const [guardian2] = await db
    .insert(guardians)
    .values({
      schoolId: fixture.schoolId,
      givenName: 'Almaz',
      fatherName: 'Dereje',
      phone: '+251922334455',
      userId: fixture.parent2UserId,
    })
    .returning({ id: guardians.id });
  fixture.guardian2Id = guardian2!.id;

  await db.insert(studentGuardians).values([
    {
      schoolId: fixture.schoolId,
      studentId: fixture.childOne,
      guardianId: fixture.guardianId,
      relationship: 'father',
      isPrimary: true,
    },
    {
      schoolId: fixture.schoolId,
      studentId: fixture.childTwo,
      guardianId: fixture.guardianId,
      relationship: 'father',
      isPrimary: true,
    },
    {
      schoolId: fixture.schoolId,
      studentId: fixture.strangerStudent,
      guardianId: fixture.guardian2Id,
      relationship: 'mother',
      isPrimary: true,
    },
  ]);
}

before(async () => {
  db = await getDb();
  clearHandlers();
  clearSmsProviders();
  await seedSchool(`cmA-${Date.now().toString(36)}`, A);
  await seedSchool(`cmB-${Date.now().toString(36)}`, B);
});

after(async () => {
  clearHandlers();
  clearSmsProviders();
  await closeDb();
});

// ---------------------------------------------------------------------------
// Announcements — audience targeting
// ---------------------------------------------------------------------------

test('an admin can publish a school-wide announcement', async () => {
  const ctx = makeContext(A, A.adminUserId, [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'], {});

  const result = await createAnnouncement(ctx, {
    title: 'School closed Friday',
    body: 'The school will be closed on Friday for a public holiday.',
    audience: 'everyone',
    sectionIds: [],
    gradeLevelIds: [],
    isPinned: true,
    publish: true,
    sendSms: false,
  });

  assert.ok(result.id, 'should return the new id');

  const visible = await listVisibleAnnouncements(ctx);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.title, 'School closed Friday');
  assert.equal(visible[0]!.isPinned, true);
});

test('a parent sees a school-wide announcement', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const visible = await listVisibleAnnouncements(parent);
  assert.equal(visible.length, 1, 'the whole-school notice reaches parents');
});

test('a teacher cannot broadcast to the whole school', async () => {
  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await assert.rejects(
    () =>
      createAnnouncement(teacher, {
        title: 'Everyone read this',
        body: 'Broadcast attempt',
        audience: 'everyone',
        sectionIds: [],
        gradeLevelIds: [],
        isPinned: false,
        publish: true,
        sendSms: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 403);
      return true;
    },
    'a teacher without publishSchoolWide must be refused',
  );
});

test('a teacher cannot address a class they do not teach', async () => {
  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await assert.rejects(
    () =>
      createAnnouncement(teacher, {
        title: 'Not my class',
        body: 'Attempt to reach 5B',
        audience: 'section',
        sectionIds: [A.sectionB],
        gradeLevelIds: [],
        isPinned: false,
        publish: true,
        sendSms: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 403);
      return true;
    },
  );
});

test('a teacher can address their own class, and its parents see it', async () => {
  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await createAnnouncement(teacher, {
    title: 'Maths test on Monday',
    body: 'Please revise chapters 3 and 4.',
    audience: 'section',
    sectionIds: [A.sectionA],
    gradeLevelIds: [],
    isPinned: false,
    publish: true,
    sendSms: false,
  });

  const parentOfA = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });
  const titles = (await listVisibleAnnouncements(parentOfA)).map((a) => a.title);
  assert.ok(titles.includes('Maths test on Monday'), '5A parent should see the class notice');

  const parentOfB = makeContext(A, A.parent2UserId, PARENT_PERMS, {
    guardianId: A.guardian2Id,
    childStudentIds: [A.strangerStudent],
  });
  const otherTitles = (await listVisibleAnnouncements(parentOfB)).map((a) => a.title);
  assert.ok(
    !otherTitles.includes('Maths test on Monday'),
    '5B parent must NOT see a 5A class notice',
  );
  assert.ok(
    otherTitles.includes('School closed Friday'),
    'but should still see the whole-school notice',
  );
});

test('an unpublished draft is invisible to its audience', async () => {
  const admin = makeContext(A, A.adminUserId, [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'], {});

  await createAnnouncement(admin, {
    title: 'Draft notice',
    body: 'Not ready yet.',
    audience: 'everyone',
    sectionIds: [],
    gradeLevelIds: [],
    isPinned: false,
    publish: false,
    sendSms: false,
  });

  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });
  const titles = (await listVisibleAnnouncements(parent)).map((a) => a.title);
  assert.ok(!titles.includes('Draft notice'), 'a draft must not be visible');
});

test('an announcement from another school is never visible', async () => {
  const adminB = makeContext(B, B.adminUserId, [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'], {});
  const other = await createAnnouncement(adminB, {
    title: 'School B only',
    body: 'Internal to school B.',
    audience: 'everyone',
    sectionIds: [],
    gradeLevelIds: [],
    isPinned: false,
    publish: true,
    sendSms: false,
  });

  const parentA = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const titles = (await listVisibleAnnouncements(parentA)).map((a) => a.title);
  assert.ok(!titles.includes('School B only'), 'cross-school announcement must not appear');

  // Even naming the id directly must fail, with a 404 rather than a 403.
  await assert.rejects(
    () => getAnnouncement(parentA, other.id),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404, 'must be 404, not 403');
      return true;
    },
  );
});

test('read state is per user and idempotent', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const before = await countUnreadAnnouncements(parent);
  assert.ok(before >= 2, 'parent starts with unread notices');

  const list = await listVisibleAnnouncements(parent);
  await markAnnouncementRead(parent, list[0]!.id);
  await markAnnouncementRead(parent, list[0]!.id); // twice on purpose

  const after = await countUnreadAnnouncements(parent);
  assert.equal(after, before - 1, 'reading twice still only counts once');

  // The other parent's unread count is untouched.
  const parent2 = makeContext(A, A.parent2UserId, PARENT_PERMS, {
    guardianId: A.guardian2Id,
    childStudentIds: [A.strangerStudent],
  });
  const otherUnread = await countUnreadAnnouncements(parent2);
  assert.ok(otherUnread > 0, "one user's read state must not affect another's");
});

test('an empty or oversized announcement is rejected', async () => {
  const admin = makeContext(A, A.adminUserId, [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'], {});
  const { createAnnouncementSchema } = await import('../src/lib/comms/schema.ts');

  assert.equal(
    createAnnouncementSchema.safeParse({ title: '   ', body: 'x', audience: 'everyone' }).success,
    false,
    'a blank title must fail validation',
  );
  assert.equal(
    createAnnouncementSchema.safeParse({ title: 'x', body: '', audience: 'everyone' }).success,
    false,
    'an empty body must fail validation',
  );
  assert.equal(
    createAnnouncementSchema.safeParse({
      title: 'x',
      body: 'y',
      audience: 'section',
      sectionIds: [],
    }).success,
    false,
    'a section announcement with no section must fail',
  );
  assert.equal(
    createAnnouncementSchema.safeParse({ title: 'x'.repeat(300), body: 'y', audience: 'everyone' })
      .success,
    false,
    'an over-long title must fail',
  );

  // And the database refuses a blank title even if validation were bypassed.
  await assert.rejects(
    () =>
      db.insert(announcements).values({
        schoolId: A.schoolId,
        title: '   ',
        body: 'bypass attempt',
      }),
    'the CHECK constraint is the backstop',
  );
  void admin;
});

// ---------------------------------------------------------------------------
// Messaging — who may talk to whom
// ---------------------------------------------------------------------------

test("a teacher's contacts are the parents and pupils of their own classes", async () => {
  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  const contacts = await listContacts(teacher);
  const ids = contacts.map((c) => c.userId);

  assert.ok(ids.includes(A.parentUserId), '5A parent is a contact');
  assert.ok(ids.includes(A.studentUserId), '5A pupil is a contact');
  assert.ok(
    !ids.includes(A.parent2UserId),
    'a parent from a class this teacher does not teach must NOT be a contact',
  );
  assert.ok(!ids.includes(A.teacherAUserId), 'a user is never their own contact');
});

test('a parent may reach their child\u2019s teachers and the office, but not other parents', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const contacts = await listContacts(parent);
  const ids = contacts.map((c) => c.userId);

  assert.ok(ids.includes(A.teacherAUserId), "the child's class teacher is reachable");
  assert.ok(ids.includes(A.adminUserId), 'office staff are reachable');
  assert.ok(
    !ids.includes(A.parent2UserId),
    'another parent must NEVER be reachable',
  );
  assert.ok(
    !ids.includes(A.teacherBUserId),
    'a teacher who does not teach this child is not reachable',
  );
});

test('starting a thread with a non-contact is refused with 404', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  await assert.rejects(
    () =>
      createThread(parent, {
        subject: 'Hello',
        body: 'Trying to reach another parent',
        recipientUserIds: [A.parent2UserId],
      }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404, 'must be 404, not 403');
      return true;
    },
  );
});

test('a thread cannot be started with a user from another school', async () => {
  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await assert.rejects(
    () =>
      createThread(teacher, {
        subject: 'Cross-tenant',
        body: 'Should never arrive',
        recipientUserIds: [B.parentUserId],
      }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
  );
});

test('a parent and teacher can hold a conversation', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const thread = await createThread(parent, {
    subject: 'About Abel\u2019s reading',
    body: 'Could we discuss his progress?',
    recipientUserIds: [A.teacherAUserId],
    studentId: A.childOne,
  });

  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  const detail = await getThread(teacher, thread.id);
  assert.equal(detail.subject, 'About Abel\u2019s reading');
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0]!.isMine, false, 'the parent wrote it, not the teacher');
  assert.equal(detail.studentId, A.childOne);

  await sendMessage(teacher, { threadId: thread.id, body: 'Yes, let us meet on Thursday.' });

  const afterReply = await getThread(parent, thread.id);
  assert.equal(afterReply.messages.length, 2);
  assert.equal(afterReply.messages[1]!.isMine, false, 'the teacher wrote the reply');
});

test('a non-participant cannot read a thread, even a teacher in the same school', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const thread = await createThread(parent, {
    subject: 'Private matter',
    body: 'A confidential note about my child.',
    recipientUserIds: [A.teacherAUserId],
  });

  // Teacher B holds message.send and is a legitimate teacher — but is not in
  // this conversation. A role must not admit them.
  const teacherB = makeContext(A, A.teacherBUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionB],
  });

  await assert.rejects(
    () => getThread(teacherB, thread.id),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404, 'must be 404, not 403');
      return true;
    },
    'membership, not role, grants access',
  );

  await assert.rejects(
    () => sendMessage(teacherB, { threadId: thread.id, body: 'Intruding' }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
    'nor may a non-participant post',
  );

  // Even a school admin with broad permissions is not silently a participant.
  const admin = makeContext(A, A.adminUserId, [...STAFF_PERMS, 'school.manage'], {});
  await assert.rejects(
    () => getThread(admin, thread.id),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
    'a broad permission set is still not membership',
  );
});

test('a thread from another school is not readable with a valid id', async () => {
  const parentB = makeContext(B, B.parentUserId, PARENT_PERMS, {
    guardianId: B.guardianId,
    childStudentIds: [B.childOne, B.childTwo],
  });

  const threadB = await createThread(parentB, {
    subject: 'School B conversation',
    body: 'Internal to B.',
    recipientUserIds: [B.teacherAUserId],
  });

  const teacherA = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await assert.rejects(
    () => getThread(teacherA, threadB.id),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
  );
});

test('a thread may only concern a student the sender can see', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  await assert.rejects(
    () =>
      createThread(parent, {
        subject: 'About another family\u2019s child',
        body: 'Should be refused',
        recipientUserIds: [A.teacherAUserId],
        studentId: A.strangerStudent,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
  );
});

test('a double-tapped send produces one message, not two', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });

  const thread = await createThread(parent, {
    subject: 'Duplicate test',
    body: 'First message',
    recipientUserIds: [A.teacherAUserId],
  });

  const first = await sendMessage(parent, { threadId: thread.id, body: 'Same text' });
  const second = await sendMessage(parent, { threadId: thread.id, body: 'Same text' });

  assert.equal(second.duplicate, true, 'the repeat is recognised');
  assert.equal(second.id, first.id, 'and returns the original message');

  const detail = await getThread(parent, thread.id);
  const sameText = detail.messages.filter((m) => m.body === 'Same text');
  assert.equal(sameText.length, 1, 'only one copy is stored');
});

test('an empty message is rejected by validation and by the database', async () => {
  const { sendMessageSchema } = await import('../src/lib/comms/schema.ts');

  assert.equal(sendMessageSchema.safeParse({ threadId: 'x', body: '   ' }).success, false);
  assert.equal(sendMessageSchema.safeParse({ threadId: 'x', body: '' }).success, false);
  assert.equal(
    sendMessageSchema.safeParse({ threadId: 'x', body: 'y'.repeat(3000) }).success,
    false,
    'an oversized message is refused',
  );

  const [thread] = await db
    .insert(messageThreads)
    .values({ schoolId: A.schoolId, subject: 'ck', createdBy: A.adminUserId })
    .returning({ id: messageThreads.id });

  await assert.rejects(
    () =>
      db.insert(messages).values({
        schoolId: A.schoolId,
        threadId: thread!.id,
        senderId: A.adminUserId,
        body: '  ',
      }),
    'the CHECK constraint refuses a blank body',
  );
});

test('unread message counts are per participant', async () => {
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne, A.childTwo],
  });
  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  const thread = await createThread(parent, {
    subject: 'Counting',
    body: 'Message one',
    recipientUserIds: [A.teacherAUserId],
  });

  const teacherUnread = await countUnreadMessages(teacher);
  assert.ok(teacherUnread > 0, 'the recipient has an unread message');

  // The sender does not have their own message as unread.
  const threads = await listThreads(parent);
  const own = threads.find((t) => t.id === thread.id);
  assert.equal(own?.unreadCount, 0, 'your own message is not unread to you');

  // Reading it clears the count.
  await getThread(teacher, thread.id);
  const afterRead = await listThreads(teacher);
  const readThread = afterRead.find((t) => t.id === thread.id);
  assert.equal(readThread?.unreadCount, 0, 'opening the thread marks it read');
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test('the audience for a student is their guardians plus the pupil', async () => {
  const audience = await resolveStudentAudience(db, A.schoolId, A.childOne);
  const ids = audience.map((a) => a.userId);

  assert.ok(ids.includes(A.parentUserId), 'the guardian is notified');
  assert.ok(ids.includes(A.studentUserId), 'the pupil is notified');
  assert.ok(!ids.includes(A.parent2UserId), 'an unrelated guardian is not');

  const withoutStudent = await resolveStudentAudience(db, A.schoolId, A.childOne, {
    includeStudent: false,
  });
  assert.ok(
    !withoutStudent.map((a) => a.userId).includes(A.studentUserId),
    'the pupil can be excluded',
  );
});

test('a guardian of two children is not notified twice for one event', async () => {
  const audience = await resolveStudentAudience(db, A.schoolId, A.childTwo);
  const parentEntries = audience.filter((a) => a.userId === A.parentUserId);
  assert.equal(parentEntries.length, 1);
});

test('duplicate notifications are suppressed by the dedupe key', async () => {
  const first = await createNotifications(db, A.schoolId, [
    {
      userId: A.parentUserId,
      type: 'attendance.absent',
      title: 'Absent',
      body: 'Abel was absent',
      dedupeKey: 'absent:test:2025-10-01',
    },
  ]);
  assert.equal(first.created, 1);

  const second = await createNotifications(db, A.schoolId, [
    {
      userId: A.parentUserId,
      type: 'attendance.absent',
      title: 'Absent',
      body: 'Abel was absent',
      dedupeKey: 'absent:test:2025-10-01',
    },
  ]);
  assert.equal(second.created, 0, 'the retry creates nothing');
  assert.equal(second.skipped, 1);

  // A different key is a genuinely different fact and still gets through.
  const third = await createNotifications(db, A.schoolId, [
    {
      userId: A.parentUserId,
      type: 'attendance.absent',
      title: 'Absent',
      body: 'Abel was absent again',
      dedupeKey: 'absent:test:2025-10-02',
    },
  ]);
  assert.equal(third.created, 1);
});

test('a user only ever reads their own notifications', async () => {
  await createNotifications(db, A.schoolId, [
    {
      userId: A.parent2UserId,
      type: 'message',
      title: 'For parent two only',
      body: 'private',
    },
  ]);

  const mine = await listNotifications(db, A.schoolId, A.parentUserId);
  assert.ok(
    !mine.some((n) => n.title === 'For parent two only'),
    "another user's notification is never listed",
  );
});

test('marking another user\u2019s notification read does nothing', async () => {
  const [theirs] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.schoolId, A.schoolId),
        eq(notifications.userId, A.parent2UserId),
        eq(notifications.title, 'For parent two only'),
      ),
    )
    .limit(1);

  const updated = await markNotificationsRead(db, A.schoolId, A.parentUserId, [theirs!.id]);
  assert.equal(updated, 0, 'a forged id updates nothing');

  const [after] = await db
    .select({ readAt: notifications.readAt })
    .from(notifications)
    .where(eq(notifications.id, theirs!.id));
  assert.equal(after!.readAt, null, "and their notification is still unread");
});

test('marking all read clears only the caller\u2019s unread notifications', async () => {
  const beforeMine = await countUnread(db, A.schoolId, A.parentUserId);
  assert.ok(beforeMine > 0);
  const beforeTheirs = await countUnread(db, A.schoolId, A.parent2UserId);

  await markNotificationsRead(db, A.schoolId, A.parentUserId);

  assert.equal(await countUnread(db, A.schoolId, A.parentUserId), 0);
  assert.equal(
    await countUnread(db, A.schoolId, A.parent2UserId),
    beforeTheirs,
    "another user's unread count is untouched",
  );
});

test('an explicit empty id list marks nothing', async () => {
  await createNotifications(db, A.schoolId, [
    { userId: A.parentUserId, type: 'message', title: 'Fresh', body: 'unread' },
  ]);
  const before = await countUnread(db, A.schoolId, A.parentUserId);
  const updated = await markNotificationsRead(db, A.schoolId, A.parentUserId, []);
  assert.equal(updated, 0);
  assert.equal(await countUnread(db, A.schoolId, A.parentUserId), before);
});

test('notifications never cross a school boundary', async () => {
  await assert.rejects(
    () =>
      db.insert(notifications).values({
        schoolId: A.schoolId,
        userId: B.parentUserId,
        type: 'message',
        title: 'Cross tenant',
        body: 'should be impossible',
      }),
    'the composite foreign key refuses a foreign user',
  );
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('every default template has English and Amharic text', () => {
  for (const [key, text] of Object.entries(DEFAULT_TEMPLATES)) {
    assert.ok(text.titleEn.trim().length > 0, `${key} needs an English title`);
    assert.ok(text.bodyEn.trim().length > 0, `${key} needs English text`);
    assert.ok(text.titleAm.trim().length > 0, `${key} needs an Amharic title`);
    assert.ok(text.bodyAm.trim().length > 0, `${key} needs Amharic text`);
  }
});

test('Amharic templates contain Ethiopic script and matching placeholders', () => {
  const ethiopic = /[\u1200-\u137F]/;
  const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');

  for (const [key, text] of Object.entries(DEFAULT_TEMPLATES)) {
    // A title that is nothing but a placeholder has no words to translate.
    if (!/^\{[\w]+\}$/.test(text.titleAm)) {
      assert.ok(ethiopic.test(text.titleAm), `${key} Amharic title should be in Ethiopic`);
    }
    if (!/^\{[\w]+\}$/.test(text.bodyAm)) {
      assert.ok(ethiopic.test(text.bodyAm), `${key} Amharic body should be in Ethiopic`);
    }
    assert.equal(
      placeholders(text.bodyAm),
      placeholders(text.bodyEn),
      `${key} placeholders must match between languages`,
    );
  }
});

test('a template renders in the recipient\u2019s language', async () => {
  const en = await renderTemplate(db, A.schoolId, 'attendance.absent', 'inApp', 'en', {
    studentName: 'Abel Bekele',
    date: '2025-10-01',
  });
  assert.ok(en.body.includes('Abel Bekele'));
  assert.ok(en.body.includes('2025-10-01'));
  assert.ok(!/[\u1200-\u137F]/.test(en.body), 'English render has no Ethiopic');

  const am = await renderTemplate(db, A.schoolId, 'attendance.absent', 'inApp', 'am', {
    studentName: 'Abel Bekele',
    date: '2025-10-01',
  });
  assert.ok(/[\u1200-\u137F]/.test(am.body), 'Amharic render is in Ethiopic');
  assert.ok(am.body.includes('Abel Bekele'), 'and still interpolates the name');
});

test('a school override replaces the built-in wording', async () => {
  await db.insert(notificationTemplates).values({
    schoolId: A.schoolId,
    type: 'attendance.absent',
    channel: 'inApp',
    titleEn: 'Custom absence title',
    titleAm: '\u1265\u1301 \u122d\u12d5\u1235',
    // Keeps {date} so the school's own wording stays as informative as the
    // built-in text — and so later tests can still assert on the date.
    bodyEn: 'Our own words about {studentName} on {date}.',
    bodyAm: '\u1235\u1208 {studentName} \u1260{date} \u12e8\u122b\u1233\u127d\u1295 \u1243\u120b\u1275\u1362',
    isActive: true,
  });

  const rendered = await renderTemplate(db, A.schoolId, 'attendance.absent', 'inApp', 'en', {
    studentName: 'Abel Bekele',
    date: '2025-10-01',
  });
  assert.equal(rendered.title, 'Custom absence title');
  assert.ok(rendered.body.startsWith('Our own words about Abel Bekele'));

  // School B, which set no override, still gets the default.
  const other = await renderTemplate(db, B.schoolId, 'attendance.absent', 'inApp', 'en', {
    studentName: 'Someone Else',
    date: '2025-10-01',
  });
  assert.equal(other.title, 'Absent today', 'an override is scoped to its own school');
});

// ---------------------------------------------------------------------------
// SMS — honesty about delivery
// ---------------------------------------------------------------------------

test('with no provider configured, nothing is reported as sent', async () => {
  const availability = await checkSmsAvailability(db, A.schoolId);
  assert.equal(availability.available, false);
  assert.equal(
    availability.available === false ? availability.reason : null,
    'no-provider',
  );

  const result = await queueSms(db, A.schoolId, [
    { to: '+251911234567', body: 'Test message', relatedType: 'test' },
  ]);

  assert.equal(result.sent, 0, 'nothing was sent');
  assert.equal(result.unconfigured, 1, 'and it is recorded as unconfigured');
  assert.equal(result.failed, 0, 'which is NOT the same as failed');

  const [row] = await db
    .select({ status: smsMessages.status, provider: smsMessages.provider })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, A.schoolId), eq(smsMessages.relatedType, 'test')))
    .limit(1);
  assert.equal(row!.status, 'unconfigured');
  assert.equal(row!.provider, null);
});

test('the database refuses to mark a message sent with no provider', async () => {
  await assert.rejects(
    () =>
      db.insert(smsMessages).values({
        schoolId: A.schoolId,
        toPhone: '+251911234567',
        body: 'Claiming to be sent',
        status: 'sent',
      }),
    'a sent message must name its provider',
  );
});

test('an invalid phone number is counted, not silently dropped', async () => {
  const result = await queueSms(db, A.schoolId, [
    { to: 'not-a-number', body: 'x' },
    { to: '', body: 'y' },
    { to: '+251911234567', body: 'z', relatedType: 'valid-check' },
  ]);

  assert.equal(result.invalidNumbers, 2, 'both bad numbers are reported');
  assert.equal(result.unconfigured, 1, 'the valid one is still recorded');
});

test('availability distinguishes no-provider, disabled and not-implemented', () => {
  const nothing = resolveSmsAvailability(null);
  assert.equal(nothing.available, false);
  assert.equal(nothing.available === false ? nothing.reason : null, 'no-provider');

  const none = resolveSmsAvailability({ provider: 'none', isEnabled: false });
  assert.equal(none.available === false ? none.reason : null, 'no-provider');

  const disabled = resolveSmsAvailability({ provider: 'geezsms', isEnabled: false });
  assert.equal(disabled.available, false);
  assert.equal(disabled.available === false ? disabled.reason : null, 'disabled');

  const missing = resolveSmsAvailability({ provider: 'geezsms', isEnabled: true });
  assert.equal(missing.available, false);
  assert.equal(
    missing.available === false ? missing.reason : null,
    'not-implemented',
    'a configured but uninstalled provider is not silently treated as working',
  );
});

test('a registered provider is used, and its result is recorded truthfully', async () => {
  const attempts: { to: string; body: string }[] = [];
  registerSmsProvider({
    key: 'testprovider',
    label: 'Test Provider',
    async send(request) {
      attempts.push(request);
      if (request.to.endsWith('0000')) {
        return { ok: false, error: 'Unreachable number' };
      }
      return { ok: true, providerRef: `ref-${attempts.length}` };
    },
  });

  await db
    .update(schoolSettings)
    .set({
      value: {
        channels: { inApp: true, sms: true, email: false, push: false },
        events: {
          attendanceAbsent: true,
          attendanceRisk: true,
          gradePublished: true,
          reportCardPublished: true,
          paymentRecorded: true,
          feeDue: true,
          homeworkAssigned: false,
          announcement: true,
        },
        quietHoursStart: '21:00',
        quietHoursEnd: '06:30',
        sms: {
          provider: 'testprovider',
          senderId: 'SCHOOL',
          apiKeyRef: 'SMS_KEY',
          endpoint: '',
          isEnabled: true,
        },
      },
    })
    .where(and(eq(schoolSettings.schoolId, A.schoolId), eq(schoolSettings.key, 'notifications')));
  invalidateSettingsCache(A.schoolId, 'notifications');

  const result = await queueSms(db, A.schoolId, [
    { to: '+251911111111', body: 'Should send', relatedType: 'provider-test' },
    { to: '+251910000000', body: 'Should fail', relatedType: 'provider-test' },
  ]);

  assert.equal(result.sent, 1, 'one accepted');
  assert.equal(result.failed, 1, 'one rejected');
  assert.equal(attempts.length, 2, 'the provider was actually called');

  const rows = await db
    .select({
      status: smsMessages.status,
      provider: smsMessages.provider,
      providerRef: smsMessages.providerRef,
      error: smsMessages.error,
      sentAt: smsMessages.sentAt,
    })
    .from(smsMessages)
    .where(
      and(eq(smsMessages.schoolId, A.schoolId), eq(smsMessages.relatedType, 'provider-test')),
    );

  const sent = rows.find((r) => r.status === 'sent');
  const failed = rows.find((r) => r.status === 'failed');

  assert.ok(sent, 'a sent row exists');
  assert.equal(sent!.provider, 'testprovider');
  assert.ok(sent!.providerRef, 'and carries the provider reference');
  assert.ok(sent!.sentAt, 'and a send timestamp');

  assert.ok(failed, 'a failed row exists');
  assert.equal(failed!.error, 'Unreachable number', 'with the real reason');
  assert.equal(failed!.sentAt, null, 'and no send timestamp');
});

test('a provider that throws is recorded as failed, not sent', async () => {
  registerSmsProvider({
    key: 'testprovider',
    label: 'Test Provider',
    async send() {
      throw new Error('Gateway timeout');
    },
  });

  const result = await queueSms(db, A.schoolId, [
    { to: '+251912222222', body: 'x', relatedType: 'throw-test' },
  ]);

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1, 'a thrown provider error does not become a success');

  const [row] = await db
    .select({ status: smsMessages.status, error: smsMessages.error })
    .from(smsMessages)
    .where(and(eq(smsMessages.schoolId, A.schoolId), eq(smsMessages.relatedType, 'throw-test')))
    .limit(1);
  assert.equal(row!.status, 'failed');
  assert.ok(row!.error?.includes('Gateway timeout'));
});

test('the outbox summary reports each status separately', async () => {
  const summary = await getSmsSummary(db, A.schoolId);
  const byStatus = Object.fromEntries(summary.map((s) => [s.status, s.count]));

  assert.ok((byStatus.unconfigured ?? 0) > 0, 'unconfigured messages are visible');
  assert.ok((byStatus.sent ?? 0) > 0);
  assert.ok((byStatus.failed ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// Event-driven automation
// ---------------------------------------------------------------------------

test('an attendance event notifies guardians without attendance importing this module', async () => {
  clearHandlers();
  registerNotificationHandlers();

  // Turn SMS back off so this test observes the in-app path alone.
  await db
    .update(schoolSettings)
    .set({
      value: {
        channels: { inApp: true, sms: false, email: false, push: false },
        events: {
          attendanceAbsent: true,
          attendanceRisk: true,
          gradePublished: true,
          reportCardPublished: true,
          paymentRecorded: true,
          feeDue: true,
          homeworkAssigned: false,
          announcement: true,
        },
        quietHoursStart: '21:00',
        quietHoursEnd: '06:30',
        sms: { provider: 'none', senderId: '', apiKeyRef: '', endpoint: '', isEnabled: false },
      },
    })
    .where(and(eq(schoolSettings.schoolId, A.schoolId), eq(schoolSettings.key, 'notifications')));
  invalidateSettingsCache(A.schoolId, 'notifications');

  await emitEvent(db, A.schoolId, 'attendance.recorded', {
    sectionId: A.sectionA,
    subjectId: null,
    date: '2025-11-04',
    recordedBy: A.teacherAUserId,
    absentStudentIds: [A.childOne],
    lateStudentIds: [A.childTwo],
    totalStudents: 2,
  });

  const parentNotifications = await listNotifications(db, A.schoolId, A.parentUserId, {
    limit: 50,
  });

  const absent = parentNotifications.find(
    (n) => n.type === 'attendance.absent' && n.body.includes('2025-11-04'),
  );
  const late = parentNotifications.find(
    (n) => n.type === 'attendance.late' && n.body.includes('2025-11-04'),
  );

  assert.ok(absent, 'the guardian was told about the absence');
  assert.ok(late, 'and about the late arrival of the other child');
  assert.ok(absent!.body.includes('Abel'), 'naming the right child');
  assert.ok(late!.body.includes('Bilen'));
  assert.equal(absent!.studentId, A.childOne, 'and linked to that child');
});

test('replaying the same attendance event does not notify twice', async () => {
  const before = (await listNotifications(db, A.schoolId, A.parentUserId, { limit: 100 })).filter(
    (n) => n.type === 'attendance.absent' && n.body.includes('2025-11-04'),
  ).length;

  await emitEvent(db, A.schoolId, 'attendance.recorded', {
    sectionId: A.sectionA,
    subjectId: null,
    date: '2025-11-04',
    recordedBy: A.teacherAUserId,
    absentStudentIds: [A.childOne],
    lateStudentIds: [],
    totalStudents: 2,
  });

  const after = (await listNotifications(db, A.schoolId, A.parentUserId, { limit: 100 })).filter(
    (n) => n.type === 'attendance.absent' && n.body.includes('2025-11-04'),
  ).length;

  assert.equal(after, before, 'a replayed event is idempotent');
});

test('a school that switches absence alerts off receives none', async () => {
  await db
    .update(schoolSettings)
    .set({
      value: {
        channels: { inApp: true, sms: false, email: false, push: false },
        events: {
          attendanceAbsent: false,
          attendanceRisk: true,
          gradePublished: true,
          reportCardPublished: true,
          paymentRecorded: true,
          feeDue: true,
          homeworkAssigned: false,
          announcement: true,
        },
        quietHoursStart: '21:00',
        quietHoursEnd: '06:30',
        sms: { provider: 'none', senderId: '', apiKeyRef: '', endpoint: '', isEnabled: false },
      },
    })
    .where(and(eq(schoolSettings.schoolId, B.schoolId), eq(schoolSettings.key, 'notifications')));
  invalidateSettingsCache(B.schoolId, 'notifications');

  await emitEvent(db, B.schoolId, 'attendance.recorded', {
    sectionId: B.sectionA,
    subjectId: null,
    date: '2025-11-05',
    recordedBy: B.teacherAUserId,
    absentStudentIds: [B.childOne],
    lateStudentIds: [],
    totalStudents: 1,
  });

  const parentNotifications = await listNotifications(db, B.schoolId, B.parentUserId, {
    limit: 50,
  });
  const absences = parentNotifications.filter((n) => n.type === 'attendance.absent');
  assert.equal(absences.length, 0, 'configuration, not code, decides');
});

test('a failing handler does not prevent the others or roll back the action', async () => {
  const { registerHandler, getHandlers } = await import('../src/lib/events/index.ts');

  let goodRan = false;
  registerHandler({
    name: 'test.throwing',
    event: 'student.statusChanged',
    async handle() {
      throw new Error('deliberate failure');
    },
  });
  registerHandler({
    name: 'test.good',
    event: 'student.statusChanged',
    async handle() {
      goodRan = true;
    },
  });

  assert.equal(getHandlers('student.statusChanged').length, 2);

  await emitEvent(db, A.schoolId, 'student.statusChanged', {
    studentId: A.childOne,
    from: 'active',
    to: 'transferred',
  });

  assert.equal(goodRan, true, 'a sibling handler still runs after one throws');
});

test('publishing an announcement notifies its resolved audience', async () => {
  clearHandlers();
  registerNotificationHandlers();

  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await createAnnouncement(teacher, {
    title: 'Class outing on Friday',
    body: 'We will visit the museum. Please send 50 birr.',
    audience: 'section',
    sectionIds: [A.sectionA],
    gradeLevelIds: [],
    isPinned: false,
    publish: true,
    sendSms: false,
  });

  const parentNotifications = await listNotifications(db, A.schoolId, A.parentUserId, {
    limit: 50,
  });
  const notice = parentNotifications.find((n) => n.type === 'announcement');
  assert.ok(notice, 'the 5A parent was notified');
  assert.ok(notice!.title.includes('Class outing'), 'with the announcement title');

  // The 5B parent is not in the audience.
  const otherNotifications = await listNotifications(db, A.schoolId, A.parent2UserId, {
    limit: 50,
  });
  assert.ok(
    !otherNotifications.some((n) => n.title.includes('Class outing')),
    'a parent outside the audience is not notified',
  );
});

test('an Amharic-reading recipient is notified in Amharic', async () => {
  await notifyAboutStudent(db, A.schoolId, {
    studentId: A.strangerStudent,
    type: 'attendance.absent',
    values: { studentName: 'Chala Dereje', date: '2025-11-06' },
    dedupeKey: 'locale-test',
    includeStudent: false,
  });

  const list = await listNotifications(db, A.schoolId, A.parent2UserId, { limit: 20 });
  const notice = list.find((n) => n.body.includes('2025-11-06'));

  assert.ok(notice, 'the Amharic-locale parent was notified');
  assert.ok(
    /[\u1200-\u137F]/.test(notice!.body),
    'and the text is in Amharic, because their profile says so',
  );
});

// ---------------------------------------------------------------------------
// Draft workflow
// ---------------------------------------------------------------------------

test('publishing a draft later notifies the audience then, not before', async () => {
  clearHandlers();
  registerNotificationHandlers();

  const admin = makeContext(
    A,
    A.adminUserId,
    [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'],
    {},
  );

  const draft = await createAnnouncement(admin, {
    title: 'Sports day',
    body: 'Details to follow.',
    audience: 'everyone',
    sectionIds: [],
    gradeLevelIds: [],
    isPinned: false,
    publish: false,
    sendSms: false,
  });

  const beforePublish = (
    await listNotifications(db, A.schoolId, A.parentUserId, { limit: 100 })
  ).filter((n) => n.title.includes('Sports day')).length;
  assert.equal(beforePublish, 0, 'a draft notifies nobody');

  await updateAnnouncement(admin, draft.id, { publish: true });

  const afterPublish = (
    await listNotifications(db, A.schoolId, A.parentUserId, { limit: 100 })
  ).filter((n) => n.title.includes('Sports day')).length;
  assert.equal(afterPublish, 1, 'publishing notifies the audience');
});

test('a teacher cannot edit another author\u2019s announcement', async () => {
  const admin = makeContext(
    A,
    A.adminUserId,
    [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'],
    {},
  );
  const mine = await createAnnouncement(admin, {
    title: 'Admin only notice',
    body: 'Written by the office.',
    audience: 'everyone',
    sectionIds: [],
    gradeLevelIds: [],
    isPinned: false,
    publish: true,
    sendSms: false,
  });

  const teacher = makeContext(A, A.teacherAUserId, TEACHER_PERMS, {
    sectionIds: [A.sectionA],
    sectionSubjectIds: [A.ssMathA],
  });

  await assert.rejects(
    () => updateAnnouncement(teacher, mine.id, { title: 'Hijacked' }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
  );
});

test('an announcement cannot be edited across a school boundary', async () => {
  const adminB = makeContext(
    B,
    B.adminUserId,
    [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'],
    {},
  );
  const theirs = await createAnnouncement(adminB, {
    title: 'B internal',
    body: 'Only for B.',
    audience: 'everyone',
    sectionIds: [],
    gradeLevelIds: [],
    isPinned: false,
    publish: true,
    sendSms: false,
  });

  const adminA = makeContext(
    A,
    A.adminUserId,
    [...STAFF_PERMS, 'announcement.create', 'school.manage', 'announcement.publishSchoolWide'],
    {},
  );

  await assert.rejects(
    () => updateAnnouncement(adminA, theirs.id, { title: 'Tampered' }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal((error as CommsError).status, 404);
      return true;
    },
  );

  const [unchanged] = await db
    .select({ title: announcements.title })
    .from(announcements)
    .where(eq(announcements.id, theirs.id));
  assert.equal(unchanged!.title, 'B internal', 'and the row is untouched');
});

test('permissions are required, not merely checked in the UI', async () => {
  const noPerms = makeContext(A, A.parentUserId, ['portal.parent'], {
    guardianId: A.guardianId,
    childStudentIds: [A.childOne],
  });

  await assert.rejects(
    () =>
      createAnnouncement(noPerms, {
        title: 'Should fail',
        body: 'No permission',
        audience: 'everyone',
        sectionIds: [],
        gradeLevelIds: [],
        isPinned: false,
        publish: true,
        sendSms: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError, 'announcement.create is enforced server-side');
      return true;
    },
  );

  await assert.rejects(
    () =>
      createThread(noPerms, {
        subject: 'Should fail',
        body: 'No permission',
        recipientUserIds: [A.teacherAUserId],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError, 'message.send is enforced server-side');
      return true;
    },
  );
});
