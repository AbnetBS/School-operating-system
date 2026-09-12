/**
 * Group 8 write-path tests.
 *
 * These cover the code added when the operational write workflows were wired
 * to the UI. Each test exists because the behaviour it checks was either a
 * real bug found during that work, or a rule that only the write path can
 * break:
 *
 *   - file type is decided by CONTENT, not by the client's Content-Type or
 *     the filename, because both are attacker-controlled;
 *   - a storage key is generated, never accepted, and cannot escape the root;
 *   - a stock correction must carry a reason;
 *   - an event cannot be addressed to another school's section or grade;
 *   - a copy's status can be changed through the service that the new route
 *     exposes, and only with the right permission.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The storage module reads STORAGE_ROOT at import time, so it must be set
// before the import is evaluated. A temp directory keeps the test's bytes out
// of the repository.
process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'sos-storage-'));

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
import { libraryItems, libraryCopies, inventoryItems } from '../src/db/schema/operations.ts';
import { AuthError, type AuthContext } from '../src/lib/auth/context.ts';
import { OperationsError } from '../src/lib/operations/errors.ts';
import { createLibraryItem, addCopies, updateCopy, listCopies } from '../src/lib/operations/library.ts';
import { createInventoryItem, recordMovement } from '../src/lib/operations/inventory.ts';
import { createEvent, updateEvent } from '../src/lib/operations/calendar.ts';
import { stockMovementSchema } from '../src/lib/operations/schema.ts';
import {
  sniffType,
  safeFileName,
  newStorageKey,
  putObject,
  getObject,
  deleteObject,
  MAX_UPLOAD_BYTES,
} from '../src/lib/operations/storage.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionId: string;
  adminUserId: string;
  teacherUserId: string;
  staffId: string;
  pupilId: string;
};

const A = {} as Fixture;
const B = {} as Fixture;

const stamp = Date.now();

const ALL_PERMS = [
  'school.view',
  'student.view',
  'staff.view',
  'library.view',
  'library.manage',
  'library.issue',
  'inventory.view',
  'inventory.manage',
  'event.view',
  'event.manage',
  'document.view',
  'document.upload',
  'document.delete',
];

function makeContext(fixture: Fixture, userId: string, permissions: string[]): AuthContext {
  const set = new Set(permissions);
  return {
    db,
    user: { userId, schoolId: fixture.schoolId, username: 'test' },
    schoolId: fixture.schoolId,
    permissions: set,
    roleKeys: ['tester'],
    relationships: {
      sectionIds: [],
      sectionSubjectIds: [],
      childStudentIds: [],
      ownStudentId: null,
      guardianId: null,
    },
    locale: 'en',
    ipAddress: '127.0.0.1',
    has: (p: string) => set.has(p),
    hasAny: (...ps: string[]) => ps.some((p) => set.has(p)),
    require(p: string) {
      if (!set.has(p)) throw new AuthError(`Missing permission: ${p}`, 403);
    },
    requireAny(...ps: string[]) {
      if (!ps.some((p) => set.has(p))) throw new AuthError('Missing permission', 403);
    },
    async requireModule() {
      /* every module is on for these fixtures */
    },
    async requireStudentAccess(studentId: string) {
      const [row] = await db
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.schoolId, fixture.schoolId), eq(students.id, studentId)))
        .limit(1);
      if (!row) throw new AuthError('Student not found', 404);
    },
    async canViewStudent() {
      return true;
    },
    requireSectionAccess() {},
    displayName: () => 'Tester',
  } as unknown as AuthContext;
}

async function seed(fixture: Fixture, code: string, name: string) {
  const [school] = await db
    .insert(schools)
    .values({ code, name, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

  await db.insert(schoolSettings).values({
    schoolId: fixture.schoolId,
    key: 'modules',
    value: {
      library: true,
      inventory: true,
      maintenance: true,
      transport: true,
      hr: true,
      documents: true,
    },
  });

  const [admin] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: `admin-${code}`,
      passwordHash: 'x',
      givenName: 'Admin',
      fatherName: 'User',
    })
    .returning({ id: users.id });
  fixture.adminUserId = admin!.id;

  const [teacher] = await db
    .insert(users)
    .values({
      schoolId: fixture.schoolId,
      username: `teacher-${code}`,
      passwordHash: 'x',
      givenName: 'Teacher',
      fatherName: 'User',
    })
    .returning({ id: users.id });
  fixture.teacherUserId = teacher!.id;

  const [staffRow] = await db
    .insert(staff)
    .values({
      schoolId: fixture.schoolId,
      userId: teacher!.id,
      staffCode: `STF-${code}`,
      staffType: 'teacher',
      status: 'active',
    })
    .returning({ id: staff.id });
  fixture.staffId = staffRow!.id;

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

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: fixture.schoolId, name: 'Grade 1', level: 1 })
    .returning({ id: gradeLevels.id });
  fixture.gradeId = grade!.id;

  const [section] = await db
    .insert(sections)
    .values({
      schoolId: fixture.schoolId,
      academicYearId: fixture.yearId,
      gradeLevelId: fixture.gradeId,
      name: 'A',
    })
    .returning({ id: sections.id });
  fixture.sectionId = section!.id;

  const [pupil] = await db
    .insert(students)
    .values({
      schoolId: fixture.schoolId,
      studentCode: `${code}/001`,
      givenName: 'Abebe',
      fatherName: 'Kebede',
      status: 'active',
    })
    .returning({ id: students.id });
  fixture.pupilId = pupil!.id;

  await db.insert(enrollments).values({
    schoolId: fixture.schoolId,
    studentId: pupil!.id,
    academicYearId: fixture.yearId,
    gradeLevelId: fixture.gradeId,
    sectionId: fixture.sectionId,
    status: 'enrolled',
    enrolledOn: '2025-09-11',
  });
}

before(async () => {
  db = await getDb();
  await seed(A, `wa-${stamp}`, 'Write Test A');
  await seed(B, `wb-${stamp}`, 'Write Test B');
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  invalidateSettingsCache();
  await closeDb();
});

// ---------------------------------------------------------------------------
// File type sniffing — the client's word is not evidence
// ---------------------------------------------------------------------------

test('CRITICAL: an HTML file named .pdf is refused', () => {
  // The exact attack: a browser will send whatever Content-Type it is told,
  // and serving stored HTML back would be script execution in the school's
  // own origin.
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  assert.equal(sniffType(html, 'birth-certificate.pdf'), null);
  assert.equal(sniffType(html, 'photo.png'), null);
});

test('CRITICAL: an SVG is refused however it is named', () => {
  // SVG is script-capable. An "image" that can run JavaScript is not an image
  // for this purpose.
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
  assert.equal(sniffType(svg, 'logo.svg'), null);
  assert.equal(sniffType(svg, 'logo.png'), null);
});

test('real formats are identified from their magic bytes, not their name', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
  assert.equal(sniffType(pdf, 'anything.txt')?.mimeType, 'application/pdf');

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
  assert.equal(sniffType(png, 'scan.pdf')?.mimeType, 'image/png');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  assert.equal(sniffType(jpeg, 'x')?.mimeType, 'image/jpeg');
});

test('an empty file and an unrecognised binary are refused', () => {
  assert.equal(sniffType(Buffer.alloc(0), 'empty.pdf'), null);
  // Random binary with a NUL and no signature.
  assert.equal(sniffType(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), 'thing.pdf'), null);
});

test('a bare zip is refused; an OOXML document is accepted', () => {
  const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const bareZip = Buffer.concat([zipHeader, Buffer.alloc(64)]);
  assert.equal(sniffType(bareZip, 'archive.zip'), null, 'an archive is not a school document');

  const docx = Buffer.concat([zipHeader, Buffer.from('word/document.xml'), Buffer.alloc(32)]);
  assert.equal(
    sniffType(docx, 'letter.docx')?.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
});

// ---------------------------------------------------------------------------
// Storage keys and filenames
// ---------------------------------------------------------------------------

test('CRITICAL: a filename cannot contain a path', () => {
  // Separators become underscores and the leading dots are stripped, so the
  // result can never be read as a path or as a hidden file. The name already
  // contains a dot, so no extension is appended — what matters is that no
  // `/`, `\` or leading `.` survives.
  for (const [input, expected] of [
    ['../../../../etc/passwd', '_.._.._.._etc_passwd'],
    ['../../../../etc/passwd.pdf', '_.._.._.._etc_passwd.pdf'],
    ['..\\..\\windows\\system32', '_.._windows_system32'],
  ] as const) {
    const out = safeFileName(input, 'pdf');
    assert.equal(out, expected);
    assert.ok(!out.includes('/') && !out.includes('\\'), 'no path separator may survive');
    assert.ok(!out.startsWith('.'), 'no leading dot');
  }
  // A leading dot would create a hidden file such as .htaccess.
  assert.ok(!safeFileName('.htaccess', 'txt').startsWith('.'));
  // Control characters are stripped rather than escaped.
  assert.ok(!safeFileName('a\u0000b\nc.pdf', 'pdf').includes('\u0000'));
  // An empty name still yields something openable.
  assert.equal(safeFileName('', 'pdf'), 'document.pdf');
  // A long name is truncated but keeps an extension.
  assert.ok(safeFileName('x'.repeat(500), 'pdf').length <= 130);
});

test('CRITICAL: a storage key is generated, and a crafted one is refused', async () => {
  const key = newStorageKey(A.schoolId);
  assert.match(key, /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  assert.ok(key.startsWith(`${A.schoolId}/`), 'keys are namespaced by school');

  // A round trip works.
  const bytes = Buffer.from('%PDF-1.4 hello');
  const checksum = await putObject(key, bytes);
  assert.match(checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(await getObject(key), bytes);

  // Anything that is not exactly <uuid>/<uuid> is rejected before it touches
  // the filesystem.
  for (const bad of [
    '../../../etc/passwd',
    '/etc/passwd',
    `${A.schoolId}/../../etc/passwd`,
    'a/b',
    '',
  ]) {
    await assert.rejects(() => getObject(bad), /Malformed storage key/, `must refuse: ${bad}`);
  }

  await deleteObject(key);
  // Deleting again is not an error: the metadata row is what a user sees.
  await deleteObject(key);
});

test('the same storage key is never overwritten', async () => {
  const key = newStorageKey(A.schoolId);
  await putObject(key, Buffer.from('first'));
  await assert.rejects(() => putObject(key, Buffer.from('second')));
  assert.equal((await getObject(key)).toString(), 'first');
  await deleteObject(key);
});

test('the upload ceiling is a sane size', () => {
  assert.ok(MAX_UPLOAD_BYTES > 1024 * 1024, 'must allow a scanned certificate');
  assert.ok(MAX_UPLOAD_BYTES <= 25 * 1024 * 1024, 'must not allow an unbounded upload');
});

// ---------------------------------------------------------------------------
// Stock corrections need a reason
// ---------------------------------------------------------------------------

test('CRITICAL: an adjustment or loss without a reason is refused', () => {
  const base = { quantity: 5, movedOn: '2026-09-10', reference: null, note: null };

  for (const movementType of ['adjustment', 'loss'] as const) {
    const result = stockMovementSchema.safeParse({ ...base, movementType });
    assert.equal(result.success, false, `${movementType} must require a reason`);
    if (!result.success) {
      assert.equal(result.error.issues[0]!.path.join('.'), 'reference');
    }
  }

  // Either field satisfies it — a reference for "stock take 2018", or a note.
  assert.ok(
    stockMovementSchema.safeParse({ ...base, movementType: 'adjustment', reference: 'Stock take' })
      .success,
  );
  assert.ok(
    stockMovementSchema.safeParse({ ...base, movementType: 'loss', note: 'Water damage' }).success,
  );
  // Whitespace is not a reason.
  assert.equal(
    stockMovementSchema.safeParse({ ...base, movementType: 'adjustment', reference: '   ' })
      .success,
    false,
  );
});

test('a receipt and an issue need no reason — they explain themselves', () => {
  const base = { quantity: 5, movedOn: '2026-09-10', reference: null, note: null };
  assert.ok(stockMovementSchema.safeParse({ ...base, movementType: 'receipt' }).success);
  assert.ok(stockMovementSchema.safeParse({ ...base, movementType: 'issue' }).success);
});

test('the service still owns the sign after the reason rule was added', async () => {
  const ctx = makeContext(A, A.adminUserId, ALL_PERMS);
  const item = await createInventoryItem(ctx, {
    name: 'Chalk',
    sku: null,
    category: null,
    unit: 'box',
    reorderLevel: 0,
    location: null,
    unitCostCents: null,
    active: true,
  });

  await recordMovement(ctx, item.id, {
    movementType: 'receipt',
    quantity: 20,
    movedOn: '2026-09-10',
    reference: null,
    note: null,
  });

  // An adjustment to 12 from 20 records -8, not 12.
  const movement = await recordMovement(ctx, item.id, {
    movementType: 'adjustment',
    quantity: 12,
    movedOn: '2026-09-11',
    reference: 'Stock take',
    note: null,
  });
  assert.equal(movement.delta, -8);
  assert.equal(movement.balanceAfter, 12);

  const [cached] = await db
    .select({ q: inventoryItems.quantity })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, item.id));
  assert.equal(cached!.q, 12);
});

// ---------------------------------------------------------------------------
// Event audience ownership
// ---------------------------------------------------------------------------

const EVENT_BASE = {
  description: null,
  endDate: null,
  startTime: null,
  endTime: null,
  allDay: true,
  location: null,
  colour: null,
  termId: null,
  visibleToPortal: true,
};

test("CRITICAL: an event cannot be addressed to another school's section", async () => {
  const ctx = makeContext(A, A.adminUserId, ALL_PERMS);

  await assert.rejects(
    () =>
      createEvent(ctx, {
        ...EVENT_BASE,
        title: 'Cross tenant',
        eventType: 'meeting',
        startDate: '2027-03-01',
        audience: { kind: 'sections', sectionIds: [B.sectionId] },
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
    "another school's section id must be refused",
  );

  await assert.rejects(
    () =>
      createEvent(ctx, {
        ...EVENT_BASE,
        title: 'Cross tenant grade',
        eventType: 'meeting',
        startDate: '2027-03-01',
        audience: { kind: 'grades', gradeIds: [B.gradeId] },
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );

  // A mix of one valid and one foreign id is still refused entirely.
  await assert.rejects(
    () =>
      createEvent(ctx, {
        ...EVENT_BASE,
        title: 'Half valid',
        eventType: 'meeting',
        startDate: '2027-03-01',
        audience: { kind: 'sections', sectionIds: [A.sectionId, B.sectionId] },
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
  );
});

test("an event cannot be EDITED to point at another school's section", async () => {
  const ctx = makeContext(A, A.adminUserId, ALL_PERMS);
  const created = await createEvent(ctx, {
    ...EVENT_BASE,
    title: 'Own section',
    eventType: 'meeting',
    startDate: '2027-03-02',
    audience: { kind: 'sections', sectionIds: [A.sectionId] },
  });

  await assert.rejects(
    () =>
      updateEvent(ctx, created.id, {
        ...EVENT_BASE,
        title: 'Own section',
        eventType: 'meeting',
        startDate: '2027-03-02',
        audience: { kind: 'sections', sectionIds: [B.sectionId] },
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
    'the update path needs the same check as the create path',
  );
});

test('a role audience is not treated as a cross-tenant reference', async () => {
  // Role keys are words, not ids: `teacher` means "teachers of this school"
  // because the match is against the reader's own role keys. Requiring a
  // `roles` row here would reject a school addressing a key it has not
  // defined, so it is deliberately not checked.
  const ctx = makeContext(A, A.adminUserId, ALL_PERMS);
  const created = await createEvent(ctx, {
    ...EVENT_BASE,
    title: 'Staff briefing',
    eventType: 'meeting',
    startDate: '2027-03-03',
    audience: { kind: 'roles', roles: ['teacher'] },
  });
  assert.equal((created.audience as { kind: string }).kind, 'roles');
});

test('an "everyone" audience needs no ownership check', async () => {
  const ctx = makeContext(A, A.adminUserId, ALL_PERMS);
  const created = await createEvent(ctx, {
    ...EVENT_BASE,
    title: 'Everyone',
    eventType: 'activity',
    startDate: '2027-03-04',
    audience: { kind: 'all' },
  });
  assert.ok(created.id);
});

// ---------------------------------------------------------------------------
// Library copy status — the route added for the UI
// ---------------------------------------------------------------------------

async function makeTitleWithCopies(fixture: Fixture) {
  const ctx = makeContext(fixture, fixture.adminUserId, ALL_PERMS);
  const item = await createLibraryItem(ctx, {
    title: `Test Title ${Math.random()}`,
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
  });
  await addCopies(ctx, item.id, { count: 2, prefix: null, condition: 'good', acquiredOn: null });
  return { ctx, item };
}

test('a copy can be marked damaged, and the availability count follows', async () => {
  const { ctx, item } = await makeTitleWithCopies(A);
  const before = await listCopies(ctx, item.id);
  assert.equal(before.length, 2);

  await updateCopy(ctx, before[0]!.id, {
    accessionNumber: before[0]!.accessionNumber,
    status: 'damaged',
    condition: 'poor',
    acquiredOn: null,
    note: 'Water damage',
  });

  const after = await listCopies(ctx, item.id);
  assert.equal(after.find((c) => c.id === before[0]!.id)!.status, 'damaged');
  assert.equal(
    after.filter((c) => c.status === 'available').length,
    1,
    'a damaged copy is no longer available',
  );
});

test('CRITICAL: a copy belonging to another school cannot be updated', async () => {
  const { item: itemB } = await makeTitleWithCopies(B);
  const ctxB = makeContext(B, B.adminUserId, ALL_PERMS);
  const copiesB = await listCopies(ctxB, itemB.id);

  const ctxA = makeContext(A, A.adminUserId, ALL_PERMS);
  await assert.rejects(
    () =>
      updateCopy(ctxA, copiesB[0]!.id, {
        accessionNumber: 'HACKED',
        status: 'lost',
        condition: 'poor',
        acquiredOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof OperationsError && e.status === 404,
    'a foreign copy id must read as missing, not forbidden',
  );

  // And it is genuinely unchanged.
  const [still] = await db
    .select({ status: libraryCopies.status, accession: libraryCopies.accessionNumber })
    .from(libraryCopies)
    .where(eq(libraryCopies.id, copiesB[0]!.id));
  assert.equal(still!.status, 'available');
  assert.notEqual(still!.accession, 'HACKED');
});

test('updating a copy requires library.manage', async () => {
  const { ctx, item } = await makeTitleWithCopies(A);
  const copies = await listCopies(ctx, item.id);

  const viewer = makeContext(A, A.teacherUserId, ['library.view']);
  await assert.rejects(
    () =>
      updateCopy(viewer, copies[0]!.id, {
        accessionNumber: copies[0]!.accessionNumber,
        status: 'lost',
        condition: 'poor',
        acquiredOn: null,
        note: null,
      }),
    (e: unknown) => e instanceof AuthError && e.status === 403,
  );
});

test('the catalogue still has no stored availability column', async () => {
  // The write UI shows an availability number. It must remain derived — a
  // cached count is what drifts when two librarians work at once.
  const columns = (await db.execute(
    `select column_name from information_schema.columns where table_name = 'library_items'`,
  )) as { rows: { column_name: string }[] };
  const names = columns.rows.map((r) => r.column_name);
  for (const forbidden of ['available_count', 'available_copies', 'stock', 'copy_count']) {
    assert.ok(!names.includes(forbidden), `library_items must not store ${forbidden}`);
  }
  assert.ok(names.includes('title'));
});

test('library items and copies stay school-scoped after the new writes', async () => {
  const [itemsA] = await db
    .select({ n: libraryItems.id })
    .from(libraryItems)
    .where(and(eq(libraryItems.schoolId, A.schoolId), eq(libraryItems.active, true)))
    .limit(1);
  assert.ok(itemsA, 'school A has its own items');

  const crossed = await db
    .select({ id: libraryCopies.id })
    .from(libraryCopies)
    .innerJoin(libraryItems, eq(libraryItems.id, libraryCopies.itemId))
    .where(and(eq(libraryCopies.schoolId, A.schoolId), eq(libraryItems.schoolId, B.schoolId)));
  assert.equal(crossed.length, 0, 'no copy may point at another school’s title');
});
