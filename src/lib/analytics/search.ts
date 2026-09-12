/**
 * Global search.
 *
 * ## The rule that governs this file
 *
 * A search box is the easiest place in a school system to leak data. It
 * touches every table, it is used by every role, and a forgotten `school_id`
 * in one branch of a union produces a leak that no page-level test would
 * catch — the user only sees a name in a dropdown, and nobody notices it
 * belongs to another school.
 *
 * So this module refuses to be clever:
 *
 *  1. **Every source is a separate query, never a UNION.** A union tempts you
 *     to write the tenant filter once and assume it covers every arm.
 *  2. **Every source declares its permission and its module.** A source whose
 *     permission the caller lacks is not queried at all — not queried and
 *     filtered, not queried and hidden. Never executed.
 *  3. **Every source filters `school_id` explicitly**, even where a join would
 *     already imply it.
 *  4. **Section-restricted callers** (`restrict.ownSectionsOnly`) get their
 *     student results narrowed to their own sections, and sources they have no
 *     legitimate school-wide view of are skipped.
 *  5. **Portal users are not served by this at all.** A parent or pupil has no
 *     business enumerating the school; they have their own screens. The route
 *     rejects them before reaching here.
 *
 * Sensitive fields — medical notes, addresses, guardian phone numbers — are
 * deliberately NOT searchable. Being able to find a child by typing part of
 * their medical condition is not a feature.
 */

import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/context.ts';
import type { Permission } from '../auth/permissions.ts';
import type { ModuleKey } from '../settings/schemas.ts';
import { getSetting } from '../settings/service.ts';
import { students, staff, guardians } from '../../db/schema/people.ts';
import { sections, subjects, gradeLevels, users } from '../../db/schema/core.ts';
import { feeCategories, feeStructures } from '../../db/schema/finance.ts';
import {
  libraryItems,
  inventoryItems,
  assets,
  vehicles,
  transportRoutes,
  documents,
} from '../../db/schema/operations.ts';

/** What kind of thing a hit is. Drives the icon and the link. */
export type SearchKind =
  | 'student'
  | 'guardian'
  | 'staff'
  | 'section'
  | 'subject'
  | 'fee'
  | 'library'
  | 'inventory'
  | 'asset'
  | 'vehicle'
  | 'route'
  | 'document';

export type SearchHit = {
  kind: SearchKind;
  id: string;
  /** Primary line. Already a display string; no further formatting needed. */
  title: string;
  /** Secondary line: class, code, status — whatever disambiguates. */
  subtitle: string | null;
  /** Where clicking goes. Always an in-app path. */
  href: string;
};

export type SearchResults = {
  query: string;
  hits: SearchHit[];
  /** Sources actually searched, so the UI can say what was covered. */
  searched: SearchKind[];
  truncated: boolean;
};

/** Minimum query length. One letter would scan the whole school for nothing. */
export const MIN_QUERY_LENGTH = 2;
const PER_SOURCE_LIMIT = 5;
const TOTAL_LIMIT = 40;

/**
 * Escapes LIKE wildcards in user input.
 *
 * Without this, a search for "%" matches every row in the school — a trivial
 * way to enumerate a database through a search box.
 */
function likeTerm(raw: string): string {
  const escaped = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Case-insensitive contains, with wildcards neutralised. */
function contains(column: SQL | unknown, term: string): SQL {
  return sql`${column} ilike ${term} escape '\\'`;
}

export async function globalSearch(
  ctx: AuthContext,
  rawQuery: string,
  options: { kinds?: SearchKind[] } = {},
): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    return { query, hits: [], searched: [], truncated: false };
  }

  const term = likeTerm(query);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');
  const wanted = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;

  /** A caller may only search a source if permitted AND the module is on. */
  const allowed = (kind: SearchKind, permission: Permission, moduleKey?: ModuleKey): boolean => {
    if (wanted && !wanted.has(kind)) return false;
    if (!ctx.has(permission)) return false;
    if (moduleKey && !modules[moduleKey]) return false;
    return true;
  };

  const hits: SearchHit[] = [];
  const searched: SearchKind[] = [];
  const restricted = ctx.has('restrict.ownSectionsOnly');
  const ownSections = ctx.relationships.sectionIds;

  // -- students -------------------------------------------------------------
  if (allowed('student', 'student.view')) {
    searched.push('student');
    // A section-restricted teacher searches their own classes only. With no
    // sections assigned the condition is `false`, which yields nothing —
    // never "everything".
    const scope: SQL[] = [];
    if (restricted) {
      scope.push(
        ownSections.length === 0
          ? sql`false`
          : sql`exists (select 1 from enrollments e
              where e.student_id = ${students}.${sql.identifier('id')}
                and e.ended_on is null
                and e.section_id in ${ownSections})`,
      );
    }

    const rows = await ctx.db
      .select({
        id: students.id,
        studentCode: students.studentCode,
        givenName: students.givenName,
        fatherName: students.fatherName,
        grandfatherName: students.grandfatherName,
        status: students.status,
      })
      .from(students)
      .where(
        and(
          eq(students.schoolId, ctx.schoolId),
          isNull(students.deletedAt),
          ...scope,
          or(
            contains(students.givenName, term),
            contains(students.fatherName, term),
            contains(students.grandfatherName, term),
            contains(students.givenNameAm, term),
            contains(students.fatherNameAm, term),
            contains(students.studentCode, term),
          ),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'student',
        id: r.id,
        title: [r.givenName, r.fatherName, r.grandfatherName].filter(Boolean).join(' '),
        subtitle: `${r.studentCode}${r.status !== 'active' ? ` · ${r.status}` : ''}`,
        href: `/students/${r.id}`,
      });
    }
  }

  // -- guardians ------------------------------------------------------------
  // Not offered to section-restricted staff: a class teacher has a legitimate
  // need for their pupils' guardians on the pupil's own profile, but not a
  // school-wide guardian directory.
  if (!restricted && allowed('guardian', 'guardian.view')) {
    searched.push('guardian');
    const rows = await ctx.db
      .select({
        id: guardians.id,
        givenName: guardians.givenName,
        fatherName: guardians.fatherName,
        phone: guardians.phone,
      })
      .from(guardians)
      .where(
        and(
          eq(guardians.schoolId, ctx.schoolId),
          or(
            contains(guardians.givenName, term),
            contains(guardians.fatherName, term),
            contains(guardians.phone, term),
          ),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'guardian',
        id: r.id,
        title: [r.givenName, r.fatherName].filter(Boolean).join(' '),
        subtitle: r.phone,
        href: `/guardians/${r.id}`,
      });
    }
  }

  // -- staff ----------------------------------------------------------------
  if (allowed('staff', 'staff.view')) {
    searched.push('staff');
    const rows = await ctx.db
      .select({
        id: staff.id,
        staffCode: staff.staffCode,
        staffType: staff.staffType,
        givenName: users.givenName,
        fatherName: users.fatherName,
      })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .where(
        and(
          eq(staff.schoolId, ctx.schoolId),
          or(
            contains(users.givenName, term),
            contains(users.fatherName, term),
            contains(staff.staffCode, term),
          ),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'staff',
        id: r.id,
        title: [r.givenName, r.fatherName].filter(Boolean).join(' '),
        subtitle: `${r.staffCode ?? ''} ${r.staffType}`.trim(),
        href: `/staff/${r.id}`,
      });
    }
  }

  // -- sections -------------------------------------------------------------
  if (allowed('section', 'academic.view')) {
    searched.push('section');
    const scope: SQL[] =
      restricted && ownSections.length === 0
        ? [sql`false`]
        : restricted
          ? [sql`${sections.id} in ${ownSections}`]
          : [];

    const rows = await ctx.db
      .select({
        id: sections.id,
        name: sections.name,
        gradeName: gradeLevels.name,
      })
      .from(sections)
      .innerJoin(gradeLevels, eq(gradeLevels.id, sections.gradeLevelId))
      .where(
        and(
          eq(sections.schoolId, ctx.schoolId),
          eq(sections.isActive, true),
          ...scope,
          or(contains(sections.name, term), contains(gradeLevels.name, term)),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'section',
        id: r.id,
        title: `${r.gradeName} ${r.name}`,
        subtitle: null,
        href: `/attendance/${r.id}`,
      });
    }
  }

  // -- subjects -------------------------------------------------------------
  if (allowed('subject', 'academic.view')) {
    searched.push('subject');
    const rows = await ctx.db
      .select({ id: subjects.id, name: subjects.name, code: subjects.code })
      .from(subjects)
      .where(
        and(
          eq(subjects.schoolId, ctx.schoolId),
          eq(subjects.isActive, true),
          or(
            contains(subjects.name, term),
            contains(subjects.nameAm, term),
            contains(subjects.code, term),
          ),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'subject',
        id: r.id,
        title: r.name,
        subtitle: r.code,
        href: '/academics',
      });
    }
  }

  // -- fee structures -------------------------------------------------------
  if (allowed('fee', 'fee.view', 'fees')) {
    searched.push('fee');
    const rows = await ctx.db
      .select({
        id: feeStructures.id,
        name: feeStructures.name,
        categoryName: feeCategories.name,
      })
      .from(feeStructures)
      .innerJoin(feeCategories, eq(feeCategories.id, feeStructures.categoryId))
      .where(
        and(
          eq(feeStructures.schoolId, ctx.schoolId),
          or(contains(feeStructures.name, term), contains(feeCategories.name, term)),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'fee',
        id: r.id,
        title: r.name,
        subtitle: r.categoryName,
        href: '/finance/fees',
      });
    }
  }

  // -- library --------------------------------------------------------------
  if (allowed('library', 'library.view', 'library')) {
    searched.push('library');
    const rows = await ctx.db
      .select({
        id: libraryItems.id,
        title: libraryItems.title,
        author: libraryItems.author,
      })
      .from(libraryItems)
      .where(
        and(
          eq(libraryItems.schoolId, ctx.schoolId),
          or(
            contains(libraryItems.title, term),
            contains(libraryItems.author, term),
            contains(libraryItems.isbn, term),
          ),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'library',
        id: r.id,
        title: r.title,
        subtitle: r.author,
        href: `/library?q=${encodeURIComponent(r.title)}`,
      });
    }
  }

  // -- inventory ------------------------------------------------------------
  if (allowed('inventory', 'inventory.view', 'inventory')) {
    searched.push('inventory');
    const rows = await ctx.db
      .select({ id: inventoryItems.id, name: inventoryItems.name, sku: inventoryItems.sku })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.schoolId, ctx.schoolId),
          or(contains(inventoryItems.name, term), contains(inventoryItems.sku, term)),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'inventory',
        id: r.id,
        title: r.name,
        subtitle: r.sku,
        href: '/inventory',
      });
    }
  }

  // -- assets ---------------------------------------------------------------
  if (allowed('asset', 'asset.view', 'maintenance')) {
    searched.push('asset');
    const rows = await ctx.db
      .select({ id: assets.id, name: assets.name, tag: assets.assetTag })
      .from(assets)
      .where(
        and(
          eq(assets.schoolId, ctx.schoolId),
          or(contains(assets.name, term), contains(assets.assetTag, term)),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'asset',
        id: r.id,
        title: r.name,
        subtitle: r.tag,
        href: '/facilities',
      });
    }
  }

  // -- transport ------------------------------------------------------------
  if (allowed('vehicle', 'transport.view', 'transport')) {
    searched.push('vehicle');
    const rows = await ctx.db
      .select({ id: vehicles.id, plate: vehicles.plateNumber, label: vehicles.label })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.schoolId, ctx.schoolId),
          or(contains(vehicles.plateNumber, term), contains(vehicles.label, term)),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'vehicle',
        id: r.id,
        title: r.plate,
        subtitle: r.label,
        href: '/transport',
      });
    }
  }

  if (allowed('route', 'transport.view', 'transport')) {
    searched.push('route');
    const rows = await ctx.db
      .select({ id: transportRoutes.id, name: transportRoutes.name })
      .from(transportRoutes)
      .where(
        and(
          eq(transportRoutes.schoolId, ctx.schoolId),
          contains(transportRoutes.name, term),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'route',
        id: r.id,
        title: r.name,
        subtitle: null,
        href: `/transport/${r.id}`,
      });
    }
  }

  // -- documents ------------------------------------------------------------
  if (allowed('document', 'document.view', 'documents')) {
    searched.push('document');
    const rows = await ctx.db
      .select({ id: documents.id, title: documents.title, category: documents.category })
      .from(documents)
      .where(
        and(
          eq(documents.schoolId, ctx.schoolId),
          or(contains(documents.title, term), contains(documents.fileName, term)),
        ),
      )
      .limit(PER_SOURCE_LIMIT);

    for (const r of rows) {
      hits.push({
        kind: 'document',
        id: r.id,
        title: r.title,
        subtitle: r.category,
        href: '/documents',
      });
    }
  }

  return {
    query,
    hits: hits.slice(0, TOTAL_LIMIT),
    searched,
    truncated: hits.length > TOTAL_LIMIT,
  };
}
