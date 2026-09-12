/**
 * Demo operations data (Group 8).
 *
 * Separate from `scripts/seed.ts` and re-runnable, like `seed-finance.ts`.
 *
 * The data is chosen to expose bugs rather than to look tidy:
 *   - School A gets the full suite; School B gets only library and HR, because
 *     its module switches say so. If a page ignores a disabled module, the
 *     difference between the two schools makes it obvious.
 *   - Some loans are already overdue, some stock is already below its reorder
 *     level, and some maintenance is urgent and unassigned — so the work
 *     queues have something in them on first load.
 *   - Nothing is uniform: different loan lengths, different fine policies,
 *     different working weeks.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type Database } from '../src/db/client.ts';
import { schools, users, academicYears, schoolSettings } from '../src/db/schema/core.ts';
import { students, staff, enrollments } from '../src/db/schema/people.ts';
import {
  libraryItems,
  libraryCopies,
  libraryLoans,
  inventoryItems,
  stockMovements,
  assets,
  maintenanceIssues,
  vehicles,
  transportRoutes,
  routeStops,
  studentTransport,
  schoolEvents,
  leaveTypes,
  leaveRequests,
  staffAttendance,
} from '../src/db/schema/operations.ts';
import { invalidateSettingsCache } from '../src/lib/settings/service.ts';

function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Today in Addis Ababa, so the demo lines up with the server's idea of now. */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Addis_Ababa',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

// ---------------------------------------------------------------------------

const BOOKS_AM = [
  { title: 'ፍቅር እስከ መቃብር', author: 'ሀዲስ ዓለማየሁ', type: 'book', category: 'Amharic literature' },
  { title: 'ኦሮማይ', author: 'በዓሉ ግርማ', type: 'book', category: 'Amharic literature' },
  { title: 'ደርቶጋዳ', author: 'ይስማዕከ ወርቁ', type: 'book', category: 'Amharic literature' },
  { title: 'የተቀበረው ምስጢር', author: 'ዘነበ ወላ', type: 'book', category: 'Amharic literature' },
];

const BOOKS_EN = [
  { title: 'Mathematics for Grade 5', author: 'MoE Ethiopia', type: 'book', category: 'Mathematics' },
  { title: 'Integrated Science Grade 6', author: 'MoE Ethiopia', type: 'book', category: 'Science' },
  { title: 'English for Ethiopia Grade 4', author: 'MoE Ethiopia', type: 'book', category: 'English' },
  { title: 'Atlas of Ethiopia', author: 'EMA', type: 'reference', category: 'Geography' },
  { title: 'Things Fall Apart', author: 'Chinua Achebe', type: 'book', category: 'African literature' },
  { title: 'A Long Walk to Water', author: 'Linda Sue Park', type: 'book', category: 'Fiction' },
];

const STOCK = [
  { name: 'Exercise books (48 page)', unit: 'piece', reorder: 200, opening: 850, cost: 2500 },
  { name: 'Chalk', unit: 'box', reorder: 20, opening: 12, cost: 4000 },
  { name: 'Whiteboard markers', unit: 'piece', reorder: 30, opening: 24, cost: 3500 },
  { name: 'A4 paper', unit: 'ream', reorder: 15, opening: 40, cost: 55000 },
  { name: 'Printer toner', unit: 'cartridge', reorder: 2, opening: 1, cost: 950000 },
  { name: 'Cleaning detergent', unit: 'litre', reorder: 10, opening: 35, cost: 12000 },
  { name: 'First aid kits', unit: 'kit', reorder: 3, opening: 6, cost: 85000 },
];

const ASSETS = [
  { name: 'Projector — Epson EB-S41', category: 'ICT', status: 'in_use', condition: 'good' },
  { name: 'Desktop computer — lab 1', category: 'ICT', status: 'in_use', condition: 'fair' },
  { name: 'Desktop computer — lab 2', category: 'ICT', status: 'under_repair', condition: 'poor' },
  { name: 'Photocopier — Canon iR2004', category: 'Office', status: 'in_use', condition: 'good' },
  { name: 'Science lab microscope set', category: 'Laboratory', status: 'in_use', condition: 'good' },
  { name: 'Football goal posts', category: 'Sports', status: 'in_use', condition: 'fair' },
  { name: 'Water pump', category: 'Facilities', status: 'under_repair', condition: 'poor' },
];

const ISSUES = [
  { title: 'Classroom door lock broken', location: 'Grade 3 A', priority: 'normal', ageDays: 12, status: 'open' },
  { title: 'No water in the girls\u2019 toilet', location: 'Main block', priority: 'urgent', ageDays: 2, status: 'in_progress' },
  { title: 'Ceiling fan not working', location: 'Grade 5 B', priority: 'low', ageDays: 30, status: 'open' },
  { title: 'Broken window pane', location: 'Library', priority: 'high', ageDays: 5, status: 'open' },
  { title: 'Leaking roof above the store', location: 'Store room', priority: 'high', ageDays: 20, status: 'resolved' },
];

const LEAVE_TYPES = [
  { key: 'annual', name: 'Annual leave', nameAm: 'ዓመታዊ ፈቃድ', days: 20, paid: true },
  { key: 'sick', name: 'Sick leave', nameAm: 'የሕመም ፈቃድ', days: 15, paid: true },
  { key: 'maternity', name: 'Maternity leave', nameAm: 'የወሊድ ፈቃድ', days: 120, paid: true },
  { key: 'unpaid', name: 'Unpaid leave', nameAm: 'ያለክፍያ ፈቃድ', days: null, paid: false },
  { key: 'bereavement', name: 'Bereavement leave', nameAm: 'የሐዘን ፈቃድ', days: 5, paid: true },
];

// ---------------------------------------------------------------------------

async function seedLibrary(db: Database, schoolId: string, prefix: string, seed: number) {
  const rand = makeRandom(seed);
  const titles = [...BOOKS_AM, ...BOOKS_EN];

  const itemIds: string[] = [];
  for (const t of titles) {
    const [existing] = await db
      .select({ id: libraryItems.id })
      .from(libraryItems)
      .where(and(eq(libraryItems.schoolId, schoolId), eq(libraryItems.title, t.title)))
      .limit(1);
    if (existing) {
      itemIds.push(existing.id);
      continue;
    }
    const [row] = await db
      .insert(libraryItems)
      .values({
        schoolId,
        title: t.title,
        author: t.author,
        itemType: t.type,
        category: t.category,
        language: /[\u1200-\u137F]/.test(t.title) ? 'am' : 'en',
        active: true,
      })
      .returning({ id: libraryItems.id });
    itemIds.push(row!.id);
  }

  // Copies: a textbook gets many, a novel a few.
  let seq = 1;
  const [maxRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryCopies)
    .where(eq(libraryCopies.schoolId, schoolId));
  if (Number(maxRow?.n ?? 0) > 0) return itemIds;

  for (const [i, itemId] of itemIds.entries()) {
    const count = i < BOOKS_AM.length ? 3 : Math.floor(rand() * 6) + 4;
    const rows = [];
    for (let c = 0; c < count; c += 1) {
      rows.push({
        schoolId,
        itemId,
        accessionNumber: `${prefix}-${String(seq).padStart(5, '0')}`,
        condition: rand() > 0.85 ? 'fair' : 'good',
        status: 'available',
      });
      seq += 1;
    }
    await db.insert(libraryCopies).values(rows);
  }

  return itemIds;
}

async function seedLoans(db: Database, schoolId: string, seed: number) {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryLoans)
    .where(eq(libraryLoans.schoolId, schoolId));
  if (Number(existing?.n ?? 0) > 0) return;

  const rand = makeRandom(seed);
  const pupils = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.status, 'active')))
    .limit(40);
  const copies = await db
    .select({ id: libraryCopies.id, itemId: libraryCopies.itemId })
    .from(libraryCopies)
    .where(and(eq(libraryCopies.schoolId, schoolId), eq(libraryCopies.status, 'available')))
    .orderBy(asc(libraryCopies.accessionNumber))
    .limit(30);
  const [librarian] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.schoolId, schoolId), eq(users.username, 'admin')))
    .limit(1);

  if (pupils.length === 0 || copies.length === 0) return;

  const rows: (typeof libraryLoans.$inferInsert)[] = [];
  const used = new Set<string>();

  // A spread of ages, so some are comfortably current and some are overdue.
  for (let i = 0; i < Math.min(18, copies.length); i += 1) {
    const copy = copies[i]!;
    if (used.has(copy.id)) continue;
    used.add(copy.id);

    const pupil = pupils[Math.floor(rand() * pupils.length)]!;
    const daysAgo = Math.floor(rand() * 30);
    const issuedOn = addDays(TODAY, -daysAgo);
    const dueOn = addDays(issuedOn, 14);
    // Two thirds still out, a third already returned.
    const returned = rand() > 0.66;

    rows.push({
      schoolId,
      copyId: copy.id,
      itemId: copy.itemId,
      studentId: pupil.id,
      issuedOn,
      dueOn,
      returnedAt: returned ? new Date(`${addDays(dueOn, -2)}T10:00:00Z`) : null,
      returnedOn: returned ? addDays(dueOn, -2) : null,
      issuedBy: librarian?.id ?? null,
    });
  }

  if (rows.length > 0) await db.insert(libraryLoans).values(rows);
}

async function seedInventory(db: Database, schoolId: string) {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryItems)
    .where(eq(inventoryItems.schoolId, schoolId));
  if (Number(existing?.n ?? 0) > 0) return;

  const [keeper] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.schoolId, schoolId), eq(users.username, 'admin')))
    .limit(1);

  for (const s of STOCK) {
    const [item] = await db
      .insert(inventoryItems)
      .values({
        schoolId,
        name: s.name,
        category: 'General',
        unit: s.unit,
        quantity: 0,
        reorderLevel: s.reorder,
        location: 'Main store',
        unitCostCents: s.cost,
        active: true,
      })
      .returning({ id: inventoryItems.id });

    // Opening stock arrives as a movement, exactly as the service requires:
    // the ledger is the truth and the column is derived from it.
    await db.insert(stockMovements).values({
      schoolId,
      itemId: item!.id,
      movementType: 'receipt',
      delta: s.opening,
      balanceAfter: s.opening,
      reference: 'Opening balance',
      movedOn: addDays(TODAY, -60),
      recordedBy: keeper?.id ?? null,
    });

    // A later issue on some items, so the movement history is not all one row.
    if (s.opening > 30) {
      const issued = Math.floor(s.opening * 0.15);
      await db.insert(stockMovements).values({
        schoolId,
        itemId: item!.id,
        movementType: 'issue',
        delta: -issued,
        balanceAfter: s.opening - issued,
        reference: 'Issued to classrooms',
        movedOn: addDays(TODAY, -14),
        recordedBy: keeper?.id ?? null,
      });
      await db
        .update(inventoryItems)
        .set({ quantity: s.opening - issued })
        .where(eq(inventoryItems.id, item!.id));
    } else {
      await db
        .update(inventoryItems)
        .set({ quantity: s.opening })
        .where(eq(inventoryItems.id, item!.id));
    }
  }
}

async function seedAssetsAndMaintenance(db: Database, schoolId: string, prefix: string) {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assets)
    .where(eq(assets.schoolId, schoolId));
  if (Number(existing?.n ?? 0) > 0) return;

  const [reporter] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.schoolId, schoolId), eq(users.username, 'admin')))
    .limit(1);
  const [caretaker] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.schoolId, schoolId))
    .limit(1);

  const assetIds: string[] = [];
  for (const [i, a] of ASSETS.entries()) {
    const [row] = await db
      .insert(assets)
      .values({
        schoolId,
        name: a.name,
        assetTag: `${prefix}-A${String(i + 1).padStart(3, '0')}`,
        category: a.category,
        location: a.category === 'ICT' ? 'ICT lab' : 'Main block',
        status: a.status,
        condition: a.condition,
        purchasedOn: addDays(TODAY, -(400 + i * 30)),
        purchaseCostCents: (i + 1) * 1_500_00,
      })
      .returning({ id: assets.id });
    assetIds.push(row!.id);
  }

  for (const [i, issue] of ISSUES.entries()) {
    const closing = issue.status === 'resolved';
    await db.insert(maintenanceIssues).values({
      schoolId,
      // Half the reports name an asset; half are about the building, which is
      // why asset_id is nullable.
      assetId: i % 2 === 0 ? (assetIds[i] ?? null) : null,
      title: issue.title,
      description: null,
      location: issue.location,
      priority: issue.priority,
      status: issue.status,
      reportedBy: reporter?.id ?? null,
      reportedOn: addDays(TODAY, -issue.ageDays),
      assignedStaffId: issue.status === 'open' ? null : (caretaker?.id ?? null),
      resolvedAt: closing ? new Date() : null,
      resolutionNote: closing ? 'Roof sheet replaced.' : null,
      costCents: closing ? 350_00 : null,
    });
  }
}

async function seedTransport(db: Database, schoolId: string, seed: number) {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vehicles)
    .where(eq(vehicles.schoolId, schoolId));
  if (Number(existing?.n ?? 0) > 0) return;

  const rand = makeRandom(seed);
  const drivers = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.schoolId, schoolId))
    .limit(3);

  const plates = ['3-A12345 AA', '3-B67890 AA', '3-C24680 AA'];
  const routeDefs = [
    { name: 'Bole — Megenagna', code: 'R1', stops: ['Bole Medhanialem', 'Alem Bank', 'Megenagna'] },
    { name: 'Piassa — Shiro Meda', code: 'R2', stops: ['Piassa', 'Sidist Kilo', 'Shiro Meda'] },
    { name: 'CMC — Ayat', code: 'R3', stops: ['CMC', 'Summit', 'Ayat'] },
  ];

  const [year] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  const pupils = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.status, 'active')))
    .limit(60);

  let pupilIndex = 0;

  for (const [i, def] of routeDefs.entries()) {
    const [vehicle] = await db
      .insert(vehicles)
      .values({
        schoolId,
        plateNumber: plates[i]!,
        label: `Bus ${i + 1}`,
        vehicleType: 'bus',
        capacity: 30,
        driverStaffId: drivers[i]?.id ?? null,
        status: 'active',
        insuranceUntil: addDays(TODAY, 120 + i * 30),
        inspectionUntil: addDays(TODAY, 60 + i * 20),
      })
      .returning({ id: vehicles.id });

    const [routeRow] = await db
      .insert(transportRoutes)
      .values({
        schoolId,
        name: def.name,
        code: def.code,
        vehicleId: vehicle!.id,
        direction: 'both',
        monthlyFeeCents: 1_200_00 + i * 100_00,
        active: true,
      })
      .returning({ id: transportRoutes.id });

    const stopIds: string[] = [];
    for (const [j, stopName] of def.stops.entries()) {
      const [stop] = await db
        .insert(routeStops)
        .values({
          schoolId,
          routeId: routeRow!.id,
          name: stopName,
          sortOrder: j + 1,
          pickupTime: `0${6 + Math.floor(j / 2)}:${j % 2 === 0 ? '30' : '50'}`,
          dropoffTime: `1${5 + Math.floor(j / 2)}:${j % 2 === 0 ? '45' : '15'}`,
        })
        .returning({ id: routeStops.id });
      stopIds.push(stop!.id);
    }

    if (!year) continue;
    // Fill each bus to roughly two thirds, so capacity is visible but not full.
    const riders = Math.floor(rand() * 6) + 16;
    for (let r = 0; r < riders && pupilIndex < pupils.length; r += 1) {
      const stop = stopIds[Math.floor(rand() * stopIds.length)]!;
      await db.insert(studentTransport).values({
        schoolId,
        studentId: pupils[pupilIndex]!.id,
        academicYearId: year.id,
        routeId: routeRow!.id,
        pickupStopId: stop,
        dropoffStopId: stop,
        startDate: addDays(TODAY, -90),
        status: 'active',
      });
      pupilIndex += 1;
    }
  }
}

async function seedHr(db: Database, schoolId: string, seed: number) {
  const rand = makeRandom(seed);

  const [existingTypes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveTypes)
    .where(eq(leaveTypes.schoolId, schoolId));

  if (Number(existingTypes?.n ?? 0) === 0) {
    await db.insert(leaveTypes).values(
      LEAVE_TYPES.map((t, i) => ({
        schoolId,
        key: t.key,
        name: t.name,
        nameAm: t.nameAm,
        daysPerYear: t.days,
        paid: t.paid,
        requiresApproval: true,
        active: true,
        sortOrder: i,
      })),
    );
  }

  const people = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.schoolId, schoolId), eq(staff.status, 'active')));
  if (people.length === 0) return;

  const [recorder] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.schoolId, schoolId), eq(users.username, 'admin')))
    .limit(1);

  // Two weeks of attendance history, working days only.
  const [existingAtt] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffAttendance)
    .where(eq(staffAttendance.schoolId, schoolId));

  if (Number(existingAtt?.n ?? 0) === 0) {
    const rows: (typeof staffAttendance.$inferInsert)[] = [];
    for (let back = 14; back >= 1; back -= 1) {
      const date = addDays(TODAY, -back);
      const [y, m, d] = date.split('-').map(Number);
      const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
      if (dow === 0 || dow === 6) continue;

      for (const person of people) {
        const roll = rand();
        const status = roll > 0.95 ? 'absent' : roll > 0.88 ? 'late' : 'present';
        rows.push({
          schoolId,
          staffId: person.id,
          date,
          status,
          checkIn: status === 'late' ? '08:25' : status === 'present' ? '07:55' : null,
          minutesLate: status === 'late' ? 25 : null,
          reason: status === 'absent' ? 'Not reported' : null,
          recordedBy: recorder?.id ?? null,
        });
      }
    }
    if (rows.length > 0) await db.insert(staffAttendance).values(rows);
  }

  // A couple of leave requests, one pending so the approval queue is not empty.
  const [existingLeave] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveRequests)
    .where(eq(leaveRequests.schoolId, schoolId));

  if (Number(existingLeave?.n ?? 0) === 0) {
    const types = await db
      .select({ id: leaveTypes.id, key: leaveTypes.key })
      .from(leaveTypes)
      .where(eq(leaveTypes.schoolId, schoolId));
    const annual = types.find((t) => t.key === 'annual') ?? types[0];
    const sick = types.find((t) => t.key === 'sick') ?? types[0];
    const [year] = await db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)))
      .limit(1);

    if (annual && sick && people.length >= 2) {
      await db.insert(leaveRequests).values([
        {
          schoolId,
          staffId: people[0]!.id,
          leaveTypeId: annual.id,
          academicYearId: year?.id ?? null,
          startDate: addDays(TODAY, 20),
          endDate: addDays(TODAY, 24),
          days: 5,
          reason: 'Family visit to Bahir Dar',
          status: 'pending',
          requestedBy: recorder?.id ?? null,
        },
        {
          schoolId,
          staffId: people[1]!.id,
          leaveTypeId: sick.id,
          academicYearId: year?.id ?? null,
          startDate: addDays(TODAY, -10),
          endDate: addDays(TODAY, -9),
          days: 2,
          reason: 'Medical appointment',
          status: 'approved',
          requestedBy: recorder?.id ?? null,
          decidedBy: recorder?.id ?? null,
          decidedAt: new Date(),
          decisionNote: 'Approved, get well soon.',
        },
      ]);
    }
  }
}

async function seedEvents(db: Database, schoolId: string) {
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schoolEvents)
    .where(eq(schoolEvents.schoolId, schoolId));
  if (Number(existing?.n ?? 0) > 0) return;

  const [creator] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.schoolId, schoolId), eq(users.username, 'admin')))
    .limit(1);
  const [year] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)))
    .limit(1);

  await db.insert(schoolEvents).values([
    {
      schoolId,
      academicYearId: year?.id ?? null,
      title: 'Parents\u2019 day',
      description: 'Termly meeting between parents and class teachers.',
      eventType: 'meeting',
      startDate: addDays(TODAY, 12),
      allDay: true,
      location: 'Main hall',
      audience: { kind: 'all' },
      visibleToPortal: true,
      colour: '#2563eb',
      createdBy: creator?.id ?? null,
    },
    {
      schoolId,
      academicYearId: year?.id ?? null,
      title: 'Inter-house sports day',
      eventType: 'sport',
      startDate: addDays(TODAY, 26),
      allDay: true,
      location: 'School field',
      audience: { kind: 'all' },
      visibleToPortal: true,
      colour: '#16a34a',
      createdBy: creator?.id ?? null,
    },
    {
      schoolId,
      academicYearId: year?.id ?? null,
      title: 'Staff briefing',
      eventType: 'meeting',
      startDate: addDays(TODAY, 3),
      startTime: '07:30',
      endTime: '08:15',
      allDay: false,
      location: 'Staff room',
      // Deliberately NOT visible to the portal: an internal meeting.
      audience: { kind: 'roles', roles: ['teacher', 'principal'] },
      visibleToPortal: false,
      createdBy: creator?.id ?? null,
    },
    {
      schoolId,
      academicYearId: year?.id ?? null,
      title: 'Mid-term examinations begin',
      eventType: 'exam',
      startDate: addDays(TODAY, 33),
      endDate: addDays(TODAY, 38),
      allDay: true,
      audience: { kind: 'all' },
      visibleToPortal: true,
      colour: '#dc2626',
      createdBy: creator?.id ?? null,
    },
  ]);
}

/** Per-school library and operations policy, so the two schools differ. */
async function seedSettings(
  db: Database,
  schoolId: string,
  library: Record<string, unknown>,
  operations: Record<string, unknown>,
) {
  for (const [key, value] of [
    ['library', library],
    ['operations', operations],
  ] as const) {
    const [existing] = await db
      .select({ id: schoolSettings.id })
      .from(schoolSettings)
      .where(and(eq(schoolSettings.schoolId, schoolId), eq(schoolSettings.key, key)))
      .limit(1);
    if (existing) continue;
    await db.insert(schoolSettings).values({ schoolId, key, value });
  }
  invalidateSettingsCache(schoolId);
}

// ---------------------------------------------------------------------------

async function main() {
  const db = await getDb();

  const [a] = await db.select().from(schools).where(eq(schools.code, 'bfa')).limit(1);
  const [b] = await db.select().from(schools).where(eq(schools.code, 'aps')).limit(1);

  if (!a || !b) {
    console.error('Run "npm run db:seed" first.');
    process.exit(1);
  }

  // School A: two-week loans, no fines, Monday to Friday.
  await seedSettings(
    db,
    a.id,
    {
      loanDays: 14,
      maxLoansPerBorrower: 3,
      maxRenewals: 2,
      finePerDayCents: 0,
      reminderDaysBefore: 2,
      accessionPrefix: 'BFA',
    },
    {
      workingDays: [1, 2, 3, 4, 5],
      leaveRequiresApproval: true,
      lowStockWarningFactor: 1,
      defaultStaffAttendanceStatus: 'present',
    },
  );

  // School B: one-week loans, a small daily fine, and a six-day working week.
  // Different on purpose — these are policies, not constants.
  await seedSettings(
    db,
    b.id,
    {
      loanDays: 7,
      maxLoansPerBorrower: 2,
      maxRenewals: 1,
      finePerDayCents: 100,
      reminderDaysBefore: 1,
      accessionPrefix: 'APS',
    },
    {
      workingDays: [1, 2, 3, 4, 5, 6],
      leaveRequiresApproval: true,
      lowStockWarningFactor: 1,
      defaultStaffAttendanceStatus: 'present',
    },
  );

  console.log('Seeding operations data …');

  // School A has every operations module switched on.
  await seedLibrary(db, a.id, 'BFA', 11);
  await seedLoans(db, a.id, 12);
  await seedInventory(db, a.id);
  await seedAssetsAndMaintenance(db, a.id, 'BFA');
  await seedTransport(db, a.id, 13);
  await seedHr(db, a.id, 14);
  await seedEvents(db, a.id);
  console.log('  Bright Future Academy: library, stock, assets, transport, HR, calendar');

  // School B runs only library, HR and documents — so it gets only those.
  // Seeding transport here would create data no page will ever show, which is
  // exactly the kind of thing that hides a missing module check.
  await seedLibrary(db, b.id, 'APS', 21);
  await seedLoans(db, b.id, 22);
  await seedHr(db, b.id, 24);
  await seedEvents(db, b.id);
  console.log('  Addis Preparatory: library, HR, calendar (transport/stock/assets off)');

  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Operations seed failed:', error);
    process.exit(1);
  });
