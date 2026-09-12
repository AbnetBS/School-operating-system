/**
 * Demo finance data.
 *
 * Kept apart from `scripts/seed.ts` so the core seed stays readable, and so
 * this can be re-run against an existing demo database.
 *
 * The point of this data is to prove the module is configurable rather than
 * uniform: the two schools get different categories, different fee shapes and
 * different collection rates, and only some families have paid. Anything that
 * looked identical across both schools would hide exactly the bugs this seed
 * exists to expose.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type Database } from '../src/db/client.ts';
import { schools, academicYears, terms, gradeLevels } from '../src/db/schema/core.ts';
import { users } from '../src/db/schema/core.ts';
import { students, enrollments } from '../src/db/schema/people.ts';
import {
  feeCategories,
  feeStructures,
  studentCharges,
  payments,
  paymentAllocations,
  financeCounters,
} from '../src/db/schema/finance.ts';
import { getSetting } from '../src/lib/settings/service.ts';

/** Deterministic pseudo-random, so re-seeding gives the same demo. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

type CategorySpec = { key: string; name: string; nameAm: string; sortOrder: number };
type FeeSpec = {
  categoryKey: string;
  name: string;
  nameAm: string;
  amountCents: number;
  billingPeriod: 'once' | 'term' | 'month' | 'custom';
  appliesTo: 'all' | 'grade' | 'section' | 'individual';
  installmentCount?: number;
  isOptional?: boolean;
  gradeFilter?: (level: number) => boolean;
};

/**
 * School A: a three-term primary and secondary school with modest fees and a
 * tuition bill split into instalments.
 */
const SCHOOL_A: { categories: CategorySpec[]; fees: FeeSpec[] } = {
  categories: [
    { key: 'tuition', name: 'Tuition', nameAm: 'የትምህርት ክፍያ', sortOrder: 1 },
    { key: 'registration', name: 'Registration', nameAm: 'የምዝገባ ክፍያ', sortOrder: 2 },
    { key: 'transport', name: 'Transport', nameAm: 'የመጓጓዣ ክፍያ', sortOrder: 3 },
    { key: 'uniform', name: 'Uniform', nameAm: 'የደንብ ልብስ', sortOrder: 4 },
  ],
  fees: [
    {
      categoryKey: 'tuition',
      name: 'Tuition — Term 1',
      nameAm: 'የትምህርት ክፍያ — አንደኛ ወር',
      amountCents: 180000,
      billingPeriod: 'term',
      appliesTo: 'all',
      installmentCount: 2,
    },
    {
      categoryKey: 'registration',
      name: 'Annual registration',
      nameAm: 'ዓመታዊ ምዝገባ',
      amountCents: 50000,
      billingPeriod: 'once',
      appliesTo: 'all',
    },
    {
      categoryKey: 'transport',
      name: 'School bus',
      nameAm: 'የትምህርት ቤት አውቶቡስ',
      amountCents: 90000,
      billingPeriod: 'term',
      appliesTo: 'all',
      isOptional: true,
    },
    {
      // Deliberately grade-targeted, to prove fees need not be uniform.
      categoryKey: 'uniform',
      name: 'Upper grade laboratory',
      nameAm: 'የላቦራቶሪ ክፍያ',
      amountCents: 40000,
      billingPeriod: 'once',
      appliesTo: 'grade',
      gradeFilter: (level) => level >= 7,
    },
  ],
};

/**
 * School B: a two-semester secondary school. Higher fees, a different set of
 * categories, and no instalments — nothing about school A's shape is assumed.
 */
const SCHOOL_B: { categories: CategorySpec[]; fees: FeeSpec[] } = {
  categories: [
    { key: 'tuition', name: 'Tuition', nameAm: 'የትምህርት ክፍያ', sortOrder: 1 },
    { key: 'exam', name: 'Examination', nameAm: 'የፈተና ክፍያ', sortOrder: 2 },
    { key: 'library', name: 'Library', nameAm: 'የቤተ መጻሕፍት', sortOrder: 3 },
  ],
  fees: [
    {
      categoryKey: 'tuition',
      name: 'Semester tuition',
      nameAm: 'የሴሚስተር ክፍያ',
      amountCents: 320000,
      billingPeriod: 'term',
      appliesTo: 'all',
      installmentCount: 3,
    },
    {
      categoryKey: 'exam',
      name: 'National exam registration',
      nameAm: 'የብሔራዊ ፈተና ምዝገባ',
      amountCents: 75000,
      billingPeriod: 'once',
      appliesTo: 'all',
    },
    {
      categoryKey: 'library',
      name: 'Library and materials',
      nameAm: 'ቤተ መጻሕፍትና ቁሳቁስ',
      amountCents: 25000,
      billingPeriod: 'once',
      appliesTo: 'all',
    },
  ],
};

/** Split a total into n parts without losing a cent. */
function splitEvenly(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

async function seedFinanceFor(
  db: Database,
  code: string,
  spec: { categories: CategorySpec[]; fees: FeeSpec[] },
  seed: number,
) {
  const [school] = await db.select({ id: schools.id }).from(schools).where(eq(schools.code, code));
  if (!school) {
    console.log(`   ${code}: not found, skipped`);
    return;
  }
  const schoolId = school.id;

  const existing = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studentCharges)
    .where(eq(studentCharges.schoolId, schoolId));
  if ((existing[0]?.n ?? 0) > 0) {
    console.log(`   ${code}: already has charges, skipped`);
    return;
  }

  const rand = makeRandom(seed);
  const finance = await getSetting(db, schoolId, 'finance');

  const [year] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)));
  if (!year) {
    console.log(`   ${code}: no current academic year, skipped`);
    return;
  }

  const [term] = await db
    .select({ id: terms.id })
    .from(terms)
    .where(and(eq(terms.schoolId, schoolId), eq(terms.isCurrent, true)))
    .limit(1);

  const grades = await db
    .select({ id: gradeLevels.id, level: gradeLevels.level })
    .from(gradeLevels)
    .where(eq(gradeLevels.schoolId, schoolId));
  const gradeById = new Map(grades.map((g) => [g.id, g.level]));

  // --- categories ---------------------------------------------------------
  const categoryIds: Record<string, string> = {};
  for (const category of spec.categories) {
    const [row] = await db
      .insert(feeCategories)
      .values({ schoolId, ...category })
      .onConflictDoNothing()
      .returning({ id: feeCategories.id });
    if (row) {
      categoryIds[category.key] = row.id;
    } else {
      const [found] = await db
        .select({ id: feeCategories.id })
        .from(feeCategories)
        .where(and(eq(feeCategories.schoolId, schoolId), eq(feeCategories.key, category.key)));
      if (found) categoryIds[category.key] = found.id;
    }
  }

  // --- fee structures -----------------------------------------------------
  const created: { spec: FeeSpec; id: string }[] = [];
  for (const fee of spec.fees) {
    const targetGrades =
      fee.appliesTo === 'grade' && fee.gradeFilter
        ? grades.filter((g) => fee.gradeFilter!(g.level)).map((g) => g.id)
        : [];

    const [row] = await db
      .insert(feeStructures)
      .values({
        schoolId,
        academicYearId: year.id,
        categoryId: categoryIds[fee.categoryKey] ?? null,
        name: fee.name,
        nameAm: fee.nameAm,
        amountCents: fee.amountCents,
        billingPeriod: fee.billingPeriod,
        appliesTo: fee.appliesTo,
        gradeLevelIds: targetGrades,
        sectionIds: [],
        isOptional: fee.isOptional ?? false,
        installmentCount: fee.installmentCount ?? 1,
        isActive: true,
      })
      .returning({ id: feeStructures.id });
    if (row) created.push({ spec: fee, id: row.id });
  }

  // --- charges ------------------------------------------------------------
  const enrolled = await db
    .select({ studentId: enrollments.studentId, gradeLevelId: enrollments.gradeLevelId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.schoolId, schoolId),
        eq(enrollments.academicYearId, year.id),
        eq(enrollments.status, 'enrolled'),
      ),
    );

  const rows: (typeof studentCharges.$inferInsert)[] = [];
  for (const { spec: fee, id: feeId } of created) {
    for (const enrolment of enrolled) {
      if (fee.appliesTo === 'grade' && fee.gradeFilter) {
        const level = gradeById.get(enrolment.gradeLevelId ?? '');
        if (level === undefined || !fee.gradeFilter(level)) continue;
      }
      // An optional fee is taken up by only some families.
      if (fee.isOptional && rand() > 0.35) continue;

      const parts = splitEvenly(fee.amountCents, fee.installmentCount ?? 1);
      parts.forEach((part, index) => {
        const due = new Date('2025-10-15');
        due.setMonth(due.getMonth() + index);
        rows.push({
          schoolId,
          studentId: enrolment.studentId,
          feeStructureId: feeId,
          categoryId: categoryIds[fee.categoryKey] ?? null,
          academicYearId: year.id,
          termId: fee.billingPeriod === 'term' ? (term?.id ?? null) : null,
          gradeLevelId: enrolment.gradeLevelId ?? null,
          description:
            parts.length > 1 ? `${fee.name} (${index + 1}/${parts.length})` : fee.name,
          descriptionAm: fee.nameAm,
          amountCents: part,
          discountCents: 0,
          discountType: 'none',
          installmentNumber: index + 1,
          installmentTotal: parts.length,
          dueDate: due.toISOString().slice(0, 10),
          status: 'active',
        });
      });
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(studentCharges).values(rows.slice(i, i + 500));
  }

  // --- payments -----------------------------------------------------------
  const [clerk] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.schoolId, schoolId))
    .limit(1);

  const owing = await db
    .select({
      id: studentCharges.id,
      studentId: studentCharges.studentId,
      netAmountCents: studentCharges.netAmountCents,
      dueDate: studentCharges.dueDate,
    })
    .from(studentCharges)
    .where(and(eq(studentCharges.schoolId, schoolId), eq(studentCharges.status, 'active')))
    .orderBy(asc(studentCharges.dueDate));

  const byStudent = new Map<string, typeof owing>();
  for (const charge of owing) {
    const list = byStudent.get(charge.studentId) ?? [];
    list.push(charge);
    byStudent.set(charge.studentId, list);
  }

  await db
    .insert(financeCounters)
    .values({ schoolId, receiptSeq: 0 })
    .onConflictDoNothing();

  let seq = 0;
  const methods = finance.paymentMethods.length > 0 ? finance.paymentMethods : ['cash'];
  const year4 = new Date().getFullYear();

  for (const [studentId, charges] of byStudent) {
    const roll = rand();
    // A realistic mix: some families are square, some part-paid, some have not
    // paid at all. A demo where everyone has paid proves nothing.
    if (roll < 0.3) continue;
    const settleAll = roll > 0.75;
    const toSettle = settleAll ? charges : charges.slice(0, Math.max(1, Math.floor(charges.length / 2)));
    if (toSettle.length === 0) continue;

    const full = toSettle.reduce((sum, c) => sum + (c.netAmountCents ?? 0), 0);
    const amount = settleAll ? full : Math.max(1, Math.floor(full * 0.6));
    if (amount <= 0) continue;

    seq += 1;
    const receiptNumber = `${finance.receiptPrefix}-${year4}-${String(seq).padStart(6, '0')}`;
    const method = methods[Math.floor(rand() * methods.length)] ?? 'cash';
    const paidOn = new Date('2025-10-05');
    paidOn.setDate(paidOn.getDate() + Math.floor(rand() * 40));

    const [payment] = await db
      .insert(payments)
      .values({
        schoolId,
        studentId,
        receiptNumber,
        amountCents: amount,
        method,
        paidOn: paidOn.toISOString().slice(0, 10),
        status: 'completed',
        recordedBy: clerk?.id ?? null,
      })
      .returning({ id: payments.id });
    if (!payment) continue;

    // Allocate oldest first, exactly as the service does.
    let left = amount;
    const allocations: (typeof paymentAllocations.$inferInsert)[] = [];
    for (const charge of toSettle) {
      if (left <= 0) break;
      const take = Math.min(left, charge.netAmountCents ?? 0);
      if (take <= 0) continue;
      allocations.push({ schoolId, paymentId: payment.id, chargeId: charge.id, amountCents: take });
      left -= take;
    }
    if (allocations.length > 0) await db.insert(paymentAllocations).values(allocations);
    if (left > 0) {
      await db.update(payments).set({ unallocatedCents: left }).where(eq(payments.id, payment.id));
    }
  }

  await db.update(financeCounters).set({ receiptSeq: seq }).where(eq(financeCounters.schoolId, schoolId));

  console.log(
    `   ${code}: ${spec.categories.length} categories, ${created.length} fees, ${rows.length} charges, ${seq} payments`,
  );
}

async function main() {
  const db = await getDb();
  console.log('Seeding finance demo data …');
  await seedFinanceFor(db, 'bfa', SCHOOL_A, 20260909);
  await seedFinanceFor(db, 'aps', SCHOOL_B, 20260910);
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Finance seed failed:', error);
    process.exit(1);
  });
