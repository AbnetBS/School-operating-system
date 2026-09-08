/**
 * Bulk import tests.
 *
 * The contract that matters: a validation run must never write anything, and a
 * commit must write only the rows that passed. Everything else here guards the
 * ways a spreadsheet from a school office differs from clean data.
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
  auditLog,
} from '../src/db/schema/core.ts';
import { students, guardians, studentGuardians } from '../src/db/schema/people.ts';
import { importStudents, buildStudentTemplate } from '../src/lib/import/students.ts';
import { parseSheet, normaliseHeader, toCsv } from '../src/lib/import/csv.ts';

let db: Database;

type Fixture = {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  adminUserId: string;
};

const A: Fixture = {} as Fixture;

function contextFor(fixture: Fixture) {
  const permissions = ['student.import', 'student.create', 'student.view', 'guardian.manage'];
  return {
    db,
    schoolId: fixture.schoolId,
    user: { userId: fixture.adminUserId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    displayName: () => 'Test User',
  } as never;
}

before(async () => {
  db = await getDb();
  const [school] = await db
    .insert(schools)
    .values({ code: `imp-${Date.now()}`, name: 'Import Test', isActive: true })
    .returning({ id: schools.id });
  A.schoolId = school!.id;

  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId: A.schoolId,
      name: '2018 E.C.',
      ethiopianYear: 2018,
      startDate: '2025-09-11',
      endDate: '2026-07-07',
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  A.yearId = year!.id;

  const [grade] = await db
    .insert(gradeLevels)
    .values({ schoolId: A.schoolId, name: 'Grade 5', level: 5 })
    .returning({ id: gradeLevels.id });
  A.gradeId = grade!.id;

  const [section] = await db
    .insert(sections)
    .values({
      schoolId: A.schoolId,
      academicYearId: A.yearId,
      gradeLevelId: A.gradeId,
      name: 'A',
    })
    .returning({ id: sections.id });
  A.sectionA = section!.id;

  const [admin] = await db
    .insert(users)
    .values({ schoolId: A.schoolId, username: 'admin', passwordHash: 'x', givenName: 'Admin' })
    .returning({ id: users.id });
  A.adminUserId = admin!.id;
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await closeDb();
});

async function studentCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(students)
    .where(eq(students.schoolId, A.schoolId));
  return row!.n;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test('quoted fields, embedded commas and a UTF-8 BOM are handled', () => {
  const csv = '\uFEFFGiven Name,Address\r\nAbebe,"Bole, Addis Ababa"\r\n';
  const sheet = parseSheet(csv);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheet.rows[0]!.givenname, 'Abebe');
  assert.equal(sheet.rows[0]!.address, 'Bole, Addis Ababa');
});

test('a semicolon-delimited export is detected', () => {
  const sheet = parseSheet('Given Name;Father Name\nAbebe;Kebede\n');
  assert.equal(sheet.rows[0]!.givenname, 'Abebe');
  assert.equal(sheet.rows[0]!.fathername, 'Kebede');
});

test('header matching ignores case, spacing and punctuation', () => {
  assert.equal(normaliseHeader('Given Name (Amharic)'), 'givennameamharic');
  assert.equal(normaliseHeader('  GIVEN_NAME  '), 'givenname');
  assert.equal(normaliseHeader('given-name'), 'givenname');
});

test('blank lines are skipped but row numbers still match the spreadsheet', () => {
  const sheet = parseSheet('Given Name\nAbebe\n\n\nHanna\n');
  assert.equal(sheet.rows.length, 2);
  assert.deepEqual(sheet.rowNumbers, [2, 5], 'row numbers must point at the real lines');
});

test('CSV output is re-readable and keeps Amharic intact', () => {
  const csv = toCsv(['Name'], [['ተስፋዬ']]);
  const back = parseSheet(csv);
  assert.equal(back.rows[0]!.name, 'ተስፋዬ');
});

// ---------------------------------------------------------------------------
// Validation writes nothing
// ---------------------------------------------------------------------------

test('a validation run writes absolutely nothing', async () => {
  const before = await studentCount();

  const report = await importStudents(contextFor(A), {
    fileText:
      'Student ID,Given Name,Father Name,Grade Level,Section\n' +
      ',Abebe,Kebede,Grade 5,A\n' +
      ',Hanna,Girma,Grade 5,A\n',
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.mode, 'validate');
  assert.equal(report.readyCount, 2);
  assert.equal(report.importedCount, 0);
  assert.equal(await studentCount(), before, 'the preview must not create students');
});

test('the shipped template validates cleanly against itself', async () => {
  const report = await importStudents(contextFor(A), {
    fileText: buildStudentTemplate(),
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.deepEqual(report.missingRequiredColumns, [], 'our own template must have every required column');
  assert.deepEqual(report.unknownColumns, [], 'every column we emit must be one we can read back');
});

test('missing required columns are reported rather than guessed at', async () => {
  const report = await importStudents(contextFor(A), {
    fileText: 'Nickname,Favourite Colour\nAbe,Blue\n',
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.ok(report.missingRequiredColumns.includes('Given Name'));
  assert.ok(report.missingRequiredColumns.includes('Grade Level'));
  assert.equal(report.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Per-row validation
// ---------------------------------------------------------------------------

test('bad rows are reported individually with the spreadsheet row number', async () => {
  const report = await importStudents(contextFor(A), {
    fileText:
      'Student ID,Given Name,Father Name,Gender,Date of Birth,Grade Level,Section,Guardian Name,Guardian Phone\n' +
      ',Good,Student,male,2013-01-01,Grade 5,A,,\n' +
      ',BadGrade,Student,male,2013-01-01,Grade 99,A,,\n' +
      ',BadDate,Student,female,31/31/2013,Grade 5,A,,\n' +
      ',BadGender,Student,alien,2013-01-01,Grade 5,A,,\n' +
      ',BadPhone,Student,male,2013-01-01,Grade 5,A,Someone,12345\n' +
      ',,NoGivenName,male,2013-01-01,Grade 5,A,,\n',
    academicYearId: A.yearId,
    mode: 'validate',
  });

  const byRow = new Map(report.rows.map((r) => [r.rowNumber, r]));
  assert.equal(byRow.get(2)!.status, 'ready');
  assert.ok(byRow.get(3)!.errors.gradeLevel, 'unknown grade must be reported');
  assert.ok(byRow.get(4)!.errors.dateOfBirth, '31/31 is not a real date');
  assert.ok(byRow.get(5)!.errors.gender, 'unreadable gender must be reported');
  assert.ok(byRow.get(6)!.errors.guardianPhone, '12345 is not a phone number');
  assert.ok(byRow.get(7)!.errors.givenName, 'a missing name must be reported');
  assert.equal(report.errorCount, 5);
});

test('day-first dates are accepted, as written on Ethiopian admission forms', async () => {
  const report = await importStudents(contextFor(A), {
    fileText:
      'Given Name,Father Name,Date of Birth,Grade Level\n' + 'Dated,Student,14/05/2012,Grade 5\n',
    academicYearId: A.yearId,
    mode: 'validate',
  });
  assert.equal(report.rows[0]!.status, 'ready');
  assert.deepEqual(report.rows[0]!.errors, {});
});

test('a duplicate student ID inside the file is caught before writing', async () => {
  const report = await importStudents(contextFor(A), {
    fileText:
      'Student ID,Given Name,Father Name,Grade Level\n' +
      'DUP/1,First,Student,Grade 5\n' +
      'DUP/1,Second,Student,Grade 5\n',
    academicYearId: A.yearId,
    mode: 'validate',
  });

  assert.equal(report.rows[0]!.status, 'ready');
  assert.ok(report.rows[1]!.errors.studentCode, 'the second occurrence must be flagged');
});

test('unrecognised columns are surfaced, not silently ignored', async () => {
  const report = await importStudents(contextFor(A), {
    fileText: 'Given Name,Father Name,Grade Level,Blood Type Xyz\nA,B,Grade 5,O\n',
    academicYearId: A.yearId,
    mode: 'validate',
  });
  assert.ok(report.unknownColumns.includes('Blood Type Xyz'));
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

test('committing imports the good rows, skips the bad, and audits the run', async () => {
  const before = await studentCount();

  const report = await importStudents(contextFor(A), {
    fileText:
      'Student ID,Given Name,Father Name,Given Name (Amharic),Gender,Grade Level,Section,Guardian Name,Guardian Phone\n' +
      'IMP/1,Tesfaye,Alemu,ተስፋዬ,male,Grade 5,A,Alemu Bekele,0911777001\n' +
      'IMP/2,Hanna,Girma,ሃና,female,Grade 5,A,,\n' +
      ',Broken,Row,,male,Grade 99,A,,\n',
    academicYearId: A.yearId,
    mode: 'commit',
  });

  assert.equal(report.importedCount, 2);
  assert.equal(report.errorCount, 1);
  assert.equal(await studentCount(), before + 2);

  // The Amharic name and the guardian link came across.
  const [imported] = await db
    .select({ id: students.id, givenNameAm: students.givenNameAm })
    .from(students)
    .where(and(eq(students.schoolId, A.schoolId), eq(students.studentCode, 'IMP/1')));
  assert.equal(imported!.givenNameAm, 'ተስፋዬ');

  const links = await db
    .select({ guardianId: studentGuardians.guardianId })
    .from(studentGuardians)
    .where(eq(studentGuardians.studentId, imported!.id));
  assert.equal(links.length, 1, 'the guardian named in the file was created and linked');

  const [guardian] = await db
    .select({ phone: guardians.phone })
    .from(guardians)
    .where(eq(guardians.id, links[0]!.guardianId));
  assert.equal(guardian!.phone, '+251911777001', 'the phone was normalised on the way in');

  // A bulk write of personal records must be traceable.
  const audits = await db
    .select({ action: auditLog.action, summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'student.import')));
  assert.equal(audits.length, 1, 'the import itself must be audited');
  assert.match(audits[0]!.summary ?? '', /2 students/);

  // And each created student is audited individually too.
  const creates = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.schoolId, A.schoolId), eq(auditLog.action, 'student.create')));
  assert.ok(creates.length >= 2, 'each imported student must have its own audit row');
});

test('a student ID already used in the school is refused at commit', async () => {
  const before = await studentCount();

  const report = await importStudents(contextFor(A), {
    fileText: 'Student ID,Given Name,Father Name,Grade Level\nIMP/1,Clash,Student,Grade 5\n',
    academicYearId: A.yearId,
    mode: 'commit',
  });

  assert.equal(report.importedCount, 0);
  assert.ok(report.rows[0]!.errors.studentCode);
  assert.equal(await studentCount(), before, 'nothing was written');
});

test('rows the user unticked in the preview are skipped', async () => {
  const before = await studentCount();

  const report = await importStudents(contextFor(A), {
    fileText:
      'Student ID,Given Name,Father Name,Grade Level\n' +
      'SKIP/1,Wanted,Student,Grade 5\n' +
      'SKIP/2,Unwanted,Student,Grade 5\n',
    academicYearId: A.yearId,
    mode: 'commit',
    skipRowNumbers: [3],
  });

  assert.equal(report.importedCount, 1);
  assert.equal(await studentCount(), before + 1);

  const found = await db
    .select({ code: students.studentCode })
    .from(students)
    .where(and(eq(students.schoolId, A.schoolId), eq(students.studentCode, 'SKIP/2')));
  assert.equal(found.length, 0, 'the unticked row must not be imported');
});

test('student IDs are generated for rows that leave the column blank', async () => {
  const report = await importStudents(contextFor(A), {
    fileText: 'Student ID,Given Name,Father Name,Grade Level\n,Generated,Student,Grade 5\n',
    academicYearId: A.yearId,
    mode: 'commit',
  });

  assert.equal(report.importedCount, 1);
  const code = report.rows[0]!.preview.studentCode;
  assert.notEqual(code, '(auto)');
  assert.match(code, /2018/, 'the configured code format is used');
});

test('a CSV with more rows than the limit reports truncation instead of dropping the tail', () => {
  const lines = ['Given Name,Father Name,Grade Level'];
  for (let i = 1; i <= 12; i++) lines.push(`Student${i},Test,Grade 5`);

  const sheet = parseSheet(lines.join('\n'), 5);
  assert.equal(sheet.rows.length, 5);
  assert.equal(sheet.truncatedAt, 5, 'the caller must be told rows were left out');

  const withinLimit = parseSheet(lines.slice(0, 4).join('\n'), 5);
  assert.equal(withinLimit.truncatedAt, undefined);
});
