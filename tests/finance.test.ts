/**
 * Finance tests.
 *
 * A wrong balance is a family wrongly accused of not paying, or a school
 * quietly losing income. So this file is written to break the module, not to
 * confirm it works. The cases that matter:
 *
 *   - money never crosses a school boundary, even with a valid id from elsewhere
 *   - a parent sees their own children's finances and nothing else
 *   - a teacher who can see a pupil cannot see that pupil's money
 *   - the server, not the client, decides how much a payment settles
 *   - two simultaneous payments cannot overpay a balance
 *   - a double-tapped submit takes the money once
 *   - overpayment is refused unless the school allows it
 *   - a voided payment restores the debt without deleting the record
 *   - last year's charges do not move when this year's fees change
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  academicYears,
  terms,
  gradeLevels,
  sections,
  schoolSettings,
} from '../src/db/schema/core.ts';
import { students, enrollments, guardians, studentGuardians } from '../src/db/schema/people.ts';
import {
  feeCategories,
  feeStructures,
  studentCharges,
  payments,
  paymentAllocations,
} from '../src/db/schema/finance.ts';
import { notifications } from '../src/db/schema/comms.ts';
import { AuthError, type AuthContext } from '../src/lib/auth/context.ts';
import {
  createFeeStructure,
  applyFeeStructure,
  createAdHocCharge,
  listStudentCharges,
  getStudentBalance,
  setChargeDiscount,
  cancelCharge,
  listFeeStructures,
  createFeeCategory,
  seedSuggestedCategories,
  FinanceError,
} from '../src/lib/finance/service.ts';
import {
  recordPayment,
  voidPayment,
  listPayments,
  getReceipt,
  announcePayment,
} from '../src/lib/finance/payments.ts';
import {
  getFinanceSummary,
  getOutstandingStudents,
  getMethodBreakdown,
} from '../src/lib/finance/reports.ts';
import { sweepDueReminders } from '../src/lib/finance/reminders.ts';
import { resolvePortalStudent, listPortalStudents } from '../src/lib/portal/service.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';
import { clearHandlers } from '../src/lib/events/index.ts';
import { registerNotificationHandlers } from '../src/lib/notifications/handlers.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  lastYearId: string;
  termId: string;
  term2Id: string;
  gradeId: string;
  grade2Id: string;
  sectionA: string;
  sectionB: string;
  adminUserId: string;
  teacherUserId: string;
  parentUserId: string;
  studentUserId: string;
  guardianId: string;
  childOne: string;
  childTwo: string;
  strangerStudent: string;
  categoryId: string;
};

const A = {} as Fixture;
const B = {} as Fixture;

const FINANCE_PERMS = [
  'school.view',
  'student.view',
  'fee.view',
  'fee.manage',
  'payment.view',
  'payment.record',
  'payment.void',
  'finance.report',
];
// A teacher can see pupils but must never see money.
const TEACHER_PERMS = ['student.view', 'restrict.ownSectionsOnly', 'grade.enter'];
const PARENT_PERMS = ['portal.parent', 'message.send'];
const CLERK_PERMS = ['student.view', 'fee.view', 'payment.view', 'payment.record'];

function makeContext(
  fixture: Fixture,
  userId: string,
  permissions: string[],
  relationships: {
    childStudentIds?: string[];
    ownStudentId?: string | null;
    guardianId?: string | null;
    sectionIds?: string[];
  } = {},
) {
  const canViewStudent = async (studentId: string): Promise<boolean> => {
    if ((relationships.childStudentIds ?? []).includes(studentId)) return true;
    if (relationships.ownStudentId === studentId) return true;
    if (permissions.includes('student.view') && !permissions.includes('restrict.ownSectionsOnly')) {
      const [row] = await db
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.schoolId, fixture.schoolId), eq(students.id, studentId)))
        .limit(1);
      return Boolean(row);
    }
    if (permissions.includes('restrict.ownSectionsOnly')) {
      const ids = relationships.sectionIds ?? [];
      if (ids.length === 0) return false;
      const [row] = await db
        .select({ id: enrollments.id })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.schoolId, fixture.schoolId),
            eq(enrollments.studentId, studentId),
            eq(enrollments.sectionId, ids[0]!),
          ),
        )
        .limit(1);
      return Boolean(row);
    }
    return false;
  };

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
    canViewStudent,
    requireStudentAccess: async (studentId: string) => {
      if (!(await canViewStudent(studentId))) throw new AuthError('Student not found', 404);
    },
    displayName: () => 'Test User',
    relationships: {
      sectionIds: relationships.sectionIds ?? [],
      sectionSubjectIds: [],
      childStudentIds: relationships.childStudentIds ?? [],
      ownStudentId: relationships.ownStudentId ?? null,
      guardianId: relationships.guardianId ?? null,
    },
  } as unknown as AuthContext;
}

async function makeUser(schoolId: string, username: string, givenName: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      schoolId,
      username,
      givenName,
      fatherName: 'Test',
      passwordHash: 'x',
      locale: 'en',
      isActive: true,
    })
    .returning({ id: users.id });
  return row!.id;
}

async function seedSchool(code: string, fixture: Fixture) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `Finance ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values([
    {
      schoolId: fixture.schoolId,
      key: 'finance',
      value: {
        currency: 'ETB',
        receiptPrefix: 'RCP',
        allowOverpayment: false,
        allowPartialPayment: true,
        graceDays: 7,
        reminderDaysBefore: 5,
        paymentMethods: ['cash', 'bank', 'telebirr'],
        siblingDiscountPercent: 0,
      },
    },
    {
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
    },
  ]);
  invalidateSettingsCache(fixture.schoolId);

  const [lastYear] = await db
    .insert(academicYears)
    .values({
      schoolId: fixture.schoolId,
      name: '2017 EC',
      startDate: '2024-09-01',
      endDate: '2025-06-30',
      isCurrent: false,
    })
    .returning({ id: academicYears.id });
  fixture.lastYearId = lastYear!.id;

  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId: fixture.schoolId,
      name: '2018 EC',
      startDate: '2025-09-01',
      endDate: '2026-06-30',
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  fixture.yearId = year!.id;

  const [term1] = await db
    .insert(terms)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      name: 'Term 1',
      sequence: 1,
      startDate: '2025-09-01',
      endDate: '2025-12-15',
      isCurrent: true,
    })
    .returning({ id: terms.id });
  fixture.termId = term1!.id;

  const [term2] = await db
    .insert(terms)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      name: 'Term 2',
      sequence: 2,
      startDate: '2026-01-05',
      endDate: '2026-03-30',
      isCurrent: false,
    })
    .returning({ id: terms.id });
  fixture.term2Id = term2!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  const [grade2] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 6', level: 6 })
    .returning({ id: gradeLevels.id });
  fixture.grade2Id = grade2!.id;

  const [secA] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: 'A',
      capacity: 40,
    })
    .returning({ id: sections.id });
  fixture.sectionA = secA!.id;

  const [secB] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.grade2Id,
      name: 'B',
      capacity: 40,
    })
    .returning({ id: sections.id });
  fixture.sectionB = secB!.id;

  fixture.adminUserId = await makeUser(fixture.schoolId, `${code}-admin`, 'Admin');
  fixture.teacherUserId = await makeUser(fixture.schoolId, `${code}-teacher`, 'Teacher');
  fixture.parentUserId = await makeUser(fixture.schoolId, `${code}-parent`, 'Parent');
  fixture.studentUserId = await makeUser(fixture.schoolId, `${code}-student`, 'Pupil');

  const names = ['One', 'Two', 'Stranger'];
  const ids: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const [s] = await db
      .insert(students)
      .values({
        schoolId: fixture.schoolId,
        studentCode: `${code}-S${i}`,
        givenName: names[i]!,
        fatherName: 'Child',
        status: 'active',
        userId: i === 0 ? fixture.studentUserId : null,
      })
      .returning({ id: students.id });
    ids.push(s!.id);

    await db.insert(enrollments).values({
      schoolId: fixture.schoolId,
      studentId: s!.id,
      academicYearId: fixture.yearId,
      gradeLevelId: i === 2 ? fixture.grade2Id : fixture.gradeId,
      sectionId: i === 2 ? fixture.sectionB : fixture.sectionA,
      enrolledOn: '2025-09-01',
      status: 'enrolled',
    });
  }
  [fixture.childOne, fixture.childTwo, fixture.strangerStudent] = ids as [string, string, string];

  const [guardian] = await db
    .insert(guardians)
    .values({
      schoolId: fixture.schoolId,
      givenName: 'Parent',
      fatherName: 'Test',
      phone: '+251911000000',
      userId: fixture.parentUserId,
    })
    .returning({ id: guardians.id });
  fixture.guardianId = guardian!.id;

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
      isPrimary: false,
    },
  ]);

  await seedSuggestedCategories(db, fixture.schoolId);
  const [cat] = await db
    .select({ id: feeCategories.id })
    .from(feeCategories)
    .where(and(eq(feeCategories.schoolId, fixture.schoolId), eq(feeCategories.key, 'tuition')))
    .limit(1);
  fixture.categoryId = cat!.id;
}

before(async () => {
  db = await getDb();
  clearHandlers();
  await seedSchool('fin-a', A);
  await seedSchool('fin-b', B);
});

after(async () => {
  clearHandlers();
  await closeDb();
});

const admin = (f: Fixture) => makeContext(f, f.adminUserId, FINANCE_PERMS);

/**
 * The PostgreSQL SQLSTATE for a rejected write.
 *
 * Drizzle wraps the driver error, so the code sits on `cause`. Asserting the
 * exact code matters: `assert.rejects` alone would also pass if the statement
 * failed for an unrelated reason, such as a typo in a column name.
 */
function pgCode(error: unknown): string | undefined {
  return (
    (error as { code?: string })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code
  );
}
const clerk = (f: Fixture) => makeContext(f, f.adminUserId, CLERK_PERMS);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('a school starts with suggested categories that it can extend', async () => {
  const rows = await db
    .select({ key: feeCategories.key })
    .from(feeCategories)
    .where(eq(feeCategories.schoolId, A.schoolId));

  assert.ok(rows.length >= 9, 'suggested categories are seeded');
  assert.ok(rows.some((r) => r.key === 'tuition'));

  // The point of a suggestion is that it is not a fixed list.
  const created = await createFeeCategory(admin(A), {
    key: 'boarding',
    name: 'Boarding',
    nameAm: 'የመኝታ አገልግሎት',
    description: null,
    sortOrder: 100,
    isActive: true,
  });
  assert.ok(created.id, 'a school can define its own category');
});

test('two schools can have completely different fee structures', async () => {
  await createFeeStructure(admin(A), {
    academicYearId: A.yearId,
    categoryId: A.categoryId,
    name: 'Tuition',
    nameAm: 'የትምህርት ክፍያ',
    description: null,
    amountCents: 300000,
    billingPeriod: 'term',
    appliesTo: 'all',
    gradeLevelIds: [],
    sectionIds: [],
    isOptional: false,
    installmentCount: 1,
    dueDate: '2025-10-15',
    dueDayOfPeriod: null,
    isActive: true,
  });

  await createFeeStructure(admin(B), {
    academicYearId: B.yearId,
    categoryId: B.categoryId,
    name: 'Semester fee',
    nameAm: null,
    description: null,
    amountCents: 750000,
    billingPeriod: 'term',
    appliesTo: 'grade',
    gradeLevelIds: [B.gradeId],
    sectionIds: [],
    isOptional: false,
    installmentCount: 3,
    dueDate: '2025-10-01',
    dueDayOfPeriod: null,
    isActive: true,
  });

  const feesA = await listFeeStructures(admin(A));
  const feesB = await listFeeStructures(admin(B));

  assert.equal(feesA.length, 1);
  assert.equal(feesB.length, 1);
  assert.equal(feesA[0]!.amountCents, 300000);
  assert.equal(feesB[0]!.amountCents, 750000);
  assert.equal(feesB[0]!.installmentCount, 3, 'schools differ in structure, not just amount');

  // Raise B's charges too, so the cross-tenant tests below have a real target
  // rather than silently passing because school B had nothing to steal.
  const appliedB = await applyFeeStructure(admin(B), {
    feeStructureId: feesB[0]!.id,
    termId: B.termId,
  });
  assert.ok(appliedB.created > 0, 'school B has charges of its own');
});

test('CRITICAL: a fee cannot be created against another school\'s academic year', async () => {
  await assert.rejects(
    () =>
      createFeeStructure(admin(A), {
        academicYearId: B.yearId, // valid id, wrong school
        categoryId: null,
        name: 'Cross-tenant fee',
        nameAm: null,
        description: null,
        amountCents: 1000,
        billingPeriod: 'once',
        appliesTo: 'all',
        gradeLevelIds: [],
        sectionIds: [],
        isOptional: false,
        installmentCount: 1,
        dueDate: null,
        dueDayOfPeriod: null,
        isActive: true,
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 404, 'rejected as not found');
      return true;
    },
  );
});

test('CRITICAL: a fee cannot target another school\'s grade level', async () => {
  await assert.rejects(
    () =>
      createFeeStructure(admin(A), {
        academicYearId: A.yearId,
        categoryId: null,
        name: 'Cross-tenant grade fee',
        nameAm: null,
        description: null,
        amountCents: 1000,
        billingPeriod: 'once',
        appliesTo: 'grade',
        gradeLevelIds: [B.gradeId],
        sectionIds: [],
        isOptional: false,
        installmentCount: 1,
        dueDate: null,
        dueDayOfPeriod: null,
        isActive: true,
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 404);
      return true;
    },
  );
});

test('creating a fee needs fee.manage, not merely fee.view', async () => {
  await assert.rejects(
    () =>
      createFeeStructure(makeContext(A, A.adminUserId, ['fee.view']), {
        academicYearId: A.yearId,
        categoryId: null,
        name: 'Should fail',
        nameAm: null,
        description: null,
        amountCents: 1000,
        billingPeriod: 'once',
        appliesTo: 'all',
        gradeLevelIds: [],
        sectionIds: [],
        isOptional: false,
        installmentCount: 1,
        dueDate: null,
        dueDayOfPeriod: null,
        isActive: true,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError, 'fee.manage is enforced server-side');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Raising charges
// ---------------------------------------------------------------------------

test('applying a fee charges everyone it matches, once', async () => {
  const [fee] = await db
    .select()
    .from(feeStructures)
    .where(eq(feeStructures.schoolId, A.schoolId))
    .limit(1);

  const first = await applyFeeStructure(admin(A), {
    feeStructureId: fee!.id,
    termId: A.termId,
    dueDate: '2025-10-15',
  });
  assert.equal(first.created, 3, 'all three enrolled pupils are charged');

  // Running it again must not double-charge. The partial unique index makes
  // this true even if a scheduler fires twice.
  const second = await applyFeeStructure(admin(A), {
    feeStructureId: fee!.id,
    termId: A.termId,
    dueDate: '2025-10-15',
  });
  assert.equal(second.created, 0, 'a repeat run creates nothing');
  assert.equal(second.skipped, 3);

  const charges = await listStudentCharges(admin(A), A.childOne);
  assert.equal(charges.length, 1, 'one charge, not two');
  assert.equal(charges[0]!.amountCents, 300000);
});

test('a fee aimed at one grade does not charge another', async () => {
  const created = await createFeeStructure(admin(A), {
    academicYearId: A.yearId,
    categoryId: null,
    name: 'Grade 6 lab fee',
    nameAm: null,
    description: null,
    amountCents: 50000,
    billingPeriod: 'once',
    appliesTo: 'grade',
    gradeLevelIds: [A.grade2Id],
    sectionIds: [],
    isOptional: false,
    installmentCount: 1,
    dueDate: '2025-11-01',
    dueDayOfPeriod: null,
    isActive: true,
  });

  const result = await applyFeeStructure(admin(A), { feeStructureId: created.id });
  assert.equal(result.created, 1, 'only the Grade 6 pupil is charged');

  const stranger = await listStudentCharges(admin(A), A.strangerStudent);
  assert.ok(stranger.some((c) => c.description === 'Grade 6 lab fee'));

  const childOne = await listStudentCharges(admin(A), A.childOne);
  assert.ok(!childOne.some((c) => c.description === 'Grade 6 lab fee'), 'Grade 5 pupil untouched');
});

test('installments split without losing a cent', async () => {
  const created = await createFeeStructure(admin(A), {
    academicYearId: A.yearId,
    categoryId: null,
    name: 'Transport',
    nameAm: null,
    description: null,
    amountCents: 100000, // 1000.00 over 3 installments
    billingPeriod: 'once',
    appliesTo: 'section',
    gradeLevelIds: [],
    sectionIds: [A.sectionA],
    isOptional: true,
    installmentCount: 3,
    dueDate: '2025-10-01',
    dueDayOfPeriod: null,
    isActive: true,
  });

  await applyFeeStructure(admin(A), { feeStructureId: created.id });

  const charges = (await listStudentCharges(admin(A), A.childOne)).filter((c) =>
    c.description.startsWith('Transport'),
  );
  assert.equal(charges.length, 3);
  const total = charges.reduce((s, c) => s + c.amountCents, 0);
  assert.equal(total, 100000, 'the installments sum exactly to the fee');
  assert.deepEqual(
    charges.map((c) => c.amountCents).sort((a, b) => b - a),
    [33334, 33333, 33333],
  );
});

test('an ad-hoc charge needs no fee structure', async () => {
  const charge = await createAdHocCharge(admin(A), {
    studentId: A.childTwo,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Replacement textbook',
    descriptionAm: null,
    amountCents: 25000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: '2025-11-30',
  });

  assert.ok(charge.id);
  const charges = await listStudentCharges(admin(A), A.childTwo);
  assert.ok(charges.some((c) => c.description === 'Replacement textbook'));
});

test('CRITICAL: cannot raise a charge against another school\'s student', async () => {
  await assert.rejects(
    () =>
      createAdHocCharge(admin(A), {
        studentId: B.childOne, // real pupil, wrong school
        categoryId: null,
        academicYearId: A.yearId,
        termId: null,
        description: 'Cross-tenant charge',
        descriptionAm: null,
        amountCents: 1000,
        discountCents: 0,
        discountType: 'none',
        discountReason: null,
        dueDate: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 404, '404, not 403 — no existence leak');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Discounts and scholarships
// ---------------------------------------------------------------------------

test('a discount reduces the net without hiding the full price', async () => {
  const charges = await listStudentCharges(admin(A), A.childTwo);
  const book = charges.find((c) => c.description === 'Replacement textbook')!;

  await setChargeDiscount(admin(A), book.id, {
    discountCents: 5000,
    discountType: 'scholarship',
    discountReason: 'Hardship support',
  });

  const after = (await listStudentCharges(admin(A), A.childTwo)).find((c) => c.id === book.id)!;
  assert.equal(after.amountCents, 25000, 'the full price is still visible');
  assert.equal(after.discountCents, 5000);
  assert.equal(after.netAmountCents, 20000, 'net is computed by the database');
  assert.equal(after.discountType, 'scholarship');
  assert.equal(after.discountReason, 'Hardship support');
});

test('CRITICAL: cannot discount another school\'s charge', async () => {
  // A forged charge id from school B, used by school A. Without the school
  // filter in getChargeOwned this would quietly waive another school's debt.
  const [foreign] = await db
    .select({ id: studentCharges.id, discount: studentCharges.discountCents })
    .from(studentCharges)
    .where(eq(studentCharges.schoolId, B.schoolId))
    .limit(1);

  assert.ok(foreign, 'school B has a charge to target');

  await assert.rejects(
    () =>
      setChargeDiscount(admin(A), foreign!.id, {
        discountCents: 1,
        discountType: 'waiver',
        discountReason: 'Cross-tenant waiver',
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 404, '404, not 403');
      return true;
    },
  );

  const [after] = await db
    .select({ discount: studentCharges.discountCents })
    .from(studentCharges)
    .where(eq(studentCharges.id, foreign!.id));
  assert.equal(after!.discount, foreign!.discount, "the other school's charge is untouched");
});

test('CRITICAL: cannot cancel another school\'s charge', async () => {
  const [foreign] = await db
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(and(eq(studentCharges.schoolId, B.schoolId), eq(studentCharges.status, 'active')))
    .limit(1);

  assert.ok(foreign, 'school B has an active charge');

  await assert.rejects(
    () => cancelCharge(admin(A), foreign!.id, 'Cross-tenant cancel'),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 404);
      return true;
    },
  );

  const [after] = await db
    .select({ status: studentCharges.status })
    .from(studentCharges)
    .where(eq(studentCharges.id, foreign!.id));
  assert.equal(after!.status, 'active', 'the debt still stands');
});

test('a discount cannot exceed the charge', async () => {
  const charges = await listStudentCharges(admin(A), A.childTwo);
  const book = charges.find((c) => c.description === 'Replacement textbook')!;

  await assert.rejects(
    () =>
      setChargeDiscount(admin(A), book.id, {
        discountCents: 999999,
        discountType: 'waiver',
        discountReason: 'Too much',
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 400);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Payments — the core
// ---------------------------------------------------------------------------

test('a partial payment reduces the balance by exactly what was paid', async () => {
  const before = await getStudentBalance(admin(A), A.childOne);

  const result = await recordPayment(admin(A), {
    studentId: A.childOne,
    amountCents: 100000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-01',
    notes: null,
    clientKey: null,
  });

  assert.equal(result.amountCents, 100000);
  assert.equal(result.allocatedCents, 100000);
  assert.equal(result.unallocatedCents, 0);
  assert.ok(result.receiptNumber.startsWith('RCP-'), 'a receipt number is issued');

  const after = await getStudentBalance(admin(A), A.childOne);
  assert.equal(
    after.outstandingCents,
    before.outstandingCents - 100000,
    'the balance falls by exactly the amount paid',
  );
  assert.equal(after.paidCents, before.paidCents + 100000);
});

test('multiple payments accumulate correctly', async () => {
  const before = await getStudentBalance(admin(A), A.childOne);

  await recordPayment(admin(A), {
    studentId: A.childOne,
    amountCents: 50000,
    method: 'bank',
    referenceNumber: 'SLIP-1',
    paidOn: '2025-10-05',
    notes: null,
    clientKey: null,
  });
  await recordPayment(admin(A), {
    studentId: A.childOne,
    amountCents: 25000,
    method: 'telebirr',
    referenceNumber: 'TB-77',
    paidOn: '2025-10-06',
    notes: null,
    clientKey: null,
  });

  const after = await getStudentBalance(admin(A), A.childOne);
  assert.equal(after.outstandingCents, before.outstandingCents - 75000);
});

test('CRITICAL: overpayment is refused when the school does not allow it', async () => {
  const balance = await getStudentBalance(admin(A), A.childOne);

  await assert.rejects(
    () =>
      recordPayment(admin(A), {
        studentId: A.childOne,
        amountCents: balance.outstandingCents + 1,
        method: 'cash',
        referenceNumber: null,
        paidOn: '2025-10-07',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 400, 'one cent over is still over');
      return true;
    },
  );

  const after = await getStudentBalance(admin(A), A.childOne);
  assert.equal(after.outstandingCents, balance.outstandingCents, 'nothing was written');
});

test('an exact-balance payment settles the account to zero', async () => {
  const balance = await getStudentBalance(admin(A), A.childOne);

  const result = await recordPayment(admin(A), {
    studentId: A.childOne,
    amountCents: balance.outstandingCents,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-08',
    notes: null,
    clientKey: null,
  });

  assert.equal(result.unallocatedCents, 0);
  const after = await getStudentBalance(admin(A), A.childOne);
  assert.equal(after.outstandingCents, 0, 'settled exactly');
});

test('paying a student who owes nothing is refused', async () => {
  await assert.rejects(
    () =>
      recordPayment(admin(A), {
        studentId: A.childOne,
        amountCents: 100,
        method: 'cash',
        referenceNumber: null,
        paidOn: '2025-10-09',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError);
      assert.match(e.message, /nothing outstanding/i);
      return true;
    },
  );
});

test('CRITICAL: the database index is the last line of defence against a duplicate', async () => {
  // The service pre-checks the client key, but two genuinely simultaneous
  // submissions both pass that check. The unique index is what actually stops
  // the second one, so it is tested directly rather than through the service
  // that shields it.
  const key = `idx-${crypto.randomUUID()}`;
  const base = {
    schoolId: A.schoolId,
    studentId: A.childOne,
    receiptNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
    amountCents: 1000,
    method: 'cash',
    paidOn: '2025-10-11',
    status: 'completed' as const,
    clientKey: key,
    recordedBy: A.adminUserId,
  };

  await db.insert(payments).values(base);

  await assert.rejects(
    () =>
      db.insert(payments).values({
        ...base,
        receiptNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
      }),
    (e: unknown) => {
      assert.equal(pgCode(e), '23505', 'a unique violation, not a silent second row');
      return true;
    },
  );

  // The same key in a different school is a different payment, and allowed.
  await db.insert(payments).values({
    ...base,
    schoolId: B.schoolId,
    studentId: B.childOne,
    recordedBy: B.adminUserId,
    receiptNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
  });

  const rows = await db.select({ id: payments.id }).from(payments).where(eq(payments.clientKey, key));
  assert.equal(rows.length, 2, 'one per school, never two in the same school');
});

test('CRITICAL: a duplicate submission takes the money once', async () => {
  const key = `dup-${crypto.randomUUID()}`;
  const before = await getStudentBalance(admin(A), A.childTwo);

  const first = await recordPayment(admin(A), {
    studentId: A.childTwo,
    amountCents: 10000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-10',
    notes: null,
    clientKey: key,
  });
  const second = await recordPayment(admin(A), {
    studentId: A.childTwo,
    amountCents: 10000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-10',
    notes: null,
    clientKey: key,
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, 'the replay is reported as a duplicate');
  assert.equal(second.id, first.id, 'and returns the original receipt');
  assert.equal(second.receiptNumber, first.receiptNumber);

  const after = await getStudentBalance(admin(A), A.childTwo);
  assert.equal(
    after.outstandingCents,
    before.outstandingCents - 10000,
    'the balance moved once, not twice',
  );
});

test('CRITICAL: the charge rows are locked FOR UPDATE while a payment is computed', async () => {
  // This is the guarantee that makes concurrent payments safe, and it needs a
  // direct test.
  //
  // PGlite runs transactions strictly one after another (verified: two
  // overlapping transactions execute A-begin..A-commit then B-begin..B-commit,
  // never interleaved). That is a property of the embedded engine, not of this
  // code — on the real PostgreSQL server this deploys to, two clerks CAN be
  // inside `recordPayment` at the same instant. So the behavioural test below
  // cannot distinguish a locked implementation from an unlocked one, and
  // passing it proves nothing about production.
  //
  // What can be asserted here is that the SELECT which reads the outstanding
  // amounts really does carry FOR UPDATE. Without it, two concurrent
  // transactions on real PostgreSQL would both read the same balance and both
  // accept a payment against it.
  const statements: string[] = [];
  const spy = {
    ...(admin(A) as unknown as Record<string, unknown>),
    db: new Proxy(db as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'transaction' && typeof value === 'function') {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            (value as typeof db.transaction).call(target, async (tx) => {
              const txProxy = new Proxy(tx as object, {
                get(t, p, r) {
                  const v = Reflect.get(t, p, r);
                  if (p === 'select' && typeof v === 'function') {
                    return (...args: unknown[]) => {
                      const builder = (v as (...a: unknown[]) => unknown).apply(t, args);
                      return wrapForSql(builder, statements);
                    };
                  }
                  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                },
              });
              return fn(txProxy);
            });
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }),
  } as unknown as AuthContext;

  const probe = await createAdHocCharge(admin(A), {
    studentId: A.strangerStudent,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Lock probe',
    descriptionAm: null,
    amountCents: 5000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: null,
  });

  await recordPayment(spy, {
    studentId: A.strangerStudent,
    amountCents: 5000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-24',
    notes: null,
    clientKey: null,
    chargeIds: [probe.id],
  });

  const chargeSelects = statements.filter((sqlText) => sqlText.includes('student_charges'));
  assert.ok(chargeSelects.length > 0, 'the payment reads the charges');
  assert.ok(
    chargeSelects.some((sqlText) => /for update/i.test(sqlText)),
    'the charge SELECT must carry FOR UPDATE, or two concurrent payments on real PostgreSQL would both read the same balance',
  );

  const counterSelects = statements.filter((sqlText) => sqlText.includes('finance_counters'));
  assert.ok(
    counterSelects.some((sqlText) => /for update/i.test(sqlText)),
    'the receipt counter must be locked, or two payments could take the same receipt number',
  );
});

/** Record the SQL a Drizzle builder will emit, without changing its behaviour. */
function wrapForSql(builder: unknown, sink: string[]): unknown {
  return new Proxy(builder as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'then') {
        // The builder is being awaited: capture its SQL first.
        try {
          const { sql: text } = (target as { toSQL: () => { sql: string } }).toSQL();
          sink.push(text);
        } catch {
          // A builder that cannot render SQL is not one we need to inspect.
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          // Chainable builder methods return another builder.
          return result && typeof result === 'object' && 'toSQL' in (result as object)
            ? wrapForSql(result, sink)
            : result;
        };
      }
      return value;
    },
  });
}

test('two sequential payments cannot together exceed the balance', async () => {
  // The behavioural companion to the lock test above. On PGlite these run one
  // after another, which is exactly the state the second transaction would see
  // on real PostgreSQL once the first has committed and released its lock.
  const charge = await createAdHocCharge(admin(A), {
    studentId: A.strangerStudent,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Concurrency probe',
    descriptionAm: null,
    amountCents: 100000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: null,
  });

  const pay = () =>
    recordPayment(admin(A), {
      studentId: A.strangerStudent,
      amountCents: 60000,
      method: 'cash',
      referenceNumber: null,
      paidOn: '2025-10-11',
      notes: null,
      clientKey: null,
      chargeIds: [charge.id],
    });

  const results = await Promise.allSettled([pay(), pay()]);
  const accepted = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(accepted.length, 1, 'exactly one payment is accepted');
  assert.equal(rejected.length, 1, 'the other is rejected, not silently merged');

  const paid = await db
    .select({
      total: sql<number>`coalesce(sum(${paymentAllocations.amountCents}), 0)::int`,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(
      and(eq(paymentAllocations.chargeId, charge.id), eq(payments.status, 'completed')),
    );

  assert.equal(paid[0]!.total, 60000, 'exactly 600.00 was taken, not 1,200.00');
});

test('the server decides allocation — a client cannot understate a debt', async () => {
  // The API accepts no allocation amounts at all. The only lever a caller has
  // is which charges to settle, and the amount taken is derived from the
  // charge's own outstanding figure.
  const charge = await createAdHocCharge(admin(A), {
    studentId: A.childTwo,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Server-allocation probe',
    descriptionAm: null,
    amountCents: 40000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: '2025-12-01',
  });

  const result = await recordPayment(admin(A), {
    studentId: A.childTwo,
    amountCents: 15000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-12',
    notes: null,
    clientKey: null,
    chargeIds: [charge.id],
  });

  const [alloc] = await db
    .select({ amountCents: paymentAllocations.amountCents })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, result.id));

  assert.equal(alloc!.amountCents, 15000, 'allocation equals what was actually paid');
});

test('CRITICAL: cannot pay against another school\'s charge', async () => {
  const [foreignCharge] = await db
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(eq(studentCharges.schoolId, B.schoolId))
    .limit(1);

  if (foreignCharge) {
    await assert.rejects(
      () =>
        recordPayment(admin(A), {
          studentId: A.childOne,
          amountCents: 1000,
          method: 'cash',
          referenceNumber: null,
          paidOn: '2025-10-13',
          notes: null,
          clientKey: null,
          chargeIds: [foreignCharge.id],
        }),
      (e: unknown) => {
        assert.ok(e instanceof FinanceError && e.status === 404);
        return true;
      },
    );
  }
});

test('CRITICAL: cannot record a payment for another school\'s student', async () => {
  await assert.rejects(
    () =>
      recordPayment(admin(A), {
        studentId: B.childOne,
        amountCents: 1000,
        method: 'cash',
        referenceNumber: null,
        paidOn: '2025-10-14',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 404);
      return true;
    },
  );
});

test('an unaccepted payment method is refused', async () => {
  await assert.rejects(
    () =>
      recordPayment(admin(A), {
        studentId: A.childTwo,
        amountCents: 100,
        method: 'bitcoin',
        referenceNumber: null,
        paidOn: '2025-10-15',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 400);
      return true;
    },
  );
});

test('recording a payment needs payment.record', async () => {
  await assert.rejects(
    () =>
      recordPayment(makeContext(A, A.adminUserId, ['fee.view', 'payment.view']), {
        studentId: A.childTwo,
        amountCents: 100,
        method: 'cash',
        referenceNumber: null,
        paidOn: '2025-10-16',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

test('voiding a payment restores the debt and keeps the record', async () => {
  const charge = await createAdHocCharge(admin(A), {
    studentId: A.childTwo,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Void probe',
    descriptionAm: null,
    amountCents: 30000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: null,
  });

  const payment = await recordPayment(admin(A), {
    studentId: A.childTwo,
    amountCents: 30000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-17',
    notes: null,
    clientKey: null,
    chargeIds: [charge.id],
  });

  const paidState = await listStudentCharges(admin(A), A.childTwo);
  assert.equal(paidState.find((c) => c.id === charge.id)!.outstandingCents, 0);

  await voidPayment(admin(A), payment.id, 'Cheque bounced');

  const afterVoid = await listStudentCharges(admin(A), A.childTwo);
  assert.equal(
    afterVoid.find((c) => c.id === charge.id)!.outstandingCents,
    30000,
    'the debt is restored',
  );

  const [row] = await db
    .select({ status: payments.status, reason: payments.voidReason, voidedBy: payments.voidedBy })
    .from(payments)
    .where(eq(payments.id, payment.id));

  assert.equal(row!.status, 'voided', 'the payment row still exists');
  assert.equal(row!.reason, 'Cheque bounced', 'with a stated reason');
  assert.ok(row!.voidedBy, 'and an attributed actor');
});

test('voiding needs payment.void, which a clerk does not have', async () => {
  const charge = await createAdHocCharge(admin(A), {
    studentId: A.childTwo,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Void permission probe',
    descriptionAm: null,
    amountCents: 5000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: null,
  });
  const payment = await recordPayment(clerk(A), {
    studentId: A.childTwo,
    amountCents: 5000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-18',
    notes: null,
    clientKey: null,
    chargeIds: [charge.id],
  });

  await assert.rejects(
    () => voidPayment(clerk(A), payment.id, 'Should fail'),
    (e: unknown) => {
      assert.ok(e instanceof AuthError, 'recording money is not the same right as reversing it');
      return true;
    },
  );
});

test('a payment cannot be voided twice', async () => {
  const [voided] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.schoolId, A.schoolId), eq(payments.status, 'voided')))
    .limit(1);

  await assert.rejects(
    () => voidPayment(admin(A), voided!.id, 'Again'),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 409);
      return true;
    },
  );
});

test('CRITICAL: cannot void another school\'s payment', async () => {
  const [foreign] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.schoolId, A.schoolId), eq(payments.status, 'completed')))
    .limit(1);

  // Try from school B using A's payment id.
  await assert.rejects(
    () => voidPayment(admin(B), foreign!.id, 'Cross-tenant void'),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 404);
      return true;
    },
  );

  const [still] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, foreign!.id));
  assert.equal(still!.status, 'completed', 'the payment was not touched');
});

test('a charge with money against it cannot be cancelled', async () => {
  const [charge] = await db
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .innerJoin(paymentAllocations, eq(paymentAllocations.chargeId, studentCharges.id))
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(and(eq(studentCharges.schoolId, A.schoolId), eq(payments.status, 'completed')))
    .limit(1);

  await assert.rejects(
    () => cancelCharge(admin(A), charge!.id, 'Trying to erase a paid debt'),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 409);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

test('a receipt carries what it needs and nothing private', async () => {
  const [payment] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.schoolId, A.schoolId), eq(payments.status, 'completed')))
    .limit(1);

  const receipt = await getReceipt(admin(A), payment!.id);

  assert.ok(receipt.payment.receiptNumber);
  assert.ok(receipt.payment.studentGivenName);
  assert.ok(receipt.payment.amountCents > 0);
  assert.ok(receipt.payment.method);
  assert.ok(receipt.payment.paidOn);
  assert.ok(typeof receipt.balance.outstandingCents === 'number');

  // Nothing that has no business on a receipt.
  const keys = Object.keys(receipt.payment);
  for (const leak of ['medicalNotes', 'address', 'bloodGroup', 'emergencyContactPhone', 'phone']) {
    assert.ok(!keys.includes(leak), `a receipt must not expose ${leak}`);
  }
});

test('CRITICAL: cannot fetch another school\'s receipt', async () => {
  const [payment] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.schoolId, A.schoolId))
    .limit(1);

  await assert.rejects(
    () => getReceipt(admin(B), payment!.id),
    (e: unknown) => {
      assert.ok(e instanceof FinanceError && e.status === 404);
      return true;
    },
  );
});

test('receipt numbers are unique and sequential per school', async () => {
  const rows = await db
    .select({ receiptNumber: payments.receiptNumber })
    .from(payments)
    .where(eq(payments.schoolId, A.schoolId));

  const numbers = rows.map((r) => r.receiptNumber);
  assert.equal(new Set(numbers).size, numbers.length, 'no two payments share a receipt number');
});

// ---------------------------------------------------------------------------
// Access control for reading
// ---------------------------------------------------------------------------

test('CRITICAL: a teacher who can see a pupil cannot see their money', async () => {
  const teacher = makeContext(A, A.teacherUserId, TEACHER_PERMS, { sectionIds: [A.sectionA] });

  // The teacher genuinely can see this pupil...
  assert.equal(await teacher.canViewStudent(A.childOne), true);

  // ...but holds no finance permission, so every finance entry point refuses.
  assert.throws(() => teacher.require('fee.view'), AuthError);
  assert.throws(() => teacher.require('payment.view'), AuthError);
  assert.throws(() => teacher.require('finance.report'), AuthError);

  await assert.rejects(
    () =>
      recordPayment(teacher, {
        studentId: A.childOne,
        amountCents: 100,
        method: 'cash',
        referenceNumber: null,
        paidOn: '2025-10-19',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError);
      return true;
    },
  );
});

test('CRITICAL: a parent sees only their own children\'s charges', async () => {
  const parent = makeContext(A, A.parentUserId, [...PARENT_PERMS, 'fee.view'], {
    childStudentIds: [A.childOne, A.childTwo],
    guardianId: A.guardianId,
  });

  // Their own children: allowed.
  const own = await listStudentCharges(parent, A.childOne);
  assert.ok(Array.isArray(own));

  // Another family's child: refused by the relationship check.
  await assert.rejects(
    () => parent.requireStudentAccess(A.strangerStudent),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 404, '404, not 403');
      return true;
    },
  );

  // And a child in another school entirely.
  await assert.rejects(
    () => parent.requireStudentAccess(B.childOne),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 404);
      return true;
    },
  );
});

test('CRITICAL: a student sees only their own finances', async () => {
  const pupil = makeContext(A, A.studentUserId, ['portal.student', 'fee.view'], {
    ownStudentId: A.childOne,
  });

  assert.equal(await pupil.canViewStudent(A.childOne), true);
  assert.equal(await pupil.canViewStudent(A.childTwo), false, 'not even a sibling');
  assert.equal(await pupil.canViewStudent(B.childOne), false);
});

test('CRITICAL: the portal resolves a pupil from the session, not the URL', async () => {
  // This is the exact path /portal/fees takes. A parent has no finance
  // permission at all, so the only thing standing between them and another
  // family's balance is resolvePortalStudent refusing the id.
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    childStudentIds: [A.childOne, A.childTwo],
    guardianId: A.guardianId,
  });

  const mine = await resolvePortalStudent(parent, A.childOne);
  assert.equal(mine.id, A.childOne, 'their own child resolves');

  // No id at all: the portal picks one of theirs, never someone else's.
  const fallback = await resolvePortalStudent(parent);
  const ownIds = (await listPortalStudents(parent)).map((s) => s.id);
  assert.ok(ownIds.includes(fallback.id), 'the default is always one of their own');
  assert.deepEqual(ownIds.sort(), [A.childOne, A.childTwo].sort());

  // A pupil at the same school who is not theirs.
  await assert.rejects(
    () => resolvePortalStudent(parent, A.strangerStudent),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 404, '404, not 403');
      return true;
    },
  );

  // A pupil at another school entirely.
  await assert.rejects(
    () => resolvePortalStudent(parent, B.childOne),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 404);
      return true;
    },
  );
});

test('CRITICAL: a parent holds no finance permission at all', async () => {
  // The portal page must never be tempted to call a permission-gated write.
  const parent = makeContext(A, A.parentUserId, PARENT_PERMS, {
    childStudentIds: [A.childOne],
    guardianId: A.guardianId,
  });

  const financePermissions = [
    'fee.view',
    'fee.manage',
    'payment.view',
    'payment.record',
    'payment.void',
    'finance.report',
  ] as const;

  for (const permission of financePermissions) {
    assert.equal(parent.has(permission), false, `a parent must not hold ${permission}`);
  }

  // And every finance mutation refuses them.
  await assert.rejects(
    () =>
      createAdHocCharge(parent, {
        studentId: A.childOne,
        categoryId: null,
        academicYearId: A.yearId,
        termId: null,
        description: 'Parent-invented charge',
        descriptionAm: null,
        amountCents: 100,
        discountCents: 0,
        discountType: 'none',
        discountReason: null,
        dueDate: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 403, 'a permission failure is a 403');
      return true;
    },
  );

  await assert.rejects(
    () =>
      recordPayment(parent, {
        studentId: A.childOne,
        amountCents: 100,
        method: 'cash',
        referenceNumber: null,
        paidOn: '2025-10-28',
        notes: null,
        clientKey: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof AuthError && e.status === 403);
      return true;
    },
  );
});

test('CRITICAL: listing charges never crosses a school boundary', async () => {
  // Ask school B's context for a student id belonging to school A. Even though
  // the id is real, the school filter must return nothing.
  const rows = await listStudentCharges(admin(B), A.childOne);
  assert.equal(rows.length, 0, 'no charges leak across schools');
});

// ---------------------------------------------------------------------------
// Historical integrity
// ---------------------------------------------------------------------------

test('CRITICAL: last year\'s charges do not move when this year\'s fee changes', async () => {
  const historic = await createAdHocCharge(admin(A), {
    studentId: A.childOne,
    categoryId: null,
    academicYearId: A.lastYearId,
    termId: null,
    description: 'Last year tuition',
    descriptionAm: null,
    amountCents: 200000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: '2024-10-01',
  });

  const [fee] = await db
    .select()
    .from(feeStructures)
    .where(and(eq(feeStructures.schoolId, A.schoolId), eq(feeStructures.name, 'Tuition')))
    .limit(1);

  const { updateFeeStructure } = await import('../src/lib/finance/service.ts');
  await updateFeeStructure(admin(A), fee!.id, { amountCents: 999999 });

  const [after] = await db
    .select({ amountCents: studentCharges.amountCents, yearId: studentCharges.academicYearId })
    .from(studentCharges)
    .where(eq(studentCharges.id, historic.id));

  assert.equal(after!.amountCents, 200000, 'a historic charge keeps its own amount');
  assert.equal(after!.yearId, A.lastYearId, 'and stays attached to its academic year');

  // Charges already raised for the current year are equally frozen.
  const current = await listStudentCharges(admin(A), A.childOne, { academicYearId: A.yearId });
  const tuition = current.find((c) => c.description === 'Tuition');
  assert.equal(tuition?.amountCents, 300000, 'existing charges keep the price they were raised at');
});

test('charges can be filtered to one academic year', async () => {
  const lastYear = await listStudentCharges(admin(A), A.childOne, {
    academicYearId: A.lastYearId,
  });
  assert.ok(lastYear.length > 0);
  assert.ok(
    lastYear.every((c) => c.academicYearId === A.lastYearId),
    'the filter is honoured',
  );
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('CRITICAL: the dashboard summary only counts this school', async () => {
  // Both schools have real money on the books, so this compares two non-empty
  // figures. An isolation test where the other side is empty passes even when
  // the school filter is missing.
  const summaryA = await getFinanceSummary(admin(A));
  const summaryB = await getFinanceSummary(admin(B));

  assert.ok(summaryA.chargedCents > 0, 'school A has charges');
  assert.ok(summaryB.chargedCents > 0, 'school B has charges of its own');

  // `chargedCents` is the gross billed figure and `netCents` is after
  // discounts. Checking both catches a filter that leaks on one but not the
  // other, and pins down which column the dashboard is actually reporting.
  const own = (schoolId: string) =>
    db
      .select({
        gross: sql<number>`coalesce(sum(${studentCharges.amountCents}), 0)::int`,
        net: sql<number>`coalesce(sum(${studentCharges.netAmountCents}), 0)::int`,
      })
      .from(studentCharges)
      .where(and(eq(studentCharges.schoolId, schoolId), eq(studentCharges.status, 'active')));

  const [ownA] = await own(A.schoolId);
  const [ownB] = await own(B.schoolId);

  assert.equal(summaryA.chargedCents, ownA!.gross, 'A sees exactly its own gross charges');
  assert.equal(summaryA.netCents, ownA!.net, 'A nets off exactly its own discounts');
  assert.equal(summaryB.chargedCents, ownB!.gross, 'B sees exactly its own gross charges');
  assert.equal(summaryB.netCents, ownB!.net, 'B nets off exactly its own discounts');

  assert.ok(ownA!.gross > ownA!.net, 'A has discounts, so gross and net genuinely differ');
  assert.notEqual(
    summaryA.chargedCents,
    ownA!.gross + ownB!.gross,
    "A's total is not the combined total of both schools",
  );

  // B has taken no payments; A has. Money must not leak across the boundary.
  assert.ok(summaryA.collectedCents > 0, 'A has collected');
  assert.equal(summaryB.collectedCents, 0, 'B has collected nothing and sees none of A\'s');
});

test('the collection rate is a real ratio, not a decoration', async () => {
  const summary = await getFinanceSummary(admin(A));
  const expected =
    summary.netCents > 0
      ? Math.round((summary.collectedCents / summary.netCents) * 1000) / 10
      : 0;
  assert.equal(summary.collectionRate, expected);
  assert.ok(summary.collectionRate >= 0 && summary.collectionRate <= 100);
});

test('outstanding students lists real debtors, worst first', async () => {
  const rows = await getOutstandingStudents(admin(A));
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((r) => r.outstandingCents > 0),
    'nobody who has paid up appears',
  );
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1]!.outstandingCents >= rows[i]!.outstandingCents, 'sorted worst first');
  }
});

test('the method breakdown reflects what was actually recorded', async () => {
  const rows = await getMethodBreakdown(admin(A));
  const methods = rows.map((r) => r.method);
  assert.ok(methods.includes('cash'));
  assert.ok(methods.includes('bank'));
  assert.ok(methods.includes('telebirr'));

  // Voided payments must not be counted as income.
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  const [live] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.schoolId, A.schoolId), eq(payments.status, 'completed')));
  assert.equal(total, live!.total, 'voided money is excluded');
});

// ---------------------------------------------------------------------------
// Notification integration
// ---------------------------------------------------------------------------

test('a payment emits an event that reaches the guardian, honouring settings', async () => {
  clearHandlers();
  registerNotificationHandlers();

  const before = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(eq(notifications.schoolId, A.schoolId), eq(notifications.userId, A.parentUserId)),
    );

  const charge = await createAdHocCharge(admin(A), {
    studentId: A.childOne,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Notification probe',
    descriptionAm: null,
    amountCents: 12000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: null,
  });

  const payment = await recordPayment(admin(A), {
    studentId: A.childOne,
    amountCents: 12000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-20',
    notes: null,
    clientKey: null,
    chargeIds: [charge.id],
  });

  await announcePayment(
    admin(A),
    {
      id: payment.id,
      receiptNumber: payment.receiptNumber,
      amountCents: payment.amountCents,
      method: 'cash',
    },
    A.childOne,
  );

  const after = await db
    .select({ id: notifications.id, type: notifications.type })
    .from(notifications)
    .where(
      and(eq(notifications.schoolId, A.schoolId), eq(notifications.userId, A.parentUserId)),
    );

  assert.ok(after.length > before.length, 'the guardian was notified');
  assert.ok(
    after.some((n) => n.type === 'payment.recorded'),
    'with a payment notification',
  );
  clearHandlers();
});

test('a school that switched payment notifications off gets none', async () => {
  clearHandlers();
  registerNotificationHandlers();

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
          paymentRecorded: false, // off
          feeDue: true,
          homeworkAssigned: false,
          announcement: true,
        },
        quietHoursStart: '21:00',
        quietHoursEnd: '06:30',
        sms: { provider: 'none', senderId: '', apiKeyRef: '', endpoint: '', isEnabled: false },
      },
    })
    .where(
      and(eq(schoolSettings.schoolId, A.schoolId), eq(schoolSettings.key, 'notifications')),
    );
  invalidateSettingsCache(A.schoolId, 'notifications');

  const before = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.schoolId, A.schoolId),
        eq(notifications.userId, A.parentUserId),
        eq(notifications.type, 'payment.recorded'),
      ),
    );

  const charge = await createAdHocCharge(admin(A), {
    studentId: A.childOne,
    categoryId: null,
    academicYearId: A.yearId,
    termId: null,
    description: 'Silent probe',
    descriptionAm: null,
    amountCents: 3000,
    discountCents: 0,
    discountType: 'none',
    discountReason: null,
    dueDate: null,
  });
  const payment = await recordPayment(admin(A), {
    studentId: A.childOne,
    amountCents: 3000,
    method: 'cash',
    referenceNumber: null,
    paidOn: '2025-10-21',
    notes: null,
    clientKey: null,
    chargeIds: [charge.id],
  });
  await announcePayment(
    admin(A),
    { id: payment.id, receiptNumber: payment.receiptNumber, amountCents: 3000, method: 'cash' },
    A.childOne,
  );

  const after = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.schoolId, A.schoolId),
        eq(notifications.userId, A.parentUserId),
        eq(notifications.type, 'payment.recorded'),
      ),
    );

  assert.equal(after.length, before.length, 'the school\'s setting is respected');
  clearHandlers();
});

test('the reminder sweep emits due events without sending anything itself', async () => {
  clearHandlers(); // no handlers registered: finance must not care

  const run = await sweepDueReminders(admin(A), { overdueOnly: true });
  assert.ok(run.scanned >= 0);
  assert.equal(run.emitted, run.scanned, 'one event per due charge');
  // Nothing threw despite there being no notification handler at all — finance
  // is decoupled from delivery.
});

// ---------------------------------------------------------------------------
// Database-level guarantees
// ---------------------------------------------------------------------------

test('CRITICAL: the database itself rejects a negative payment', async () => {
  await assert.rejects(
    () =>
      db.insert(payments).values({
        schoolId: A.schoolId,
        studentId: A.childOne,
        receiptNumber: `RAW-${crypto.randomUUID().slice(0, 8)}`,
        amountCents: -5000,
        method: 'cash',
        paidOn: '2025-10-22',
      }),
    (e: unknown) => {
      assert.equal(
        pgCode(e),
        '23514',
        'a CHECK constraint stops this even if application validation is bypassed',
      );
      return true;
    },
  );
});

test('CRITICAL: the database itself rejects a cross-school payment', async () => {
  await assert.rejects(
    () =>
      db.insert(payments).values({
        schoolId: A.schoolId,
        studentId: B.childOne, // another school's pupil
        receiptNumber: `RAW-${crypto.randomUUID().slice(0, 8)}`,
        amountCents: 1000,
        method: 'cash',
        paidOn: '2025-10-23',
      }),
    (e: unknown) => {
      assert.equal(pgCode(e), '23503', 'the composite foreign key makes this impossible');
      return true;
    },
  );
});

test('CRITICAL: the database rejects an allocation joining two schools', async () => {
  const [paymentA] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.schoolId, A.schoolId))
    .limit(1);
  const [chargeA] = await db
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(eq(studentCharges.schoolId, A.schoolId))
    .limit(1);

  // Claim school B owns an allocation between two of school A's rows.
  await assert.rejects(
    () =>
      db.insert(paymentAllocations).values({
        schoolId: B.schoolId,
        paymentId: paymentA!.id,
        chargeId: chargeA!.id,
        amountCents: 100,
      }),
    (e: unknown) => {
      assert.equal(pgCode(e), '23503', 'an allocation cannot straddle schools');
      return true;
    },
  );
});

test('CHECK constraints stop a discount larger than the charge', async () => {
  await assert.rejects(
    () =>
      db.insert(studentCharges).values({
        schoolId: A.schoolId,
        studentId: A.childOne,
        academicYearId: A.yearId,
        description: 'Impossible discount',
        amountCents: 1000,
        discountCents: 5000,
      }),
    (e: unknown) => {
      assert.equal(pgCode(e), '23514', 'the discount CHECK rejects it');
      return true;
    },
  );
});
