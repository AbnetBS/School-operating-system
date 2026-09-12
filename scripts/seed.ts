/**
 * Seed script.
 *
 * Creates TWO demo schools with deliberately different structures, to prove
 * that the configurability is real:
 *
 *   1. Bright Future Academy — Grades 1–8, THREE TERMS, ranking on,
 *      percentage + letter grades, Ethiopian standard bands.
 *   2. Addis Preparatory School — Grades 9–12, TWO SEMESTERS, ranking off,
 *      GPA on, subject streams, extended bands.
 *
 * Neither school required a code change. Everything that differs is data.
 *
 * The seed also creates real users with real password hashes, real roles with
 * real permission sets, and real enrolments — so the isolation and permission
 * tests exercise genuine records rather than fixtures.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
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
  rooms,
  periods,
} from '../src/db/schema/core.ts';
import { students, guardians, studentGuardians, enrollments, staff } from '../src/db/schema/people.ts';
import { ROLE_TEMPLATES } from '../src/lib/auth/permissions.ts';
import { hashPassword } from '../src/lib/auth/password.ts';
import { initialiseSchoolSettings, setSetting } from '../src/lib/settings/service.ts';
import { SCHOOL_PRESETS } from '../src/lib/settings/presets.ts';
import { ethiopianToIso } from '../src/lib/calendar/ethiopian.ts';
import type { Database } from '../src/db/client.ts';

const DEMO_PASSWORD = 'Demo@2018';

// Common Ethiopian names for realistic demo data.
const MALE_NAMES = ['Abebe', 'Dawit', 'Yonas', 'Bereket', 'Samuel', 'Henok', 'Tesfaye', 'Girma', 'Mulugeta', 'Kaleb', 'Nahom', 'Eyob', 'Biruk', 'Robel', 'Amanuel', 'Getachew', 'Solomon', 'Fikru', 'Tewodros', 'Mesfin'];
const FEMALE_NAMES = ['Hana', 'Tirunesh', 'Meseret', 'Selam', 'Bethlehem', 'Rahel', 'Hiwot', 'Marta', 'Genet', 'Kidist', 'Eden', 'Saron', 'Meaza', 'Lidya', 'Bezawit', 'Frehiwot', 'Yordanos', 'Almaz', 'Tigist', 'Senait'];
const FATHER_NAMES = ['Kebede', 'Tadesse', 'Bekele', 'Alemu', 'Haile', 'Wolde', 'Assefa', 'Desta', 'Tesfa', 'Gebre', 'Mekonnen', 'Abera', 'Negash', 'Worku', 'Lemma'];
const GRANDFATHER_NAMES = ['Gebremariam', 'Tsegaye', 'Berhanu', 'Demissie', 'Kassa', 'Regassa', 'Molla', 'Ayele', 'Zeleke', 'Terefe'];

/** Deterministic pseudo-random so repeated seeds produce the same data. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: T[]): T => list[Math.floor(rand() * list.length)]!;

async function createRolesForSchool(db: Database, schoolId: string) {
  const created: Record<string, string> = {};
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const [role] = await db
      .insert(roles)
      .values({
        schoolId,
        key,
        name: template.name,
        nameAm: template.nameAm,
        description: template.description,
        isSystem: true,
      })
      .returning({ id: roles.id });
    created[key] = role!.id;
    if (template.permissions.length > 0) {
      await db
        .insert(rolePermissions)
        .values(template.permissions.map((permission) => ({ roleId: role!.id, permission })));
    }
  }
  return created;
}

type NewUser = {
  username: string;
  givenName: string;
  fatherName: string;
  roleKey: string;
  email?: string;
  phone?: string;
};

async function createUser(
  db: Database,
  schoolId: string,
  roleIds: Record<string, string>,
  input: NewUser,
  passwordHash: string,
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      schoolId,
      username: input.username,
      email: input.email ?? null,
      phone: input.phone ?? null,
      passwordHash,
      givenName: input.givenName,
      fatherName: input.fatherName,
    })
    .returning({ id: users.id });

  const roleId = roleIds[input.roleKey];
  if (roleId) {
    await db.insert(userRoles).values({ userId: user!.id, roleId });
  }
  return user!.id;
}

// ---------------------------------------------------------------------------

async function seedSchoolA(db: Database, passwordHash: string) {
  console.log('\n── Bright Future Academy (3 terms, Grades 1–8, ranking on) ──');

  const [school] = await db
    .insert(schools)
    .values({
      code: 'bfa',
      name: 'Bright Future Academy',
      nameAm: 'ብራይት ፊውቸር አካዳሚ',
      address: 'Bole Sub-city, Woreda 03, Addis Ababa',
      phone: '+251 11 667 8900',
      email: 'info@brightfuture.et',
      plan: 'professional',
    })
    .returning({ id: schools.id });
  const schoolId = school!.id;

  const preset = SCHOOL_PRESETS.threeTermPrimary!;
  await initialiseSchoolSettings(db, schoolId, {
    academic: preset.academic,
    grading: preset.grading,
    locale: { defaultLocale: 'en', calendarDisplay: 'both' },
    // School A runs the full operations suite.
    modules: {
      attendance: true, gradebook: true, reportCards: true, studentPortal: true,
      parentPortal: true, fees: true, payments: true,
      hr: true, library: true, inventory: true, maintenance: true, transport: true,
      documents: true,
    },
    attendance: { mode: 'daily', riskThresholdPercent: 85, consecutiveAbsenceAlert: 3 },
    reportCard: { showRank: true, showAttendance: true, printLocale: 'en' },
  });

  const roleIds = await createRolesForSchool(db, schoolId);

  // Academic year 2018 E.C. — Meskerem 2018 to Sene 2018.
  const yearStart = ethiopianToIso({ year: 2018, month: 1, day: 1 });
  const yearEnd = ethiopianToIso({ year: 2018, month: 10, day: 30 });
  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId,
      name: '2018 E.C.',
      nameAm: '2018 ዓ.ም.',
      ethiopianYear: 2018,
      startDate: yearStart,
      endDate: yearEnd,
      isCurrent: true,
    })
    .returning({ id: academicYears.id });
  const yearId = year!.id;

  // Three terms.
  const termSpans: [number, number, number, number][] = [
    [1, 1, 4, 10], // Meskerem 1 – Tahsas 10
    [4, 11, 7, 20], // Tahsas 11 – Megabit 20
    [7, 21, 10, 30], // Megabit 21 – Sene 30
  ];
  const termIds: string[] = [];
  for (let i = 0; i < termSpans.length; i++) {
    const [sm, sd, em, ed] = termSpans[i]!;
    const [term] = await db
      .insert(terms)
      .values({
        schoolId,
        academicYearId: yearId,
        kind: 'term',
        sequence: i + 1,
        name: `Term ${i + 1}`,
        nameAm: `${i + 1}ኛ ወቅት`,
        startDate: ethiopianToIso({ year: 2018, month: sm, day: sd }),
        endDate: ethiopianToIso({ year: 2018, month: em, day: ed }),
        weightPercent: i === 2 ? 40 : 30,
        isCurrent: i === 0,
      })
      .returning({ id: terms.id });
    termIds.push(term!.id);
  }

  // Grades 1–8.
  const gradeIds: string[] = [];
  for (let level = 1; level <= 8; level++) {
    const [grade] = await db
      .insert(gradeLevels)
      .values({ schoolId, name: `Grade ${level}`, nameAm: `${level}ኛ ክፍል`, level })
      .returning({ id: gradeLevels.id });
    gradeIds.push(grade!.id);
  }

  // Rooms and periods.
  for (let i = 1; i <= 20; i++) {
    await db.insert(rooms).values({ schoolId, name: `Room ${100 + i}`, capacity: 45 });
  }
  const periodTimes = [
    ['08:00', '08:45'], ['08:45', '09:30'], ['09:30', '09:50'], ['09:50', '10:35'],
    ['10:35', '11:20'], ['11:20', '12:00'], ['12:00', '13:00'], ['13:00', '13:45'], ['13:45', '14:30'],
  ];
  for (let i = 0; i < periodTimes.length; i++) {
    const isBreak = i === 2 || i === 6;
    await db.insert(periods).values({
      schoolId,
      sequence: i + 1,
      name: isBreak ? (i === 2 ? 'Break' : 'Lunch') : `Period ${i < 2 ? i + 1 : i < 6 ? i : i - 1}`,
      startTime: periodTimes[i]![0]!,
      endTime: periodTimes[i]![1]!,
      isBreak,
    });
  }

  // Subjects.
  const subjectDefs = [
    ['MATH', 'Mathematics', 'ሒሳብ'], ['ENG', 'English', 'እንግሊዝኛ'], ['AMH', 'Amharic', 'አማርኛ'],
    ['SCI', 'General Science', 'አጠቃላይ ሳይንስ'], ['SOC', 'Social Studies', 'ማኅበራዊ ጥናት'],
    ['CIV', 'Civics', 'ሥነ ዜጋ'], ['PE', 'Physical Education', 'ስፖርት'], ['ICT', 'ICT', 'ኮምፒውተር'],
  ];
  const subjectIds: Record<string, string> = {};
  for (const [code, name, nameAm] of subjectDefs) {
    const [subject] = await db
      .insert(subjects)
      .values({
        schoolId,
        code: code!,
        name: name!,
        nameAm: nameAm!,
        countsTowardAverage: code !== 'PE',
      })
      .returning({ id: subjects.id });
    subjectIds[code!] = subject!.id;
  }

  // Staff.
  const adminId = await createUser(db, schoolId, roleIds, { username: 'admin', givenName: 'Almaz', fatherName: 'Tessema', roleKey: 'owner', email: 'admin@brightfuture.et' }, passwordHash);
  const principalId = await createUser(db, schoolId, roleIds, { username: 'principal', givenName: 'Getachew', fatherName: 'Bekele', roleKey: 'principal', email: 'principal@brightfuture.et' }, passwordHash);
  await createUser(db, schoolId, roleIds, { username: 'registrar', givenName: 'Meseret', fatherName: 'Alemu', roleKey: 'registrar' }, passwordHash);
  await createUser(db, schoolId, roleIds, { username: 'finance', givenName: 'Yohannes', fatherName: 'Desta', roleKey: 'finance_officer' }, passwordHash);

  for (const [userId, code, type] of [[adminId, 'STF-001', 'admin'], [principalId, 'STF-002', 'admin']] as const) {
    await db.insert(staff).values({ schoolId, userId, staffCode: code, staffType: type, jobTitle: 'Administration', status: 'active' });
  }

  // Teachers.
  const rand = makeRandom(20180101);
  const teacherIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const given = i % 2 === 0 ? pick(rand, MALE_NAMES) : pick(rand, FEMALE_NAMES);
    const father = pick(rand, FATHER_NAMES);
    const uid = await createUser(db, schoolId, roleIds, {
      username: `teacher${i + 1}`,
      givenName: given,
      fatherName: father,
      roleKey: i < 8 ? 'class_teacher' : 'teacher',
    }, passwordHash);
    teacherIds.push(uid);
    await db.insert(staff).values({
      schoolId, userId: uid, staffCode: `TCH-${String(i + 1).padStart(3, '0')}`,
      staffType: 'teacher', jobTitle: 'Teacher', qualification: i % 3 === 0 ? 'MA' : 'BA', status: 'active',
    });
  }

  // Sections: two per grade for grades 1–6, one for 7–8.
  const sectionIds: { id: string; gradeId: string; level: number }[] = [];
  for (let g = 0; g < gradeIds.length; g++) {
    const names = g < 6 ? ['A', 'B'] : ['A'];
    for (const name of names) {
      const [section] = await db
        .insert(sections)
        .values({
          schoolId,
          academicYearId: yearId,
          gradeLevelId: gradeIds[g]!,
          name,
          capacity: 40,
          classTeacherId: teacherIds[sectionIds.length % teacherIds.length]!,
        })
        .returning({ id: sections.id });
      sectionIds.push({ id: section!.id, gradeId: gradeIds[g]!, level: g + 1 });
    }
  }

  // Assign subjects to sections with teachers.
  for (const section of sectionIds) {
    const codes = section.level >= 5 ? subjectDefs.map((s) => s[0]!) : ['MATH', 'ENG', 'AMH', 'SCI', 'SOC', 'PE'];
    for (let i = 0; i < codes.length; i++) {
      await db.insert(sectionSubjects).values({
        schoolId,
        academicYearId: yearId,
        sectionId: section.id,
        subjectId: subjectIds[codes[i]!]!,
        teacherId: teacherIds[(sectionIds.indexOf(section) + i) % teacherIds.length]!,
      });
    }
  }

  // Students with guardians and enrolments.
  let seq = 1;
  let studentCount = 0;
  for (const section of sectionIds) {
    const count = 22 + Math.floor(rand() * 10);
    for (let i = 0; i < count; i++) {
      const isMale = rand() > 0.48;
      const given = isMale ? pick(rand, MALE_NAMES) : pick(rand, FEMALE_NAMES);
      const father = pick(rand, FATHER_NAMES);
      const grandfather = pick(rand, GRANDFATHER_NAMES);
      const birthYear = 2026 - (section.level + 6);

      const [student] = await db
        .insert(students)
        .values({
          schoolId,
          studentCode: `BFA/2018/${String(seq).padStart(4, '0')}`,
          givenName: given,
          fatherName: father,
          grandfatherName: grandfather,
          gender: isMale ? 'male' : 'female',
          dateOfBirth: `${birthYear}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
          admissionDate: yearStart,
          admissionYearId: yearId,
          status: 'active',
          subCity: pick(rand, ['Bole', 'Yeka', 'Kirkos', 'Arada', 'Lideta']),
        })
        .returning({ id: students.id });
      seq++;
      studentCount++;

      await db.insert(enrollments).values({
        schoolId,
        studentId: student!.id,
        academicYearId: yearId,
        gradeLevelId: section.gradeId,
        sectionId: section.id,
        rollNumber: i + 1,
        enrolledOn: yearStart,
        status: 'enrolled',
        registrationStatus: 'approved',
      });

      // Every third student gets a guardian with a portal login.
      const [guardian] = await db
        .insert(guardians)
        .values({
          schoolId,
          givenName: pick(rand, MALE_NAMES),
          fatherName: grandfather,
          phone: `+2519${String(10000000 + Math.floor(rand() * 89999999))}`,
          preferredChannel: 'sms',
        })
        .returning({ id: guardians.id });

      await db.insert(studentGuardians).values({
        schoolId,
        studentId: student!.id,
        guardianId: guardian!.id,
        relationship: 'father',
        isPrimary: true,
      });
    }
  }

  // A parent login tied to the first two students, to demonstrate multi-child
  // switching and to give the isolation tests a real parent to work with.
  const firstStudents = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.schoolId, schoolId))
    .limit(2);

  const parentUserId = await createUser(db, schoolId, roleIds, {
    username: 'parent', givenName: 'Tesfaye', fatherName: 'Worku', roleKey: 'parent', phone: '+251911223344',
  }, passwordHash);
  const [parentGuardian] = await db
    .insert(guardians)
    .values({ schoolId, givenName: 'Tesfaye', fatherName: 'Worku', phone: '+251911223344', userId: parentUserId })
    .returning({ id: guardians.id });
  for (const s of firstStudents) {
    await db.insert(studentGuardians).values({
      schoolId, studentId: s.id, guardianId: parentGuardian!.id, relationship: 'father', isPrimary: false,
    });
  }

  // A student login for the first student.
  const studentUserId = await createUser(db, schoolId, roleIds, {
    username: 'student', givenName: 'Abebe', fatherName: 'Kebede', roleKey: 'student',
  }, passwordHash);
  if (firstStudents[0]) {
    await db.update(students).set({ userId: studentUserId }).where(eq(students.id, firstStudents[0].id));
  }

  console.log(`   ${studentCount} students, ${sectionIds.length} sections, 3 terms, 12 teachers`);
  return { schoolId, studentCount };
}

// ---------------------------------------------------------------------------

async function seedSchoolB(db: Database, passwordHash: string) {
  console.log('\n── Addis Preparatory School (2 semesters, Grades 9–12, GPA, no ranking) ──');

  const [school] = await db
    .insert(schools)
    .values({
      code: 'aps',
      name: 'Addis Preparatory School',
      nameAm: 'አዲስ መሰናዶ ትምህርት ቤት',
      address: 'Kirkos Sub-city, Woreda 08, Addis Ababa',
      phone: '+251 11 552 3344',
      email: 'info@addisprep.et',
      plan: 'enterprise',
    })
    .returning({ id: schools.id });
  const schoolId = school!.id;

  const preset = SCHOOL_PRESETS.twoSemesterSecondary!;
  await initialiseSchoolSettings(db, schoolId, {
    academic: preset.academic,
    grading: preset.grading,
    // This school runs its interface in Amharic by default — proving the
    // locale default is per-school, not global.
    locale: { defaultLocale: 'am', calendarDisplay: 'ethiopian' },
    // School B deliberately runs a DIFFERENT subset: it has a library and HR
    // but no transport, inventory or maintenance. Proving a module is a
    // per-school switch, not a global build flag, matters more than having
    // every demo screen populated.
    modules: {
      attendance: true, gradebook: true, reportCards: true, studentPortal: true,
      parentPortal: true, fees: true, payments: true, timetable: true, exams: true, homework: true,
      hr: true, library: true, documents: true,
      transport: false, inventory: false, maintenance: false,
    },
    // A stricter attendance policy than School A, again purely as data.
    attendance: { mode: 'perSubject', riskThresholdPercent: 90, consecutiveAbsenceAlert: 2, requireAbsenceReason: true },
    reportCard: { showRank: false, showAttendance: true, printLocale: 'both', approvalChain: ['grade.review', 'reportCard.approve'] },
  });

  const roleIds = await createRolesForSchool(db, schoolId);

  const yearStart = ethiopianToIso({ year: 2018, month: 1, day: 1 });
  const yearEnd = ethiopianToIso({ year: 2018, month: 10, day: 30 });
  const [year] = await db
    .insert(academicYears)
    .values({
      schoolId, name: '2018 E.C.', nameAm: '2018 ዓ.ም.', ethiopianYear: 2018,
      startDate: yearStart, endDate: yearEnd, isCurrent: true,
    })
    .returning({ id: academicYears.id });
  const yearId = year!.id;

  // TWO SEMESTERS — a different structure from School A, no code change.
  for (let i = 0; i < 2; i++) {
    await db.insert(terms).values({
      schoolId,
      academicYearId: yearId,
      kind: 'semester',
      sequence: i + 1,
      name: `Semester ${i + 1}`,
      nameAm: `${i + 1}ኛ ሴሚስተር`,
      startDate: ethiopianToIso({ year: 2018, month: i === 0 ? 1 : 6, day: 1 }),
      endDate: ethiopianToIso({ year: 2018, month: i === 0 ? 5 : 10, day: 30 }),
      weightPercent: 50,
      isCurrent: i === 0,
    });
  }

  // Grades 9–12, with streams at 11 and 12.
  const gradeDefs: [string, number, string | null][] = [
    ['Grade 9', 9, null],
    ['Grade 10', 10, null],
    ['Grade 11 Natural', 11, 'natural'],
    ['Grade 11 Social', 11, 'social'],
    ['Grade 12 Natural', 12, 'natural'],
    ['Grade 12 Social', 12, 'social'],
  ];
  const gradeIds: { id: string; level: number; stream: string | null }[] = [];
  for (const [name, level, stream] of gradeDefs) {
    const [grade] = await db
      .insert(gradeLevels)
      .values({ schoolId, name, nameAm: `${level}ኛ ክፍል`, level, stream })
      .returning({ id: gradeLevels.id });
    gradeIds.push({ id: grade!.id, level, stream });
  }

  for (let i = 1; i <= 12; i++) {
    await db.insert(rooms).values({ schoolId, name: `Lab ${i}`, capacity: 50 });
  }
  for (let i = 0; i < 7; i++) {
    await db.insert(periods).values({
      schoolId, sequence: i + 1, name: `Period ${i + 1}`,
      startTime: `${String(8 + i).padStart(2, '0')}:00`,
      endTime: `${String(8 + i).padStart(2, '0')}:50`,
    });
  }

  const subjectDefs = [
    ['MATH', 'Mathematics', 'ሒሳብ'], ['ENG', 'English', 'እንግሊዝኛ'], ['AMH', 'Amharic', 'አማርኛ'],
    ['PHY', 'Physics', 'ፊዚክስ'], ['CHEM', 'Chemistry', 'ኬሚስትሪ'], ['BIO', 'Biology', 'ባዮሎጂ'],
    ['GEO', 'Geography', 'ጂኦግራፊ'], ['HIST', 'History', 'ታሪክ'], ['ECON', 'Economics', 'ኢኮኖሚክስ'],
    ['ICT', 'ICT', 'ኮምፒውተር'],
  ];
  const subjectIds: Record<string, string> = {};
  for (const [code, name, nameAm] of subjectDefs) {
    const [subject] = await db
      .insert(subjects)
      .values({ schoolId, code: code!, name: name!, nameAm: nameAm! })
      .returning({ id: subjects.id });
    subjectIds[code!] = subject!.id;
  }

  await createUser(db, schoolId, roleIds, { username: 'admin', givenName: 'Solomon', fatherName: 'Girma', roleKey: 'owner', email: 'admin@addisprep.et' }, passwordHash);
  await createUser(db, schoolId, roleIds, { username: 'principal', givenName: 'Hirut', fatherName: 'Mekonnen', roleKey: 'principal' }, passwordHash);
  await createUser(db, schoolId, roleIds, { username: 'coordinator', givenName: 'Dawit', fatherName: 'Negash', roleKey: 'academic_coordinator' }, passwordHash);

  const rand = makeRandom(99887766);
  const teacherIds: string[] = [];
  for (let i = 0; i < 14; i++) {
    const given = i % 2 === 0 ? pick(rand, FEMALE_NAMES) : pick(rand, MALE_NAMES);
    const uid = await createUser(db, schoolId, roleIds, {
      username: `teacher${i + 1}`, givenName: given, fatherName: pick(rand, FATHER_NAMES),
      roleKey: i < 6 ? 'class_teacher' : 'teacher',
    }, passwordHash);
    teacherIds.push(uid);
    await db.insert(staff).values({
      schoolId, userId: uid, staffCode: `APS-T${String(i + 1).padStart(3, '0')}`,
      staffType: 'teacher', jobTitle: 'Subject Teacher', qualification: 'MSc', status: 'active',
    });
  }

  const sectionList: { id: string; gradeId: string; level: number; stream: string | null }[] = [];
  for (const grade of gradeIds) {
    for (const name of ['A', 'B']) {
      const [section] = await db
        .insert(sections)
        .values({
          schoolId, academicYearId: yearId, gradeLevelId: grade.id, name, capacity: 50,
          classTeacherId: teacherIds[sectionList.length % teacherIds.length]!,
        })
        .returning({ id: sections.id });
      sectionList.push({ id: section!.id, gradeId: grade.id, level: grade.level, stream: grade.stream });
    }
  }

  for (const section of sectionList) {
    const core = ['MATH', 'ENG', 'AMH', 'ICT'];
    const stream =
      section.stream === 'natural' ? ['PHY', 'CHEM', 'BIO']
      : section.stream === 'social' ? ['GEO', 'HIST', 'ECON']
      : ['PHY', 'CHEM', 'BIO', 'GEO', 'HIST'];
    const codes = [...core, ...stream];
    for (let i = 0; i < codes.length; i++) {
      await db.insert(sectionSubjects).values({
        schoolId, academicYearId: yearId, sectionId: section.id,
        subjectId: subjectIds[codes[i]!]!,
        teacherId: teacherIds[(sectionList.indexOf(section) + i) % teacherIds.length]!,
      });
    }
  }

  let seq = 1;
  let studentCount = 0;
  for (const section of sectionList) {
    const count = 30 + Math.floor(rand() * 12);
    for (let i = 0; i < count; i++) {
      const isMale = rand() > 0.5;
      const given = isMale ? pick(rand, MALE_NAMES) : pick(rand, FEMALE_NAMES);
      const father = pick(rand, FATHER_NAMES);
      const [student] = await db
        .insert(students)
        .values({
          schoolId,
          studentCode: `APS-2018-${String(seq).padStart(4, '0')}`,
          givenName: given,
          fatherName: father,
          grandfatherName: pick(rand, GRANDFATHER_NAMES),
          gender: isMale ? 'male' : 'female',
          dateOfBirth: `${2026 - (section.level + 6)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
          admissionDate: yearStart,
          admissionYearId: yearId,
          status: 'active',
        })
        .returning({ id: students.id });
      seq++;
      studentCount++;

      await db.insert(enrollments).values({
        schoolId, studentId: student!.id, academicYearId: yearId,
        gradeLevelId: section.gradeId, sectionId: section.id, rollNumber: i + 1,
        enrolledOn: yearStart, status: 'enrolled', registrationStatus: 'approved',
      });
    }
  }

  console.log(`   ${studentCount} students, ${sectionList.length} sections, 2 semesters, 14 teachers`);
  return { schoolId, studentCount };
}

// ---------------------------------------------------------------------------

async function main() {
  // The README's warning used to be the only thing standing between a
  // production database and a set of accounts whose password is published in
  // this repository, with no screen anywhere to change it afterwards. A warning
  // is not a guard, so here it is. `npm run db:bootstrap` is the supported way
  // to create a real school and its first administrator.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED_IN_PRODUCTION !== 'true') {
    console.error(
      `\nRefusing to seed demo data: NODE_ENV is production.\n\n` +
        `The seed creates accounts whose password (${DEMO_PASSWORD}) is published in\n` +
        'this repository, and there is no password-change screen to replace it.\n\n' +
        'To create a real school and its first administrator instead, run:\n' +
        '  npm run db:bootstrap\n\n' +
        'If you genuinely want the demo data in this production database — a\n' +
        'training or demonstration server, for instance — re-run with:\n' +
        '  ALLOW_DEMO_SEED_IN_PRODUCTION=true npm run db:seed\n',
    );
    process.exit(1);
  }

  const db = await getDb();

  const existing = await db.select({ id: schools.id }).from(schools).limit(1);
  if (existing.length > 0) {
    console.log('Database already contains schools. Run "npm run db:reset" to start clean.');
    process.exit(0);
  }

  console.log('Seeding demo data …');
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const a = await seedSchoolA(db, passwordHash);
  const b = await seedSchoolB(db, passwordHash);

  console.log('\n─────────────────────────────────────────────');
  console.log(`Total: ${a.studentCount + b.studentCount} students across 2 schools`);
  console.log('\nSign in at /login with password:', DEMO_PASSWORD);
  console.log('\n  Bright Future Academy (school code: bfa)');
  console.log('    admin / principal / registrar / finance / teacher1…teacher12 / parent / student');
  console.log('\n  Addis Preparatory School (school code: aps)');
  console.log('    admin / principal / coordinator / teacher1…teacher14');
  console.log('\nBoth schools use username "admin" — usernames are unique per school,');
  console.log('not globally, so the school is selected at sign-in.');
  console.log('─────────────────────────────────────────────');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
