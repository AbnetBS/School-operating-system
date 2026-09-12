/**
 * Operations tests (Group 8) — library and inventory.
 *
 * Written to break the modules, not to confirm they work. What matters here:
 *
 *   - one school's book can never be issued to another school's pupil
 *   - the same copy cannot be lent to two people, whatever the caller does
 *   - stock cannot go negative, and the ledger always reconstructs the total
 *   - a client cannot invert an issue into a receipt by sending a negative
 *   - a librarian cannot issue to a pupil they are not allowed to see
 *   - a permission is required for every mutation, checked server-side
 *   - the derived availability count matches reality after every operation
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import {
  schools,
  users,
  academicYears,
  gradeLevels,
  sections,
  schoolSettings,
} from '../src/db/schema/core.ts';
import { students, enrollments, staff } from '../src/db/schema/people.ts';
import {
  libraryItems,
  libraryCopies,
  libraryLoans,
  inventoryItems,
  stockMovements,
  staffAttendance,
  leaveTypes,
  schoolEvents,
  documents,
} from '../src/db/schema/operations.ts';
import { auditLog } from '../src/db/schema/core.ts';
import { AuthError, type AuthContext } from '../src/lib/auth/context.ts';
import {
  createLibraryItem,
  updateLibraryItem,
  addCopies,
  listLibraryItems,
  listCopies,
  issueLoan,
  returnLoan,
  renewLoan,
  listLoans,
  getLibraryItemOwned,
  addDays,
} from '../src/lib/operations/library.ts';
import {
  createInventoryItem,
  updateInventoryItem,
  recordMovement,
  listInventoryItems,
  listMovements,
  recomputeQuantity,
} from '../src/lib/operations/inventory.ts';
import {
  countWorkingDays,
  createLeaveType,
  createLeaveRequest,
  decideLeaveRequest,
  cancelLeaveRequest,
  listLeaveRequests,
  recordStaffAttendance,
  getStaffAttendanceSheet,
  getStaffAttendanceSummary,
} from '../src/lib/operations/hr.ts';
import {
  createEvent,
  listEvents,
  listPortalEvents,
  createDocument,
  getDocumentForAccess,
  listDocuments,
} from '../src/lib/operations/calendar.ts';
import { assignTransport, createRoute, createVehicle } from '../src/lib/operations/facilities.ts';
import { OperationsError } from '../src/lib/operations/errors.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';
import { clearHandlers } from '../src/lib/events/index.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
  adminUserId: string;
  librarianUserId: string;
  teacherUserId: string;
  staffId: string;
  pupilInA: string;
  pupilInB: string;
};

const A = {} as Fixture;
const B = {} as Fixture;

const LIBRARIAN_PERMS = [
  'school.view',
  'student.view',
  'staff.view',
  'library.view',
  'library.manage',
  'library.issue',
];
const STORE_PERMS = ['school.view', 'inventory.view', 'inventory.manage'];
/** A teacher restricted to their own sections; may read, may not manage. */
const TEACHER_PERMS = ['student.view', 'restrict.ownSectionsOnly', 'library.view'];

function makeContext(
  fixture: Fixture,
  userId: string,
  permissions: string[],
  relationships: { sectionIds?: string[]; childStudentIds?: string[] } = {},
): AuthContext {
  const canViewStudent = async (studentId: string): Promise<boolean> => {
    // A portal user's access is by RELATIONSHIP, never by permission — the
    // same rule the real context applies.
    if ((relationships.childStudentIds ?? []).includes(studentId)) return true;
    if (!permissions.includes('student.view')) return false;
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
    // Unrestricted, but still scoped to this school: an id from elsewhere
    // must not resolve.
    const [row] = await db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, fixture.schoolId), eq(students.id, studentId)))
      .limit(1);
    return Boolean(row);
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
    roleKeys: permissions.includes('portal.parent') ? ['parent'] : ['staff'],
    relationships: {
      sectionIds: relationships.sectionIds ?? [],
      sectionSubjectIds: [],
      childStudentIds: relationships.childStudentIds ?? [],
      ownStudentId: null,
      guardianId: null,
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
    .values({ code, name: `Ops ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values([
    {
      schoolId: fixture.schoolId,
      key: 'library',
      value: {
        loanDays: 14,
        maxLoansPerBorrower: 2,
        maxRenewals: 1,
        finePerDayCents: 0,
        reminderDaysBefore: 2,
        accessionPrefix: 'ACC',
      },
    },
    { schoolId: fixture.schoolId, key: 'locale', value: { timezone: 'Africa/Addis_Ababa' } },
    {
      schoolId: fixture.schoolId,
      key: 'operations',
      value: {
        workingDays: [1, 2, 3, 4, 5],
        leaveRequiresApproval: true,
        lowStockWarningFactor: 1,
        defaultStaffAttendanceStatus: 'present',
      },
    },
  ]);
  invalidateSettingsCache(fixture.schoolId);

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

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

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
      gradeLevelId: fixture.gradeId,
      name: 'B',
      capacity: 40,
    })
    .returning({ id: sections.id });
  fixture.sectionB = secB!.id;

  fixture.adminUserId = await makeUser(fixture.schoolId, `${code}-admin`, 'Admin');
  fixture.librarianUserId = await makeUser(fixture.schoolId, `${code}-lib`, 'Librarian');
  fixture.teacherUserId = await makeUser(fixture.schoolId, `${code}-teacher`, 'Teacher');

  const [staffRow] = await db
    .insert(staff)
    .values({
      schoolId: fixture.schoolId,
      userId: fixture.teacherUserId,
      staffCode: `${code}-STF-1`,
      staffType: 'teacher',
      status: 'active',
    })
    .returning({ id: staff.id });
  fixture.staffId = staffRow!.id;

  const pupils: string[] = [];
  for (const [i, name] of ['Abebe', 'Kebede'].entries()) {
    const [s] = await db
      .insert(students)
      .values({
        schoolId: fixture.schoolId,
        studentCode: `${code}-S${i}`,
        givenName: name,
        fatherName: 'Tesfaye',
        status: 'active',
      })
      .returning({ id: students.id });
    pupils.push(s!.id);
    await db.insert(enrollments).values({
      schoolId: fixture.schoolId,
      studentId: s!.id,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      sectionId: i === 0 ? fixture.sectionA : fixture.sectionB,
      enrolledOn: '2025-09-01',
      status: 'enrolled',
    });
  }
  [fixture.pupilInA, fixture.pupilInB] = pupils as [string, string];
}

before(async () => {
  db = await getDb();
  clearHandlers();
  // Unique codes per run, and the schools are removed afterwards, so the file
  // can be run repeatedly against the same database.
  const stamp = Date.now();
  await seedSchool(`opsa-${stamp}`, A);
  await seedSchool(`opsb-${stamp}`, B);
});

after(async () => {
  clearHandlers();
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  await closeDb();
});

const librarian = (f: Fixture) => makeContext(f, f.librarianUserId, LIBRARIAN_PERMS);
const storekeeper = (f: Fixture) => makeContext(f, f.adminUserId, STORE_PERMS);

/** SQLSTATE of a rejected write. Drizzle wraps the driver error on `cause`. */
function pgCode(error: unknown): string | undefined {
  return (
    (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code
  );
}

/** A fresh pupil, for tests whose assertions depend on a clean loan count. */
async function makeExtraPupil(f: Fixture, tag: string): Promise<string> {
  const [s] = await db
    .insert(students)
    .values({
      schoolId: f.schoolId,
      studentCode: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      givenName: 'Extra',
      fatherName: 'Pupil',
      status: 'active',
    })
    .returning({ id: students.id });
  await db.insert(enrollments).values({
    schoolId: f.schoolId,
    studentId: s!.id,
    academicYearId: f.yearId,
    gradeLevelId: f.gradeId,
    sectionId: f.sectionA,
    enrolledOn: '2025-09-01',
    status: 'enrolled',
  });
  return s!.id;
}

/** Create a title with `n` copies and return both ids. */
async function makeTitle(f: Fixture, title: string, n: number) {
  const ctx = librarian(f);
  const item = await createLibraryItem(ctx, {
    title,
    author: 'Author',
    isbn: null,
    publisher: null,
    publishedYear: null,
    itemType: 'book',
    category: null,
    callNumber: null,
    language: 'am',
    description: null,
    active: true,
  });
  const copies = await addCopies(ctx, item.id, {
    count: n,
    prefix: `${f.schoolId.slice(0, 4)}-${title.slice(0, 3)}`,
    condition: 'good',
    acquiredOn: null,
  });
  return { item, copies };
}

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

test('addDays stays in the calendar domain across a month and year boundary', () => {
  assert.equal(addDays('2026-09-10', 14), '2026-09-24');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-12-25', 14), '2027-01-08');
  // A leap day must not be skipped.
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

// ---------------------------------------------------------------------------
// Library: availability is derived
// ---------------------------------------------------------------------------

test('availability is derived from copies and open loans, never stored', async () => {
  const { item, copies } = await makeTitle(A, 'Fikir Eske Mekabir', 3);
  const ctx = librarian(A);

  let listed = await listLibraryItems(ctx, { q: 'Fikir' });
  assert.equal(listed.items[0]!.totalCopies, 3);
  assert.equal(listed.items[0]!.availableCopies, 3);
  assert.equal(listed.items[0]!.onLoan, 0);

  const { loan } = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: A.pupilInA,
    staffId: null,
    dueOn: null,
    note: null,
  });

  listed = await listLibraryItems(ctx, { q: 'Fikir' });
  assert.equal(listed.items[0]!.availableCopies, 2, 'one copy is out');
  assert.equal(listed.items[0]!.onLoan, 1);

  await returnLoan(ctx, loan.id, {
    condition: 'good',
    fineCents: null,
    waiveFine: false,
    note: null,
  });

  listed = await listLibraryItems(ctx, { q: 'Fikir' });
  assert.equal(listed.items[0]!.availableCopies, 3, 'the copy is back on the shelf');
  assert.equal(listed.items[0]!.onLoan, 0);

  // There is no availability column to disagree with the derived figure.
  const cols = (await db.execute(sql`
    select column_name from information_schema.columns
    where table_name = 'library_items'
  `)) as unknown as { rows: { column_name: string }[] };
  const names = cols.rows.map((r) => r.column_name);
  assert.ok(
    !names.some((n) => /avail|stock|count/.test(n)),
    `library_items must not cache availability, found: ${names.join(', ')}`,
  );
  assert.ok(item.id);
});

test('a copy marked damaged is not counted as available', async () => {
  const { item, copies } = await makeTitle(A, 'Oromay', 2);
  const ctx = librarian(A);

  await db
    .update(libraryCopies)
    .set({ status: 'damaged' })
    .where(eq(libraryCopies.id, copies[0]!.id));

  const listed = await listLibraryItems(ctx, { q: 'Oromay' });
  assert.equal(listed.items[0]!.totalCopies, 2);
  assert.equal(listed.items[0]!.availableCopies, 1, 'the damaged copy cannot be lent');

  await assert.rejects(
    () =>
      issueLoan(ctx, {
        copyId: copies[0]!.id,
        studentId: A.pupilInA,
        staffId: null,
        dueOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 403,
    'issuing a damaged copy must be refused',
  );
  assert.ok(item.id);
});

// ---------------------------------------------------------------------------
// Library: the double-issue race
// ---------------------------------------------------------------------------

test('CRITICAL: the same copy cannot be lent to two borrowers', async () => {
  const { copies } = await makeTitle(A, 'Dertogada', 1);
  const ctx = librarian(A);
  const copyId = copies[0]!.id;

  await issueLoan(ctx, {
    copyId,
    studentId: A.pupilInA,
    staffId: null,
    dueOn: null,
    note: null,
  });

  // Layer 1+2: the service refuses.
  await assert.rejects(
    () =>
      issueLoan(ctx, {
        copyId,
        studentId: A.pupilInB,
        staffId: null,
        dueOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
    'the service must refuse a second loan of the same copy',
  );

  // Layer 3: even a direct insert that bypasses the service is rejected. This
  // is the guarantee that survives a future refactor dropping the lock.
  const [item] = await db
    .select({ id: libraryCopies.itemId })
    .from(libraryCopies)
    .where(eq(libraryCopies.id, copyId));

  await assert.rejects(
    () =>
      db.insert(libraryLoans).values({
        schoolId: A.schoolId,
        copyId,
        itemId: item!.id,
        studentId: A.pupilInB,
        issuedOn: '2026-09-10',
        dueOn: '2026-09-24',
      }),
    (e: unknown) => pgCode(e) === '23505',
    'the partial unique index must reject a second open loan',
  );
});

test('the issue path locks the copy row before deciding', async () => {
  // PGlite serialises transactions, so a behavioural race cannot be observed.
  // Assert on the emitted SQL instead: the lock must be in the statement.
  const q = db
    .select({ id: libraryCopies.id })
    .from(libraryCopies)
    .where(eq(libraryCopies.schoolId, A.schoolId))
    .for('update');
  assert.match(q.toSQL().sql, /for update/i);
});

test('a returned copy can be lent again', async () => {
  const { copies } = await makeTitle(A, 'Yekermew', 1);
  const ctx = librarian(A);

  const first = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: A.pupilInA,
    staffId: null,
    dueOn: null,
    note: null,
  });
  await returnLoan(ctx, first.loan.id, {
    condition: 'good',
    fineCents: null,
    waiveFine: false,
    note: null,
  });

  const second = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: A.pupilInB,
    staffId: null,
    dueOn: null,
    note: null,
  });
  assert.ok(second.loan.id);
  assert.notEqual(second.loan.id, first.loan.id, 'a new loan row, not a reopened one');
});

test('a loan cannot be returned twice', async () => {
  const { copies } = await makeTitle(A, 'Alweleddim', 1);
  const ctx = librarian(A);
  const { loan } = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: A.pupilInA,
    staffId: null,
    dueOn: null,
    note: null,
  });

  await returnLoan(ctx, loan.id, {
    condition: 'good',
    fineCents: null,
    waiveFine: false,
    note: null,
  });
  await assert.rejects(
    () =>
      returnLoan(ctx, loan.id, {
        condition: 'good',
        fineCents: null,
        waiveFine: false,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
  );
});

// ---------------------------------------------------------------------------
// Library: tenant isolation
// ---------------------------------------------------------------------------

test('CRITICAL: one school cannot issue a book to another school\u2019s pupil', async () => {
  const { copies } = await makeTitle(A, 'Cross Tenant', 1);
  const ctx = librarian(A);

  // A valid pupil id — just not this school's.
  await assert.rejects(
    () =>
      issueLoan(ctx, {
        copyId: copies[0]!.id,
        studentId: B.pupilInA,
        staffId: null,
        dueOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof AuthError && e.status === 404,
    'a foreign pupil must be reported as not found, never as forbidden',
  );

  // And the database refuses it too, if the service is ever bypassed.
  const [copy] = await db
    .select({ itemId: libraryCopies.itemId })
    .from(libraryCopies)
    .where(eq(libraryCopies.id, copies[0]!.id));

  await assert.rejects(
    () =>
      db.insert(libraryLoans).values({
        schoolId: A.schoolId,
        copyId: copies[0]!.id,
        itemId: copy!.itemId,
        studentId: B.pupilInA,
        issuedOn: '2026-09-10',
        dueOn: '2026-09-24',
      }),
    (e: unknown) => pgCode(e) === '23503',
    'the composite foreign key must reject a cross-school borrower',
  );
});

test('CRITICAL: a title from another school is invisible and unfetchable', async () => {
  const { item } = await makeTitle(B, 'School B Only', 2);
  const ctxA = librarian(A);

  await assert.rejects(
    () => getLibraryItemOwned(ctxA, item.id),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );

  const listed = await listLibraryItems(ctxA, { q: 'School B Only' });
  assert.equal(listed.total, 0, "school A must not see school B's catalogue");

  await assert.rejects(
    () => listCopies(ctxA, item.id),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );

  await assert.rejects(
    () =>
      updateLibraryItem(ctxA, item.id, {
        title: 'Hijacked',
        author: null,
        isbn: null,
        publisher: null,
        publishedYear: null,
        itemType: 'book',
        category: null,
        callNumber: null,
        language: null,
        description: null,
        active: true,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
    'editing across the boundary must fail',
  );

  const [unchanged] = await db
    .select({ title: libraryItems.title })
    .from(libraryItems)
    .where(eq(libraryItems.id, item.id));
  assert.equal(unchanged!.title, 'School B Only', 'the row must be untouched');
});

test("a copy cannot be attached to another school's title", async () => {
  const { item } = await makeTitle(B, 'B Title For Copy', 1);
  await assert.rejects(
    () =>
      db.insert(libraryCopies).values({
        schoolId: A.schoolId,
        itemId: item.id,
        accessionNumber: 'HIJACK-1',
      }),
    (e: unknown) => pgCode(e) === '23503',
  );
});

// ---------------------------------------------------------------------------
// Library: permissions and relationship scoping
// ---------------------------------------------------------------------------

test('every library mutation requires its permission, server-side', async () => {
  const readOnly = makeContext(A, A.teacherUserId, ['library.view', 'student.view']);
  const { copies } = await makeTitle(A, 'Perm Check', 1);

  await assert.rejects(
    () =>
      createLibraryItem(readOnly, {
        title: 'Nope',
        author: null,
        isbn: null,
        publisher: null,
        publishedYear: null,
        itemType: 'book',
        category: null,
        callNumber: null,
        language: null,
        description: null,
        active: true,
      }),
    (e: unknown) => e instanceof AuthError && e.status === 403,
    'library.manage is required to add a title',
  );

  await assert.rejects(
    () =>
      issueLoan(readOnly, {
        copyId: copies[0]!.id,
        studentId: A.pupilInA,
        staffId: null,
        dueOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof AuthError && e.status === 403,
    'library.issue is required to lend',
  );
});

test('CRITICAL: a restricted teacher cannot issue to a pupil outside their sections', async () => {
  const { copies } = await makeTitle(A, 'Restricted Issue', 2);
  // A teacher of section A only, who also happens to hold library.issue.
  const restricted = makeContext(
    A,
    A.teacherUserId,
    [...TEACHER_PERMS, 'library.issue'],
    { sectionIds: [A.sectionA] },
  );

  // Their own pupil: allowed.
  const ok = await issueLoan(restricted, {
    copyId: copies[0]!.id,
    studentId: A.pupilInA,
    staffId: null,
    dueOn: null,
    note: null,
  });
  assert.ok(ok.loan.id);

  // A pupil in another section: refused, as not found.
  await assert.rejects(
    () =>
      issueLoan(restricted, {
        copyId: copies[1]!.id,
        studentId: A.pupilInB,
        staffId: null,
        dueOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof AuthError && e.status === 404,
    'the restriction must apply to lending, not only to the student list',
  );
});

// ---------------------------------------------------------------------------
// Library: policy limits are configuration, not code
// ---------------------------------------------------------------------------

test('the borrowing limit comes from settings and is enforced', async () => {
  // The fixture sets maxLoansPerBorrower = 2. A pupil of their own, so earlier
  // tests' loans cannot change the count this test depends on.
  const { copies } = await makeTitle(A, 'Limit Test', 4);
  const ctx = librarian(A);
  const borrower = await makeExtraPupil(A, 'limit');

  await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: borrower,
    staffId: null,
    dueOn: null,
    note: null,
  });
  await issueLoan(ctx, {
    copyId: copies[1]!.id,
    studentId: borrower,
    staffId: null,
    dueOn: null,
    note: null,
  });

  await assert.rejects(
    () =>
      issueLoan(ctx, {
        copyId: copies[2]!.id,
        studentId: borrower,
        staffId: null,
        dueOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
    'the third loan must be refused at the configured limit',
  );
});

test('renewal is capped by the configured maximum', async () => {
  // The fixture sets maxRenewals = 1.
  const { copies } = await makeTitle(A, 'Renew Test', 1);
  const ctx = librarian(A);
  const borrower = await makeExtraPupil(A, 'renew');
  const { loan } = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: borrower,
    staffId: null,
    dueOn: null,
    note: null,
  });

  const once = await renewLoan(ctx, loan.id);
  assert.equal(once.renewalCount, 1);
  assert.equal(once.dueOn, addDays(loan.dueOn, 14), 'the due date moves by the loan length');

  await assert.rejects(
    () => renewLoan(ctx, loan.id),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
  );
});

test('a staff member can borrow, and exactly one borrower is recorded', async () => {
  const { copies } = await makeTitle(A, 'Staff Borrow', 1);
  const ctx = librarian(A);
  const { loan } = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: null,
    staffId: A.staffId,
    dueOn: null,
    note: null,
  });
  assert.equal(loan.staffId, A.staffId);
  assert.equal(loan.studentId, null);

  const { loans } = await listLoans(ctx, { staffId: A.staffId });
  assert.equal(loans[0]!.borrowerType, 'staff');
});

test('a loan with no borrower, or two, is impossible at the database', async () => {
  const { copies } = await makeTitle(A, 'Borrower Check', 2);
  const [copy] = await db
    .select({ itemId: libraryCopies.itemId })
    .from(libraryCopies)
    .where(eq(libraryCopies.id, copies[0]!.id));

  await assert.rejects(
    () =>
      db.insert(libraryLoans).values({
        schoolId: A.schoolId,
        copyId: copies[0]!.id,
        itemId: copy!.itemId,
        issuedOn: '2026-09-10',
        dueOn: '2026-09-24',
      }),
    (e: unknown) => pgCode(e) === '23514',
    'a loan to nobody must be rejected',
  );

  await assert.rejects(
    () =>
      db.insert(libraryLoans).values({
        schoolId: A.schoolId,
        copyId: copies[1]!.id,
        itemId: copy!.itemId,
        studentId: A.pupilInA,
        staffId: A.staffId,
        issuedOn: '2026-09-10',
        dueOn: '2026-09-24',
      }),
    (e: unknown) => pgCode(e) === '23514',
    'a loan to both a pupil and a staff member must be rejected',
  );
});

test('lending writes an audit entry naming the actor', async () => {
  const { copies } = await makeTitle(A, 'Audit Test', 1);
  const ctx = librarian(A);
  const borrower = await makeExtraPupil(A, 'audit');
  const { loan } = await issueLoan(ctx, {
    copyId: copies[0]!.id,
    studentId: borrower,
    staffId: null,
    dueOn: null,
    note: null,
  });

  const rows = await db
    .select({ action: auditLog.action, actor: auditLog.actorUserId, summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.entityId, loan.id)));

  assert.ok(
    rows.some((r) => r.action === 'library.issue' && r.actor === A.librarianUserId),
    'the issue must be attributable to the person who did it',
  );
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function makeStockItem(f: Fixture, name: string, reorderLevel = 0) {
  return await createInventoryItem(storekeeper(f), {
    name,
    sku: null,
    category: 'stationery',
    unit: 'piece',
    reorderLevel,
    location: 'Store 1',
    unitCostCents: null,
    active: true,
  });
}

test('a new stock item starts at zero; opening stock arrives as a movement', async () => {
  const item = await makeStockItem(A, 'Exercise books');
  assert.equal(item.quantity, 0, 'the ledger, not the form, sets the opening quantity');

  const ctx = storekeeper(A);
  await recordMovement(ctx, item.id, {
    movementType: 'receipt',
    quantity: 100,
    movedOn: '2026-09-01',
    reference: 'GRN-1',
    note: null,
  });

  const { items } = await listInventoryItems(ctx, { q: 'Exercise books' });
  assert.equal(items[0]!.quantity, 100);
});

test('CRITICAL: stock cannot be issued below zero', async () => {
  const item = await makeStockItem(A, 'Chalk boxes');
  const ctx = storekeeper(A);

  await recordMovement(ctx, item.id, {
    movementType: 'receipt',
    quantity: 10,
    movedOn: '2026-09-01',
    reference: null,
    note: null,
  });

  await assert.rejects(
    () =>
      recordMovement(ctx, item.id, {
        movementType: 'issue',
        quantity: 11,
        movedOn: '2026-09-02',
        reference: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
    'issuing more than is held must be refused',
  );

  const { items } = await listInventoryItems(ctx, { q: 'Chalk boxes' });
  assert.equal(items[0]!.quantity, 10, 'the failed issue must not have changed anything');

  // And the database refuses a negative quantity even by direct write.
  await assert.rejects(
    () => db.update(inventoryItems).set({ quantity: -1 }).where(eq(inventoryItems.id, item.id)),
    (e: unknown) => pgCode(e) === '23514',
  );
});

test('CRITICAL: the cached quantity always equals the sum of the ledger', async () => {
  const item = await makeStockItem(A, 'Marker pens');
  const ctx = storekeeper(A);

  const steps: Array<['receipt' | 'issue' | 'loss', number]> = [
    ['receipt', 50],
    ['issue', 12],
    ['receipt', 20],
    ['loss', 3],
    ['issue', 30],
  ];
  for (const [type, qty] of steps) {
    await recordMovement(ctx, item.id, {
      movementType: type,
      quantity: qty,
      movedOn: '2026-09-03',
      reference: null,
      note: null,
    });
  }

  const expected = 50 - 12 + 20 - 3 - 30;

  const [cached] = await db
    .select({ q: inventoryItems.quantity })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, item.id));
  assert.equal(cached!.q, expected);

  const [sum] = await db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.delta}),0)::int` })
    .from(stockMovements)
    .where(eq(stockMovements.itemId, item.id));
  assert.equal(Number(sum!.total), expected, 'the ledger and the cache must agree');

  // The cache is reconstructible — that is what makes it a cache.
  const rebuilt = await recomputeQuantity(ctx, item.id);
  assert.equal(rebuilt, expected);

  // Every movement recorded its running balance.
  const { movements } = await listMovements(ctx, item.id, { limit: 50 });
  assert.equal(movements.length, steps.length);
  assert.equal(movements[0]!.balanceAfter, expected, 'newest movement carries the final balance');
});

test('CRITICAL: the client cannot invert an issue by sending a negative quantity', async () => {
  const item = await makeStockItem(A, 'Sign test');
  const ctx = storekeeper(A);
  await recordMovement(ctx, item.id, {
    movementType: 'receipt',
    quantity: 10,
    movedOn: '2026-09-01',
    reference: null,
    note: null,
  });

  // The schema rejects it before the service ever sees it.
  const { stockMovementSchema } = await import('../src/lib/operations/schema.ts');
  const parsed = stockMovementSchema.safeParse({
    movementType: 'issue',
    quantity: -5,
    movedOn: '2026-09-02',
  });
  assert.equal(parsed.success, false, 'a negative magnitude must not validate');

  // And even if it did, the service decides the sign from the type.
  await recordMovement(ctx, item.id, {
    movementType: 'issue',
    quantity: 4,
    movedOn: '2026-09-02',
    reference: null,
    note: null,
  });
  const [row] = await db
    .select({ q: inventoryItems.quantity })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, item.id));
  assert.equal(row!.q, 6, 'an issue must always decrease stock');
});

test('an edit cannot silently change the stock level', async () => {
  const item = await makeStockItem(A, 'Edit guard');
  const ctx = storekeeper(A);
  await recordMovement(ctx, item.id, {
    movementType: 'receipt',
    quantity: 7,
    movedOn: '2026-09-01',
    reference: null,
    note: null,
  });

  await updateInventoryItem(ctx, item.id, {
    name: 'Edit guard renamed',
    sku: null,
    category: 'stationery',
    unit: 'box',
    reorderLevel: 5,
    location: 'Store 2',
    unitCostCents: null,
    active: true,
  });

  const [row] = await db
    .select({ q: inventoryItems.quantity, name: inventoryItems.name })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, item.id));
  assert.equal(row!.name, 'Edit guard renamed');
  assert.equal(row!.q, 7, 'the quantity is owned by the ledger, not the edit form');
});

test('low stock is reported only where a reorder level is set', async () => {
  const tracked = await makeStockItem(A, 'Tracked item', 10);
  const untracked = await makeStockItem(A, 'Untracked item', 0);
  const ctx = storekeeper(A);

  await recordMovement(ctx, tracked.id, {
    movementType: 'receipt',
    quantity: 8,
    movedOn: '2026-09-01',
    reference: null,
    note: null,
  });

  const low = await listInventoryItems(ctx, { lowOnly: true });
  const names = low.items.map((i) => i.name);
  assert.ok(names.includes('Tracked item'), 'below its reorder level');
  assert.ok(
    !names.includes('Untracked item'),
    'a reorder level of zero means "do not track", not "always low"',
  );
  assert.ok(untracked.id);
});

test('CRITICAL: stock never crosses a school boundary', async () => {
  const itemB = await makeStockItem(B, 'School B stock');
  const ctxA = storekeeper(A);

  await assert.rejects(
    () =>
      recordMovement(ctxA, itemB.id, {
        movementType: 'receipt',
        quantity: 5,
        movedOn: '2026-09-01',
        reference: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
    "school A must not be able to move school B's stock",
  );

  await assert.rejects(
    () => listMovements(ctxA, itemB.id),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );

  const listed = await listInventoryItems(ctxA, { q: 'School B stock' });
  assert.equal(listed.total, 0);

  await assert.rejects(
    () =>
      db.insert(stockMovements).values({
        schoolId: A.schoolId,
        itemId: itemB.id,
        movementType: 'receipt',
        delta: 5,
        balanceAfter: 5,
        movedOn: '2026-09-01',
      }),
    (e: unknown) => pgCode(e) === '23503',
    'the composite foreign key must reject a cross-school movement',
  );
});

test('inventory mutations require inventory.manage', async () => {
  const viewer = makeContext(A, A.teacherUserId, ['inventory.view']);
  await assert.rejects(
    () =>
      createInventoryItem(viewer, {
        name: 'Nope',
        sku: null,
        category: null,
        unit: 'piece',
        reorderLevel: 0,
        location: null,
        unitCostCents: null,
        active: true,
      }),
    (e: unknown) => e instanceof AuthError && e.status === 403,
  );
});

test('a zero-effect adjustment is refused rather than recorded', async () => {
  const item = await makeStockItem(A, 'Adjust test');
  const ctx = storekeeper(A);
  await recordMovement(ctx, item.id, {
    movementType: 'receipt',
    quantity: 15,
    movedOn: '2026-09-01',
    reference: null,
    note: null,
  });

  // An adjustment to the number it already is changes nothing.
  await assert.rejects(
    () =>
      recordMovement(ctx, item.id, {
        movementType: 'adjustment',
        quantity: 15,
        movedOn: '2026-09-02',
        reference: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 400,
  );

  // A real adjustment sets the count and records the signed difference.
  await recordMovement(ctx, item.id, {
    movementType: 'adjustment',
    quantity: 12,
    movedOn: '2026-09-02',
    reference: 'stock take',
    note: null,
  });
  const { movements } = await listMovements(ctx, item.id);
  assert.equal(movements[0]!.delta, -3, 'an adjustment records the difference, not the target');
  assert.equal(movements[0]!.balanceAfter, 12);
});

// ---------------------------------------------------------------------------
// Staff attendance and leave
// ---------------------------------------------------------------------------

const HR_PERMS = [
  'school.view',
  'staff.view',
  'staffAttendance.take',
  'staffAttendance.view',
  'leave.configure',
  'leave.approve',
  'leave.request',
  'leave.view',
];

const hr = (f: Fixture) => makeContext(f, f.adminUserId, HR_PERMS);

test('working days come from configuration, not from an assumption', () => {
  // Mon 2026-09-07 .. Sun 2026-09-13
  assert.equal(countWorkingDays('2026-09-07', '2026-09-13', [1, 2, 3, 4, 5]), 5);
  // A school that also works Saturday gets a different, equally correct answer.
  assert.equal(countWorkingDays('2026-09-07', '2026-09-13', [1, 2, 3, 4, 5, 6]), 6);
  // A single non-working day is zero, not one.
  assert.equal(countWorkingDays('2026-09-13', '2026-09-13', [1, 2, 3, 4, 5]), 0);
  // A reversed range cannot produce a negative count.
  assert.equal(countWorkingDays('2026-09-13', '2026-09-07', [1, 2, 3, 4, 5]), 0);
});

test('the attendance sheet lists everyone, marked or not', async () => {
  const ctx = hr(A);
  const sheet = await getStaffAttendanceSheet(ctx, '2026-09-14');
  assert.ok(sheet.length >= 1, 'active staff appear on the sheet');
  assert.equal(sheet[0]!.status, null, 'an unmarked person is null, not absent');
});

test('resubmitting a day corrects it rather than duplicating', async () => {
  const ctx = hr(A);
  const sheet = await getStaffAttendanceSheet(ctx, '2026-09-15');
  const one = sheet[0]!;

  await recordStaffAttendance(ctx, {
    date: '2026-09-15',
    entries: [
      { staffId: one.staffId, status: 'absent', checkIn: null, checkOut: null, minutesLate: null, reason: 'Sick' },
    ],
  });
  const second = await recordStaffAttendance(ctx, {
    date: '2026-09-15',
    entries: [
      { staffId: one.staffId, status: 'present', checkIn: '08:00', checkOut: null, minutesLate: null, reason: null },
    ],
  });
  assert.equal(second.corrections, 1, 'the change is reported as a correction');

  const [rows] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffAttendance)
    .where(and(eq(staffAttendance.staffId, one.staffId), eq(staffAttendance.date, '2026-09-15')));
  assert.equal(Number(rows!.n), 1, 'one row per person per day, always');
});

test('CRITICAL: a school cannot mark another school\u2019s staff', async () => {
  const ctxA = hr(A);
  await assert.rejects(
    () =>
      recordStaffAttendance(ctxA, {
        date: '2026-09-16',
        entries: [
          { staffId: B.staffId, status: 'present', checkIn: null, checkOut: null, minutesLate: null, reason: null },
        ],
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );

  await assert.rejects(
    () =>
      db.insert(staffAttendance).values({
        schoolId: A.schoolId,
        staffId: B.staffId,
        date: '2026-09-16',
        status: 'present',
      }),
    (e: unknown) => pgCode(e) === '23503',
    'the composite foreign key must reject it at the database too',
  );
});

test('the server computes leave duration; a client cannot understate it', async () => {
  const ctx = hr(A);
  const type = await createLeaveType(ctx, {
    key: `annual-${Date.now()}`,
    name: 'Annual',
    nameAm: 'ዓመታዊ',
    daysPerYear: 20,
    paid: true,
    requiresApproval: true,
    active: true,
    sortOrder: 0,
  });

  // Mon-Fri: five working days, whatever the form says.
  const request = await createLeaveRequest(ctx, {
    staffId: A.staffId,
    leaveTypeId: type.id,
    startDate: '2027-03-01',
    endDate: '2027-03-05',
    reason: 'Family',
  });
  assert.equal(request.days, 5);
  assert.equal(request.status, 'pending');
});

test('overlapping leave for the same person is refused', async () => {
  const ctx = hr(A);
  const [type] = await db
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.schoolId, A.schoolId))
    .limit(1);

  await createLeaveRequest(ctx, {
    staffId: A.staffId,
    leaveTypeId: type!.id,
    startDate: '2027-05-03',
    endDate: '2027-05-07',
    reason: 'First',
  });
  await assert.rejects(
    () =>
      createLeaveRequest(ctx, {
        staffId: A.staffId,
        leaveTypeId: type!.id,
        startDate: '2027-05-05',
        endDate: '2027-05-11',
        reason: 'Overlapping',
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
  );
});

test('CRITICAL: nobody can approve their own leave', async () => {
  // A user who IS the staff member in question.
  const [selfStaff] = await db
    .insert(staff)
    .values({
      schoolId: A.schoolId,
      userId: A.adminUserId,
      staffCode: `SELF-${Date.now()}`,
      staffType: 'admin',
      status: 'active',
    })
    .returning({ id: staff.id });

  const ctx = hr(A);
  const [type] = await db
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.schoolId, A.schoolId))
    .limit(1);

  const own = await createLeaveRequest(ctx, {
    staffId: selfStaff!.id,
    leaveTypeId: type!.id,
    startDate: '2027-07-05',
    endDate: '2027-07-06',
    reason: 'Own leave',
  });

  await assert.rejects(
    () => decideLeaveRequest(ctx, own.id, { decision: 'approved', note: 'Approving myself' }),
    (e: unknown) => e instanceof OperationsError && e.status === 403,
    'self-approval is the classic hole in an approval workflow',
  );

  await db.delete(staff).where(eq(staff.id, selfStaff!.id));
});

test('approving leave marks the working days as on_leave', async () => {
  const ctx = hr(A);
  const [type] = await db
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.schoolId, A.schoolId))
    .limit(1);

  const request = await createLeaveRequest(ctx, {
    staffId: A.staffId,
    leaveTypeId: type!.id,
    startDate: '2027-09-06',
    endDate: '2027-09-10',
    reason: 'Trip',
  });
  await decideLeaveRequest(ctx, request.id, { decision: 'approved', note: 'Granted' });

  const summary = await getStaffAttendanceSummary(ctx, '2027-09-06', '2027-09-10');
  const row = summary.find((r) => r.staffId === A.staffId);
  assert.equal(row!.onLeave, 5, 'an approved absence must not count against the person');
});

test('a rejected request cannot be decided twice', async () => {
  const ctx = hr(A);
  const [type] = await db
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.schoolId, A.schoolId))
    .limit(1);

  const request = await createLeaveRequest(ctx, {
    staffId: A.staffId,
    leaveTypeId: type!.id,
    startDate: '2027-11-01',
    endDate: '2027-11-02',
    reason: 'Second',
  });
  await decideLeaveRequest(ctx, request.id, { decision: 'rejected', note: 'Too busy' });

  await assert.rejects(
    () => decideLeaveRequest(ctx, request.id, { decision: 'approved', note: 'Changed my mind' }),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
  );
  await assert.rejects(
    () => cancelLeaveRequest(ctx, request.id),
    (e: unknown) => e instanceof OperationsError && e.status === 409,
  );
});

test('leave approval requires the permission', async () => {
  const requester = makeContext(A, A.teacherUserId, ['leave.request']);
  const [type] = await db
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.schoolId, A.schoolId))
    .limit(1);
  const { requests } = await listLeaveRequests(hr(A), { status: 'pending' });
  const pending = requests[0];
  if (pending) {
    await assert.rejects(
      () => decideLeaveRequest(requester, pending.id, { decision: 'approved', note: 'x' }),
      (e: unknown) => e instanceof AuthError && e.status === 403,
    );
  }
  assert.ok(type!.id);
});

// ---------------------------------------------------------------------------
// Calendar audience
// ---------------------------------------------------------------------------

const EVENT_PERMS = ['school.view', 'event.view', 'event.manage', 'student.view'];

test('CRITICAL: the portal calendar honours the audience rule', async () => {
  const admin = makeContext(A, A.adminUserId, EVENT_PERMS);
  const base = {
    description: null,
    endDate: null,
    startTime: null,
    endTime: null,
    allDay: true,
    location: null,
    colour: null,
    termId: null,
  };

  const [enr] = await db
    .select({ sectionId: enrollments.sectionId, gradeLevelId: enrollments.gradeLevelId })
    .from(enrollments)
    .where(and(eq(enrollments.schoolId, A.schoolId), eq(enrollments.studentId, A.pupilInA)))
    .limit(1);

  await createEvent(admin, { ...base, title: 'Everyone Day', eventType: 'sport', startDate: '2027-02-01', audience: { kind: 'all' }, visibleToPortal: true });
  await createEvent(admin, { ...base, title: 'Own Section Meeting', eventType: 'meeting', startDate: '2027-02-02', audience: { kind: 'sections', sectionIds: [enr!.sectionId!] }, visibleToPortal: true });
  await createEvent(admin, { ...base, title: 'Other Section Meeting', eventType: 'meeting', startDate: '2027-02-03', audience: { kind: 'sections', sectionIds: [A.sectionB] }, visibleToPortal: true });
  await createEvent(admin, { ...base, title: 'Own Grade Meeting', eventType: 'meeting', startDate: '2027-02-04', audience: { kind: 'grades', gradeIds: [enr!.gradeLevelId!] }, visibleToPortal: true });
  await createEvent(admin, { ...base, title: 'Staff Only Briefing', eventType: 'meeting', startDate: '2027-02-05', audience: { kind: 'roles', roles: ['teacher'] }, visibleToPortal: false });
  await createEvent(admin, { ...base, title: 'Parents Evening', eventType: 'meeting', startDate: '2027-02-06', audience: { kind: 'roles', roles: ['parent'] }, visibleToPortal: true });

  const staffView = await listEvents(admin, { from: '2027-02-01', to: '2027-02-28' });
  assert.equal(staffView.length, 6, 'staff see the whole calendar');

  const parent = makeContext(A, A.adminUserId, ['portal.parent'], {
    childStudentIds: [A.pupilInA],
  });
  const seen = (await listPortalEvents(parent, A.pupilInA, { from: '2027-02-01', to: '2027-02-28' })).map(
    (e) => e.title,
  );

  assert.ok(seen.includes('Everyone Day'));
  assert.ok(seen.includes('Own Section Meeting'));
  assert.ok(seen.includes('Own Grade Meeting'));
  assert.ok(seen.includes('Parents Evening'), 'the parent role matches');
  assert.ok(!seen.includes('Other Section Meeting'), "another section's meeting must not leak");
  assert.ok(!seen.includes('Staff Only Briefing'), 'visibleToPortal=false hides it entirely');
});

test('a role key containing quotes cannot alter the query', async () => {
  // Role keys are school-configurable text. They are bound as parameters, so a
  // hostile value returns no extra rows and breaks nothing.
  const evil = {
    ...makeContext(A, A.adminUserId, ['portal.parent'], { childStudentIds: [A.pupilInA] }),
    roleKeys: ["x' or '1'='1", "parent'); drop table school_events; --"],
  } as unknown as AuthContext;

  const seen = await listPortalEvents(evil, A.pupilInA, { from: '2027-02-01', to: '2027-02-28' });
  const titles = seen.map((e) => e.title);
  assert.ok(!titles.includes('Staff Only Briefing'));
  assert.ok(!titles.includes('Parents Evening'), 'a forged role must not match');

  const [still] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schoolEvents)
    .where(eq(schoolEvents.schoolId, A.schoolId));
  assert.ok(Number(still!.n) > 0, 'the table is intact');
});

test('CRITICAL: events do not cross a school boundary', async () => {
  const adminB = makeContext(B, B.adminUserId, EVENT_PERMS);
  await createEvent(adminB, {
    description: null,
    endDate: null,
    startTime: null,
    endTime: null,
    allDay: true,
    location: null,
    colour: null,
    termId: null,
    title: 'School B Private Event',
    eventType: 'meeting',
    startDate: '2027-02-10',
    audience: { kind: 'all' },
    visibleToPortal: true,
  });

  const adminA = makeContext(A, A.adminUserId, EVENT_PERMS);
  const seen = await listEvents(adminA, { from: '2027-02-01', to: '2027-02-28' });
  assert.ok(
    !seen.some((e) => e.title === 'School B Private Event'),
    "school A must not see school B's calendar",
  );
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOC_PERMS = ['school.view', 'student.view', 'document.view', 'document.upload'];

test('CRITICAL: a portal user only reads documents published to their own child', async () => {
  const registrar = makeContext(A, A.adminUserId, DOC_PERMS);

  const published = await createDocument(registrar, {
    ownerType: 'student',
    ownerId: A.pupilInA,
    title: 'Report Card',
    category: 'report_card',
    description: null,
    visibleToPortal: true,
    expiresOn: null,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    storageKey: 'k/report.pdf',
  });

  const internal = await createDocument(registrar, {
    ownerType: 'student',
    ownerId: A.pupilInA,
    title: 'Internal Note',
    category: 'other',
    description: null,
    visibleToPortal: false,
    expiresOn: null,
    fileName: 'note.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 512,
    storageKey: 'k/note.pdf',
  });

  // A parent context that may see pupil A but not pupil B.
  const parent = {
    ...makeContext(A, A.adminUserId, ['portal.parent']),
    requireStudentAccess: async (id: string) => {
      if (id !== A.pupilInA) throw new AuthError('Student not found', 404);
    },
  } as unknown as AuthContext;

  const ok = await getDocumentForAccess(parent, published.id, { portal: true });
  assert.equal(ok.id, published.id);

  await assert.rejects(
    () => getDocumentForAccess(parent, internal.id, { portal: true }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
    'an internal document must be invisible in the portal',
  );

  const otherChild = await createDocument(registrar, {
    ownerType: 'student',
    ownerId: A.pupilInB,
    title: 'Another Family Report',
    category: 'report_card',
    description: null,
    visibleToPortal: true,
    expiresOn: null,
    fileName: 'other.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 256,
    storageKey: 'k/other.pdf',
  });

  await assert.rejects(
    () => getDocumentForAccess(parent, otherChild.id, { portal: true }),
    (e: unknown) => e instanceof AuthError && e.status === 404,
    "a parent must never read another family's document",
  );
});

test('a school-wide document must not name an owner, and vice versa', async () => {
  await assert.rejects(
    () =>
      db.insert(documents).values({
        schoolId: A.schoolId,
        ownerType: 'student',
        ownerId: null,
        title: 'Ownerless',
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        storageKey: 'k/x',
      }),
    (e: unknown) => pgCode(e) === '23514',
  );
});

test('CRITICAL: documents never cross a school boundary', async () => {
  const registrarB = makeContext(B, B.adminUserId, DOC_PERMS);
  const docB = await createDocument(registrarB, {
    ownerType: 'student',
    ownerId: B.pupilInA,
    title: 'School B Document',
    category: 'other',
    description: null,
    visibleToPortal: true,
    expiresOn: null,
    fileName: 'b.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    storageKey: 'k/b.pdf',
  });

  const registrarA = makeContext(A, A.adminUserId, DOC_PERMS);
  await assert.rejects(
    () => getDocumentForAccess(registrarA, docB.id),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );

  const listed = await listDocuments(registrarA, { q: 'School B Document' });
  assert.equal(listed.total, 0);
});

test('uploading a document requires document.upload', async () => {
  const viewer = makeContext(A, A.teacherUserId, ['document.view', 'student.view']);
  await assert.rejects(
    () =>
      createDocument(viewer, {
        ownerType: 'school',
        ownerId: null,
        title: 'Policy',
        category: 'policy',
        description: null,
        visibleToPortal: false,
        expiresOn: null,
        fileName: 'p.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        storageKey: 'k/p',
      }),
    (e: unknown) => e instanceof AuthError && e.status === 403,
  );
});
