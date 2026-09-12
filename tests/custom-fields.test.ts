/**
 * School-defined custom fields (Group 10).
 *
 * The table `custom_field_defs` shipped in migration 0000 but nothing used it,
 * so `students.customFields` accepted arbitrary JSON. This was demonstrated
 * against the running system before the feature was built:
 *
 *   POST /api/students { customFields: { totally_made_up: "accepted",
 *                                        nested: { deep: [1,2,3] } } }  → 201
 *
 * The most important test in this file is therefore the one asserting that an
 * undefined key is now *rejected* rather than stored. The rest cover the
 * definition rules, per-type value validation, tenant isolation, and the
 * deactivation semantics that protect already-captured data.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { getDb, closeDb, type Database } from '../src/db/client.ts';
import { schools, users, academicYears, gradeLevels, sections } from '../src/db/schema/core.ts';
import { students } from '../src/db/schema/people.ts';
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  validateCustomFieldValues,
  RESERVED_FIELD_KEYS,
  type FieldDefinition,
} from '../src/lib/customFields/schema.ts';
import {
  createDefinition,
  updateDefinition,
  getActiveDefinitions,
  listDefinitions,
  resolveCustomFieldValues,
  countRecordsUsing,
  countUsageForDefinitions,
  invalidateCustomFieldCache,
} from '../src/lib/customFields/service.ts';
import { createStudent } from '../src/lib/students/service.ts';

let db: Database;

type Fixture = { schoolId: string; yearId: string; gradeId: string; sectionId: string; adminId: string };
const A: Fixture = {} as Fixture;
const B: Fixture = {} as Fixture;

const STAMP = Date.now();

function contextFor(fixture: Fixture, permissions: string[]) {
  return {
    db,
    schoolId: fixture.schoolId,
    user: { id: fixture.adminId, userId: fixture.adminId, givenName: 'Test', fatherName: 'User' },
    ipAddress: '127.0.0.1',
    has: (p: string) => permissions.includes(p),
    hasAny: (...list: string[]) => list.some((p) => permissions.includes(p)),
    displayName: () => 'Test User',
  } as never;
}

async function seedSchool(code: string, fixture: Fixture) {
  const [school] = await db
    .insert(schools)
    .values({ code, name: `CF ${code}`, isActive: true })
    .returning({ id: schools.id });
  fixture.schoolId = school!.id;

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
    .values({ schoolId: fixture.schoolId, name: 'Grade 5', level: 5 })
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

  const [admin] = await db
    .insert(users)
    .values({ schoolId: fixture.schoolId, username: 'admin', passwordHash: 'x', givenName: 'Admin' })
    .returning({ id: users.id });
  fixture.adminId = admin!.id;
}

before(async () => {
  db = await getDb();
  await seedSchool(`CFA${STAMP}`, A);
  await seedSchool(`CFB${STAMP}`, B);
});

after(async () => {
  await db.delete(schools).where(eq(schools.id, A.schoolId));
  await db.delete(schools).where(eq(schools.id, B.schoolId));
  invalidateCustomFieldCache();
  await closeDb();
});

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

test('a field key must be a usable identifier', () => {
  const bad = ['', '1field', 'has space', 'has-dash', 'has.dot', 'x'.repeat(65), 'émoji'];
  for (const key of bad) {
    const result = createCustomFieldSchema.safeParse({
      entityType: 'student',
      key,
      label: 'Label',
      fieldType: 'text',
    });
    assert.equal(result.success, false, `key "${key}" must be rejected`);
  }

  for (const key of ['busStop', 'bus_stop', 'a', 'field2']) {
    const result = createCustomFieldSchema.safeParse({
      entityType: 'student',
      key,
      label: 'Label',
      fieldType: 'text',
    });
    assert.equal(result.success, true, `key "${key}" must be accepted`);
  }
});

test('reserved keys cannot be shadowed by a custom field', () => {
  // Both hazards: real columns, and JavaScript internals.
  for (const key of ['givenName', 'status', 'id', '__proto__', 'constructor', 'prototype']) {
    const result = createCustomFieldSchema.safeParse({
      entityType: 'student',
      key,
      label: 'Sneaky',
      fieldType: 'text',
    });
    assert.equal(result.success, false, `reserved key "${key}" must be rejected`);
  }
  assert.ok(RESERVED_FIELD_KEYS.has('__proto__'));
  assert.ok(RESERVED_FIELD_KEYS.has('givenName'));
});

test('a choice field must offer at least one unique option', () => {
  const none = createCustomFieldSchema.safeParse({
    entityType: 'student',
    key: 'house',
    label: 'House',
    fieldType: 'select',
    options: [],
  });
  assert.equal(none.success, false, 'a select with no options is unanswerable');

  const dupes = createCustomFieldSchema.safeParse({
    entityType: 'student',
    key: 'house',
    label: 'House',
    fieldType: 'select',
    options: ['Red', 'red'],
  });
  assert.equal(dupes.success, false, 'duplicate options must be rejected');

  const good = createCustomFieldSchema.safeParse({
    entityType: 'student',
    key: 'house',
    label: 'House',
    fieldType: 'select',
    options: ['Red', 'Blue'],
  });
  assert.equal(good.success, true);
});

test('an update cannot rename the key or move the field to another entity', () => {
  // Both would orphan values already written under the old key.
  const parsed = updateCustomFieldSchema.safeParse({
    label: 'New label',
    key: 'renamed',
    entityType: 'staff',
  });
  assert.equal(parsed.success, true, 'unknown properties are stripped, not fatal');
  const data = parsed.success ? (parsed.data as Record<string, unknown>) : {};
  assert.equal('key' in data, false, 'key must never survive an update payload');
  assert.equal('entityType' in data, false, 'entityType must never survive an update payload');
});

test('an empty update is refused', () => {
  assert.equal(updateCustomFieldSchema.safeParse({}).success, false);
});

// ---------------------------------------------------------------------------
// Value validation — generated from the school's own definitions
// ---------------------------------------------------------------------------

const DEFS: FieldDefinition[] = [
  { key: 'busStop', label: 'Bus stop', fieldType: 'text', options: null, isRequired: false },
  { key: 'siblings', label: 'Siblings', fieldType: 'number', options: null, isRequired: false },
  { key: 'joinedOn', label: 'Joined on', fieldType: 'date', options: null, isRequired: false },
  { key: 'house', label: 'House', fieldType: 'select', options: ['Red', 'Blue'], isRequired: false },
  { key: 'boarder', label: 'Boarder', fieldType: 'boolean', options: null, isRequired: false },
];

test('CRITICAL: a key the school never defined is rejected, not stored', () => {
  // This is the exact payload that returned 201 before the feature existed.
  const result = validateCustomFieldValues(DEFS, {
    totally_made_up: 'accepted',
    nested: { deep: [1, 2, 3] },
  });
  assert.equal(result.ok, false);
  const fields = result.ok ? {} : result.fields;
  assert.equal(
    fields['customFields.totally_made_up'],
    'That field is not defined for this school.',
  );
});

test('a school with no definitions accepts only an empty object', () => {
  assert.equal(validateCustomFieldValues([], {}).ok, true);
  assert.equal(validateCustomFieldValues([], { anything: 'x' }).ok, false);
  // Absent and null are both "nothing supplied".
  assert.equal(validateCustomFieldValues([], undefined).ok, true);
  assert.equal(validateCustomFieldValues([], null).ok, true);
});

test('each field type validates its own values', () => {
  const good = validateCustomFieldValues(DEFS, {
    busStop: 'Megenagna',
    siblings: 3,
    joinedOn: '2025-09-11',
    house: 'Red',
    boarder: true,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok ? good.values : null, {
    busStop: 'Megenagna',
    siblings: 3,
    joinedOn: '2025-09-11',
    house: 'Red',
    boarder: true,
  });

  assert.equal(validateCustomFieldValues(DEFS, { siblings: 'three' }).ok, false);
  assert.equal(validateCustomFieldValues(DEFS, { joinedOn: '11/09/2025' }).ok, false);
  assert.equal(validateCustomFieldValues(DEFS, { house: 'Green' }).ok, false);
  assert.equal(validateCustomFieldValues(DEFS, { boarder: 'yes' }).ok, false);
});

test('a required field must actually be supplied', () => {
  const required: FieldDefinition[] = [
    { key: 'busStop', label: 'Bus stop', fieldType: 'text', options: null, isRequired: true },
  ];
  assert.equal(validateCustomFieldValues(required, {}).ok, false, 'omitted');
  assert.equal(validateCustomFieldValues(required, { busStop: '' }).ok, false, 'blank');
  assert.equal(validateCustomFieldValues(required, { busStop: '   ' }).ok, false, 'whitespace');
  assert.equal(validateCustomFieldValues(required, { busStop: 'Bole' }).ok, true);
});

test('an optional field may be cleared, and blanks are dropped rather than stored', () => {
  const result = validateCustomFieldValues(DEFS, { busStop: '', siblings: null });
  assert.equal(result.ok, true);
  // A cleared field disappears instead of lingering as "" or null.
  assert.deepEqual(result.ok ? result.values : null, {});
});

test('boundary values are handled', () => {
  assert.equal(validateCustomFieldValues(DEFS, { siblings: 0 }).ok, true, 'zero is a real answer');
  assert.equal(validateCustomFieldValues(DEFS, { siblings: -1 }).ok, true, 'negatives parse');
  assert.equal(
    validateCustomFieldValues(DEFS, { siblings: Number.POSITIVE_INFINITY }).ok,
    false,
    'infinity is not a number a school can act on',
  );
  assert.equal(
    validateCustomFieldValues(DEFS, { busStop: 'x'.repeat(2001) }).ok,
    false,
    'text is capped',
  );
  assert.equal(validateCustomFieldValues(DEFS, { boarder: false }).ok, true, 'false is a value');
});

test('a select whose options were emptied refuses values instead of crashing', () => {
  const broken: FieldDefinition[] = [
    { key: 'house', label: 'House', fieldType: 'select', options: [], isRequired: false },
  ];
  // Must not throw while building the enum.
  const result = validateCustomFieldValues(broken, { house: 'Red' });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Definitions in the database
// ---------------------------------------------------------------------------

test('a definition is created and becomes active for its school only', async () => {
  const def = await createDefinition(db, A.schoolId, {
    entityType: 'student',
    key: 'busStop',
    label: 'Bus stop',
    labelAm: 'የአውቶቡስ ማቆሚያ',
    fieldType: 'text',
    isRequired: false,
    sortOrder: 0,
  });
  assert.equal(def.key, 'busStop');
  assert.equal(def.isActive, true);

  const mine = await getActiveDefinitions(db, A.schoolId, 'student');
  assert.equal(mine.length, 1);

  // CRITICAL: the other school must not inherit it.
  const theirs = await getActiveDefinitions(db, B.schoolId, 'student');
  assert.equal(theirs.length, 0, 'definitions must not leak across schools');
});

test('the same key may be reused by a different school and a different entity', async () => {
  // Same key, other school — allowed.
  const other = await createDefinition(db, B.schoolId, {
    entityType: 'student',
    key: 'busStop',
    label: 'Bus stop',
    fieldType: 'text',
    isRequired: false,
    sortOrder: 0,
  });
  assert.ok(other.id);

  // Same key, same school, different entity — allowed.
  const staffField = await createDefinition(db, A.schoolId, {
    entityType: 'staff',
    key: 'busStop',
    label: 'Bus stop',
    fieldType: 'text',
    isRequired: false,
    sortOrder: 0,
  });
  assert.ok(staffField.id);
});

test('a duplicate key in the same school and entity is refused', async () => {
  await assert.rejects(
    () =>
      createDefinition(db, A.schoolId, {
        entityType: 'student',
        key: 'busStop',
        label: 'Another bus stop',
        fieldType: 'text',
        isRequired: false,
        sortOrder: 0,
      }),
    (error: Error & { status?: number }) => error.status === 409,
  );
});

test('a definition belonging to another school cannot be edited with a forged id', async () => {
  const [target] = await listDefinitions(db, B.schoolId, 'student');
  assert.ok(target, 'school B has a definition to target');

  await assert.rejects(
    () => updateDefinition(db, A.schoolId, target!.id, { label: 'Hijacked' }),
    (error: Error & { status?: number }) => error.status === 404,
    'a cross-tenant id must be invisible, not editable',
  );

  const [unchanged] = await listDefinitions(db, B.schoolId, 'student');
  assert.equal(unchanged!.label, 'Bus stop', "school B's definition must be untouched");
});

test('deactivating hides the field from forms but keeps captured values', async () => {
  const def = await createDefinition(db, A.schoolId, {
    entityType: 'student',
    key: 'tempField',
    label: 'Temporary',
    fieldType: 'text',
    isRequired: false,
    sortOrder: 5,
  });

  const ctx = contextFor(A, ['student.create']);
  const { id: studentId } = await createStudent(
    ctx,
    {
      studentCode: `CF/${STAMP}/1`,
      givenName: 'Kebede',
      fatherName: 'Alemu',
      gender: 'male',
      gradeLevelId: A.gradeId,
      sectionId: A.sectionId,
      status: 'active',
      customFields: { busStop: 'Bole', tempField: 'keep me' },
    } as never,
    A.yearId,
  );

  const usage = await countRecordsUsing(db, A.schoolId, 'student', 'tempField');
  assert.equal(usage, 1, 'one record holds a value for this field');

  await updateDefinition(db, A.schoolId, def.id, { isActive: false });

  // Gone from the form...
  const active = await getActiveDefinitions(db, A.schoolId, 'student');
  assert.equal(
    active.some((d) => d.key === 'tempField'),
    false,
  );

  // ...but the captured value survives in the record.
  const [row] = await db.select().from(students).where(eq(students.id, studentId));
  assert.equal(
    (row!.customFields as Record<string, unknown>)['tempField'],
    'keep me',
    'deactivation must not destroy data already collected',
  );

  // And a new write may no longer use it.
  await assert.rejects(
    () => resolveCustomFieldValues(db, A.schoolId, 'student', { tempField: 'nope' }),
    (error: Error & { status?: number }) => error.status === 400,
  );
});

test('a deactivated key cannot be re-created as a duplicate', async () => {
  await assert.rejects(
    () =>
      createDefinition(db, A.schoolId, {
        entityType: 'student',
        key: 'tempField',
        label: 'Temporary again',
        fieldType: 'text',
        isRequired: false,
        sortOrder: 0,
      }),
    (error: Error & { status?: number }) => error.status === 409,
  );
});

test('a select cannot be left active with no options', async () => {
  const def = await createDefinition(db, A.schoolId, {
    entityType: 'student',
    key: 'house',
    label: 'House',
    fieldType: 'select',
    options: ['Red', 'Blue'],
    isRequired: false,
    sortOrder: 1,
  });

  await assert.rejects(
    () => updateDefinition(db, A.schoolId, def.id, { options: [] }),
    (error: Error & { status?: number }) => error.status === 400,
    'an active select with no options is an unanswerable question',
  );

  // Emptying options is allowed if the field is being retired at the same time.
  const { after: retired } = await updateDefinition(db, A.schoolId, def.id, {
    options: [],
    isActive: false,
  });
  assert.equal(retired.isActive, false);
});

// ---------------------------------------------------------------------------
// End to end through the student service
// ---------------------------------------------------------------------------

test('CRITICAL: the student service now refuses an undefined custom field', async () => {
  const ctx = contextFor(A, ['student.create']);

  await assert.rejects(
    () =>
      createStudent(
        ctx,
        {
          studentCode: `CF/${STAMP}/3`,
          givenName: 'Sara',
          fatherName: 'Tesfaye',
          gender: 'female',
          gradeLevelId: A.gradeId,
          sectionId: A.sectionId,
          status: 'active',
          customFields: { totally_made_up: 'accepted', nested: { deep: [1, 2, 3] } },
        } as never,
        A.yearId,
      ),
    (error: Error & { status?: number }) => error.status === 400,
    'the payload that used to return 201 must now be a 400',
  );
});

test('a defined custom field is stored on the student record', async () => {
  const ctx = contextFor(A, ['student.create']);
  const { id } = await createStudent(
    ctx,
    {
      studentCode: `CF/${STAMP}/2`,
      givenName: 'Meron',
      fatherName: 'Girma',
      gender: 'female',
      gradeLevelId: A.gradeId,
      sectionId: A.sectionId,
      status: 'active',
      customFields: { busStop: 'Megenagna' },
    } as never,
    A.yearId,
  );

  const [row] = await db.select().from(students).where(eq(students.id, id));
  assert.deepEqual(row!.customFields, { busStop: 'Megenagna' });
});

test("one school's field cannot be used on another school's student", async () => {
  // 'house' is defined for school A (now retired) and never for school B.
  await assert.rejects(
    () => resolveCustomFieldValues(db, B.schoolId, 'student', { house: 'Red' }),
    (error: Error & { status?: number }) => error.status === 400,
    'a field defined elsewhere must not validate here',
  );

  // And B's own field still works, proving the rejection is scoping and not
  // a blanket failure.
  const okValues = await resolveCustomFieldValues(db, B.schoolId, 'student', {
    busStop: 'Piassa',
  });
  assert.deepEqual(okValues, { busStop: 'Piassa' });
});

// ---------------------------------------------------------------------------
// Usage counting
// ---------------------------------------------------------------------------

test('batched usage counts agree with counting one field at a time', async () => {
  // The settings page renders a count per definition. Doing that with one
  // query per field is an N+1; the batched version must produce identical
  // numbers or the optimisation is a bug.
  const defs = await listDefinitions(db, A.schoolId);
  assert.ok(defs.length >= 3, 'the fixture defined several fields');

  const batched = await countUsageForDefinitions(db, A.schoolId, defs);

  for (const def of defs) {
    const individual = await countRecordsUsing(db, A.schoolId, def.entityType, def.key);
    assert.equal(
      batched[def.id],
      individual,
      `count for "${def.key}" must match however it is computed`,
    );
  }
});

test('usage counting is scoped to the school and handles an empty list', async () => {
  assert.deepEqual(await countUsageForDefinitions(db, A.schoolId, []), {});

  // School B has its own busStop with no values recorded against it.
  const bDefs = await listDefinitions(db, B.schoolId, 'student');
  const bUsage = await countUsageForDefinitions(db, B.schoolId, bDefs);
  for (const def of bDefs) {
    assert.equal(bUsage[def.id], 0, "school B's fields hold no values");
  }
});

// ---------------------------------------------------------------------------
// Cache correctness
// ---------------------------------------------------------------------------

test('a newly defined field is usable immediately, not after the cache expires', async () => {
  // Definitions are cached because they are read on every student write. If a
  // write did not invalidate, a school would define a field and then be told
  // it "is not defined" for the next 30 seconds.
  await getActiveDefinitions(db, A.schoolId, 'guardian'); // prime the cache (empty)

  await createDefinition(db, A.schoolId, {
    entityType: 'guardian',
    key: 'workplace',
    label: 'Workplace',
    fieldType: 'text',
    isRequired: false,
    sortOrder: 0,
  });

  const values = await resolveCustomFieldValues(db, A.schoolId, 'guardian', {
    workplace: 'Ministry of Education',
  });
  assert.deepEqual(values, { workplace: 'Ministry of Education' });
});

test('retiring a field takes effect immediately', async () => {
  const [def] = (await listDefinitions(db, A.schoolId, 'guardian')).filter(
    (d) => d.key === 'workplace',
  );
  assert.ok(def);

  await resolveCustomFieldValues(db, A.schoolId, 'guardian', { workplace: 'x' }); // warms cache
  await updateDefinition(db, A.schoolId, def!.id, { isActive: false });

  await assert.rejects(
    () => resolveCustomFieldValues(db, A.schoolId, 'guardian', { workplace: 'x' }),
    (error: Error & { status?: number }) => error.status === 400,
    'a retired field must stop accepting values at once, not when the cache expires',
  );
});
