/**
 * Request authorization context.
 *
 * Every API route and every server-rendered page obtains its context here.
 * The context carries the signed-in user, their school, their effective
 * permissions and — crucially — their *relationship scope*: which sections a
 * teacher teaches, which children a parent has, which student a student is.
 *
 * Role alone is not enough. "Teacher" does not mean "may see all students"; it
 * means "may see students in my sections". That distinction is what stops
 * Parent A reading Student B's marks by guessing an id, and it is enforced
 * here rather than in each handler.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { getDb, type Database } from '../../db/client.ts';
import {
  roles as rolesTable,
  rolePermissions,
  userRoles,
  sections,
  sectionSubjects,
  academicYears,
} from '../../db/schema/core.ts';
import { students, guardians, studentGuardians, enrollments } from '../../db/schema/people.ts';
import { createScope, type Scope } from '../../db/scope.ts';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './session.ts';
import type { Permission } from './permissions.ts';
import { resolveLocale, createTranslator, type Locale, type Translator } from '../i18n/index.ts';
import { getSetting } from '../settings/service.ts';
import type { ModuleKey } from '../settings/schemas.ts';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 404 = 403,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type RelationshipScope = {
  /** Sections where the user is class teacher or teaches a subject. */
  sectionIds: string[];
  /** section_subject ids the user teaches. */
  sectionSubjectIds: string[];
  /** Students this user may see because they are their children. */
  childStudentIds: string[];
  /** The student record this user *is*, when the user is a student. */
  ownStudentId: string | null;
  /** Guardian record for a parent user. */
  guardianId: string | null;
};

export type AuthContext = {
  db: Database;
  user: SessionUser;
  schoolId: string;
  scope: Scope;
  permissions: Set<Permission>;
  roleKeys: string[];
  relationships: RelationshipScope;
  locale: Locale;
  t: Translator;
  ipAddress: string | null;

  has(permission: Permission): boolean;
  hasAny(...permissions: Permission[]): boolean;
  require(permission: Permission): void;
  requireAny(...permissions: Permission[]): void;
  requireModule(module: ModuleKey): Promise<void>;
  /** Throw unless the user may view this particular student. */
  requireStudentAccess(studentId: string): Promise<void>;
  canViewStudent(studentId: string): Promise<boolean>;
  /** Throw unless the user may take/edit attendance or marks for this section. */
  requireSectionAccess(sectionId: string): void;
  displayName(): string;
};

/** Load the permission set and role keys for a user. */
export async function loadPermissions(
  db: Database,
  userId: string,
): Promise<{ permissions: Set<Permission>; roleKeys: string[] }> {
  const rows = await db
    .select({ permission: rolePermissions.permission, roleKey: rolesTable.key })
    .from(userRoles)
    .innerJoin(rolesTable, eq(rolesTable.id, userRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, rolesTable.id))
    .where(eq(userRoles.userId, userId));

  const permissions = new Set<Permission>();
  const roleKeys = new Set<string>();
  for (const row of rows) {
    if (row.permission) permissions.add(row.permission as Permission);
    if (row.roleKey) roleKeys.add(row.roleKey);
  }
  return { permissions, roleKeys: [...roleKeys] };
}

/** Resolve which sections, children and student record a user is tied to. */
export async function loadRelationships(
  db: Database,
  schoolId: string,
  userId: string,
): Promise<RelationshipScope> {
  const [taughtSubjects, homeroomSections, ownStudent, guardianRows] = await Promise.all([
    db
      .select({ id: sectionSubjects.id, sectionId: sectionSubjects.sectionId })
      .from(sectionSubjects)
      .where(and(eq(sectionSubjects.schoolId, schoolId), eq(sectionSubjects.teacherId, userId))),
    db
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.schoolId, schoolId), eq(sections.classTeacherId, userId))),
    db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, schoolId), eq(students.userId, userId)))
      .limit(1),
    db
      .select({ id: guardians.id })
      .from(guardians)
      .where(and(eq(guardians.schoolId, schoolId), eq(guardians.userId, userId)))
      .limit(1),
  ]);

  const guardianId = guardianRows[0]?.id ?? null;

  let childStudentIds: string[] = [];
  if (guardianId) {
    const children = await db
      .select({ studentId: studentGuardians.studentId })
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.schoolId, schoolId),
          eq(studentGuardians.guardianId, guardianId),
        ),
      );
    childStudentIds = children.map((c) => c.studentId);
  }

  const sectionIds = new Set<string>();
  for (const s of taughtSubjects) sectionIds.add(s.sectionId);
  for (const s of homeroomSections) sectionIds.add(s.id);

  return {
    sectionIds: [...sectionIds],
    sectionSubjectIds: taughtSubjects.map((s) => s.id),
    childStudentIds,
    ownStudentId: ownStudent[0]?.id ?? null,
    guardianId,
  };
}

/**
 * Build the authorization context for the current request.
 * Returns null when there is no valid session.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const db = await getDb();
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(db, token);
  if (!user) return null;
  if (!user.schoolId) {
    // Platform admins have no school context; they use the platform console.
    return null;
  }
  return buildContext(db, user, user.schoolId);
}

/** Construct a context from an already-resolved session. */
export async function buildContext(
  db: Database,
  user: SessionUser,
  schoolId: string,
): Promise<AuthContext> {
  const [{ permissions, roleKeys }, relationships, localeSettings] = await Promise.all([
    loadPermissions(db, user.userId),
    loadRelationships(db, schoolId, user.userId),
    getSetting(db, schoolId, 'locale'),
  ]);

  let acceptLanguage: string | null = null;
  let ipAddress: string | null = null;
  try {
    const h = await headers();
    acceptLanguage = h.get('accept-language');
    ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  } catch {
    // headers() is unavailable outside a request (e.g. in tests).
  }

  const locale = resolveLocale(
    localeSettings.allowUserOverride ? user.locale : null,
    localeSettings.defaultLocale,
    acceptLanguage,
  );

  const scope = createScope(db, schoolId);
  const t = createTranslator(locale);

  const ctx: AuthContext = {
    db,
    user,
    schoolId,
    scope,
    permissions,
    roleKeys,
    relationships,
    locale,
    t,
    ipAddress,

    has: (permission) => permissions.has(permission),
    hasAny: (...list) => list.some((p) => permissions.has(p)),

    require(permission) {
      if (!permissions.has(permission)) {
        throw new AuthError(`Missing permission: ${permission}`, 403);
      }
    },

    requireAny(...list) {
      if (!list.some((p) => permissions.has(p))) {
        throw new AuthError(`Missing one of: ${list.join(', ')}`, 403);
      }
    },

    async requireModule(module) {
      const modules = await getSetting(db, schoolId, 'modules');
      if (!modules[module]) {
        // Disabling a module disables it server-side, not just in the menu.
        throw new AuthError(`Module "${module}" is not enabled for this school`, 403);
      }
    },

    async canViewStudent(studentId) {
      if (!studentId) return false;

      // The student themself.
      if (relationships.ownStudentId === studentId) return true;
      // A parent, for their own children only.
      if (relationships.childStudentIds.includes(studentId)) return true;

      // Staff with a school-wide student permission and no narrowing
      // restriction.
      if (permissions.has('student.view') && !permissions.has('restrict.ownSectionsOnly')) {
        // Confirm the student belongs to this school.
        const row = await scope.findById(students, studentId);
        return row !== null;
      }

      // A user carrying the own-sections restriction: the student must be
      // currently enrolled in one of the sections they teach.
      if (permissions.has('restrict.ownSectionsOnly') && relationships.sectionIds.length > 0) {
        const rows = await db
          .select({ id: enrollments.id })
          .from(enrollments)
          .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
          .where(
            and(
              eq(enrollments.schoolId, schoolId),
              eq(enrollments.studentId, studentId),
              isNull(enrollments.endedOn),
              eq(academicYears.isCurrent, true),
              or(...relationships.sectionIds.map((id) => eq(enrollments.sectionId, id))),
            ),
          )
          .limit(1);
        return rows.length > 0;
      }

      return false;
    },

    async requireStudentAccess(studentId) {
      const allowed = await ctx.canViewStudent(studentId);
      if (!allowed) {
        // 404 rather than 403: confirming that an id exists but is off-limits
        // would leak the roll of another school or another parent's child.
        throw new AuthError('Student not found', 404);
      }
    },

    requireSectionAccess(sectionId) {
      if (permissions.has('attendance.editAny') || permissions.has('academic.manage')) return;
      if (!relationships.sectionIds.includes(sectionId)) {
        throw new AuthError('You are not assigned to this class', 403);
      }
    },

    displayName() {
      return [user.givenName, user.fatherName].filter(Boolean).join(' ');
    },
  };

  return ctx;
}

/** Get the context or throw 401. Use at the top of protected handlers. */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new AuthError('Authentication required', 401);
  return ctx;
}

/** Get the context and assert a permission in one call. */
export async function requirePermission(permission: Permission): Promise<AuthContext> {
  const ctx = await requireAuth();
  ctx.require(permission);
  return ctx;
}
