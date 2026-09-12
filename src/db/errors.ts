/**
 * Database error interpretation.
 *
 * Drizzle wraps driver errors, so the PostgreSQL error code lives on
 * `error.cause`, not on the error itself. Application code that needs to
 * distinguish "this student ID is already taken" from "the database is down"
 * must unwrap it — otherwise a duplicate-key error surfaces to a registrar as
 * a generic 500 and they have no idea what went wrong.
 */

/** PostgreSQL error codes we act on. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
} as const;

export type PgErrorInfo = {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
  message: string;
};

/** Extract PostgreSQL error details from anywhere in the cause chain. */
export function extractPgError(error: unknown): PgErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as Record<string, unknown>;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      return {
        code: e.code,
        constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
        detail: typeof e.detail === 'string' ? e.detail : undefined,
        table: typeof e.table === 'string' ? e.table : undefined,
        column: typeof e.column === 'string' ? e.column : undefined,
        message: typeof e.message === 'string' ? e.message : String(error),
      };
    }
    current = e.cause;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = extractPgError(error);
  if (!pg || pg.code !== PG_ERROR.UNIQUE_VIOLATION) return false;
  return constraint ? pg.constraint === constraint : true;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return extractPgError(error)?.code === PG_ERROR.FOREIGN_KEY_VIOLATION;
}

export function isNotNullViolation(error: unknown): boolean {
  return extractPgError(error)?.code === PG_ERROR.NOT_NULL_VIOLATION;
}

/**
 * Map a constraint name to a message a school employee can act on.
 * Falling back to the raw constraint name would leak schema details and mean
 * nothing to a registrar.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  students_school_code_uq: 'A student with this ID already exists. Student IDs must be unique.',
  users_school_username_uq: 'This username is already taken at this school.',
  staff_school_code_uq: 'A staff member with this code already exists.',
  staff_user_uq: 'This user already has a staff record.',
  schools_code_uq: 'This school code is already in use.',
  roles_school_key_uq: 'A role with this key already exists.',
  subjects_school_code_uq: 'A subject with this code already exists.',
  grade_levels_school_name_uq: 'A grade level with this name already exists.',
  sections_year_grade_name_uq: 'This section already exists for this grade and academic year.',
  section_subjects_uq: 'This subject is already assigned to this section.',
  academic_years_school_name_uq: 'An academic year with this name already exists.',
  academic_years_one_current_uq:
    'Another academic year is already set as current. Only one year can be current at a time.',
  terms_one_current_uq:
    'Another term is already set as current. Only one term can be current at a time.',
  terms_year_sequence_uq: 'A term with this sequence number already exists in this year.',
  enrollments_student_year_active_uq:
    'This student already has an active enrolment for this academic year.',
  rooms_school_name_uq: 'A room with this name already exists.',
  periods_school_sequence_uq: 'A period with this sequence number already exists.',
  school_settings_school_key_uq: 'These settings already exist.',
  custom_field_defs_uq: 'A custom field with this key already exists.',
  student_guardians_pkey: 'This guardian is already linked to this student.',
  // Cross-tenant integrity guards.
  student_guardians_student_school_fk:
    'The student and guardian must belong to the same school.',
  enrollments_student_school_fk: 'The student must belong to the same school as the enrolment.',
  enrollments_section_school_fk: 'The section must belong to the same school as the enrolment.',
  section_subjects_section_school_fk: 'The section must belong to the same school.',
  section_subjects_subject_school_fk: 'The subject must belong to the same school.',
  sections_grade_school_fk: 'The grade level must belong to the same school.',
};

/** Turn a database error into a message suitable for showing to a user. */
export function friendlyDbError(error: unknown): string | null {
  const pg = extractPgError(error);
  if (!pg) return null;

  if (pg.constraint && CONSTRAINT_MESSAGES[pg.constraint]) {
    return CONSTRAINT_MESSAGES[pg.constraint]!;
  }

  switch (pg.code) {
    case PG_ERROR.UNIQUE_VIOLATION:
      return 'This record already exists.';
    case PG_ERROR.FOREIGN_KEY_VIOLATION:
      return 'This action references a record that does not exist, or is still in use elsewhere.';
    case PG_ERROR.NOT_NULL_VIOLATION:
      return `A required value is missing${pg.column ? `: ${pg.column}` : ''}.`;
    case PG_ERROR.CHECK_VIOLATION:
      return 'The values provided are not valid for this record.';
    default:
      return null;
  }
}
