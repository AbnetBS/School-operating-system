/**
 * School configuration schemas.
 *
 * Everything that differs between Ethiopian schools lives here as validated
 * data: grading scales, assessment weights, attendance thresholds, term
 * structure, report-card layout, fee policy, enabled modules and approval
 * workflows.
 *
 * Adding a school must never require changing application code. If a rule
 * varies between schools and is not represented here, that is a design bug.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/**
 * Feature switches. Schools enable only what they use, and subscription plans
 * gate which switches may be turned on.
 */
export const modulesSchema = z.object({
  attendance: z.boolean().default(true),
  gradebook: z.boolean().default(true),
  reportCards: z.boolean().default(true),
  studentPortal: z.boolean().default(true),
  parentPortal: z.boolean().default(true),
  announcements: z.boolean().default(true),
  // Phase 2+
  admission: z.boolean().default(false),
  onlineRegistration: z.boolean().default(false),
  fees: z.boolean().default(false),
  payments: z.boolean().default(false),
  sms: z.boolean().default(false),
  homework: z.boolean().default(false),
  timetable: z.boolean().default(false),
  exams: z.boolean().default(false),
  documents: z.boolean().default(false),
  // Phase 3+
  hr: z.boolean().default(false),
  payroll: z.boolean().default(false),
  transport: z.boolean().default(false),
  library: z.boolean().default(false),
  inventory: z.boolean().default(false),
  maintenance: z.boolean().default(false),
  website: z.boolean().default(false),
  marketplace: z.boolean().default(false),
  aiAssistant: z.boolean().default(false),
});
export type Modules = z.infer<typeof modulesSchema>;
export type ModuleKey = keyof Modules;

// ---------------------------------------------------------------------------
// Locale and calendar
// ---------------------------------------------------------------------------

export const localeSettingsSchema = z.object({
  /** Default interface language for new users at this school. */
  defaultLocale: z.enum(['en', 'am']).default('en'),
  /** Whether users may choose their own language. */
  allowUserOverride: z.boolean().default(true),
  /** Which calendar to show in the interface. */
  calendarDisplay: z.enum(['ethiopian', 'gregorian', 'both']).default('both'),
  /** Which calendar date-entry fields default to. */
  calendarInput: z.enum(['ethiopian', 'gregorian']).default('gregorian'),
  timezone: z.string().default('Africa/Addis_Ababa'),
  currency: z.string().default('ETB'),
});
export type LocaleSettings = z.infer<typeof localeSettingsSchema>;

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/** One band of a letter-grade scale, e.g. A = 90–100. */
export const gradeBandSchema = z
  .object({
    letter: z.string().min(1).max(4),
    minPercent: z.number().min(0).max(100),
    maxPercent: z.number().min(0).max(100),
    /** Grade point, for schools that compute a GPA. */
    points: z.number().min(0).max(10).optional(),
    description: z.string().max(64).optional(),
    descriptionAm: z.string().max(64).optional(),
    isPass: z.boolean().default(true),
  })
  .refine((b) => b.maxPercent >= b.minPercent, {
    message: 'Band maximum must be greater than or equal to its minimum',
  });
export type GradeBand = z.infer<typeof gradeBandSchema>;

/**
 * A weighted assessment component, e.g. Midterm = 30%.
 * `maxMark` is what a teacher enters out of; the weight converts it to its
 * share of the subject total.
 */
export const assessmentComponentSchema = z.object({
  key: z.string().min(1).max(32),
  name: z.string().min(1).max(64),
  nameAm: z.string().max(64).optional(),
  weightPercent: z.number().min(0).max(100),
  maxMark: z.number().positive().max(1000).default(100),
  /** Several instances averaged together, e.g. "best 3 of 4 quizzes". */
  instances: z.number().int().min(1).max(20).default(1),
  /** Drop the lowest N instances before averaging. */
  dropLowest: z.number().int().min(0).max(10).default(0),
  sortOrder: z.number().int().default(0),
});
export type AssessmentComponent = z.infer<typeof assessmentComponentSchema>;

export const gradingSettingsSchema = z
  .object({
    /** How a subject mark is displayed on reports. */
    displayMode: z.enum(['percentage', 'letter', 'both', 'points']).default('both'),
    /** Marks below this percentage fail. */
    passMarkPercent: z.number().min(0).max(100).default(50),
    /** Decimal places for displayed averages. */
    decimalPlaces: z.number().int().min(0).max(3).default(1),
    /** Round subject totals to the nearest whole mark. */
    roundTotals: z.boolean().default(true),
    /** Whether report cards show class rank. Many schools deliberately do not. */
    useRanking: z.boolean().default(false),
    /** Rank within the section, the grade level, or both. */
    rankScope: z.enum(['section', 'gradeLevel', 'both']).default('section'),
    /** Compute a grade point average. */
    useGpa: z.boolean().default(false),
    /** Letter-grade bands, ordered highest first. */
    bands: z.array(gradeBandSchema).default([]),
    /** Default assessment structure; a subject may override it. */
    components: z.array(assessmentComponentSchema).default([]),
    /** Minimum attendance percentage required to pass a term, if enforced. */
    minAttendancePercentForPass: z.number().min(0).max(100).nullable().default(null),
  })
  .refine(
    (g) => {
      if (g.components.length === 0) return true;
      const total = g.components.reduce((s, c) => s + c.weightPercent, 0);
      // Allow a small tolerance for schools using thirds (33.33 x 3).
      return Math.abs(total - 100) < 0.5;
    },
    { message: 'Assessment component weights must add up to 100%' },
  )
  .refine(
    (g) => {
      // Bands must not overlap.
      const sorted = [...g.bands].sort((a, b) => a.minPercent - b.minPercent);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.minPercent <= sorted[i - 1]!.maxPercent) return false;
      }
      return true;
    },
    { message: 'Grade bands must not overlap' },
  );
export type GradingSettings = z.infer<typeof gradingSettingsSchema>;

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export const attendanceSettingsSchema = z.object({
  /** Once per day, or once per subject period. */
  mode: z.enum(['daily', 'perSubject', 'both']).default('daily'),
  /** Statuses a teacher may choose. */
  statuses: z
    .array(z.enum(['present', 'absent', 'late', 'excused', 'sick']))
    .default(['present', 'absent', 'late', 'excused']),
  /** Everyone starts present; the teacher marks only the exceptions. */
  defaultStatus: z.enum(['present', 'absent', 'unmarked']).default('present'),
  /** Minutes after the period start beyond which a student counts as late. */
  lateAfterMinutes: z.number().int().min(0).max(240).default(10),
  /** Below this attendance percentage, a student is flagged at risk. */
  riskThresholdPercent: z.number().min(0).max(100).default(85),
  /** Consecutive absences that trigger an alert. */
  consecutiveAbsenceAlert: z.number().int().min(1).max(30).default(3),
  /** Lateness occurrences in a term that trigger an alert. */
  latenessAlertCount: z.number().int().min(1).max(50).default(5),
  /** Notify the guardian when a student is marked absent. */
  notifyGuardianOnAbsence: z.boolean().default(true),
  /** Notify the class teacher when the consecutive-absence rule trips. */
  notifyClassTeacherOnRisk: z.boolean().default(true),
  /** Whether teachers may edit attendance after the day has passed. */
  allowBackdating: z.boolean().default(true),
  /** How many days back a teacher may edit without elevated permission. */
  backdateLimitDays: z.number().int().min(0).max(90).default(7),
  /** Days of the week school runs; 0 = Sunday. */
  schoolDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  /** Require a reason when marking a student absent. */
  requireAbsenceReason: z.boolean().default(false),
});
export type AttendanceSettings = z.infer<typeof attendanceSettingsSchema>;

// ---------------------------------------------------------------------------
// Academic structure defaults
// ---------------------------------------------------------------------------

export const academicSettingsSchema = z.object({
  /** What this school calls its grading periods. */
  termStructure: z.enum(['term', 'semester', 'quarter']).default('term'),
  termsPerYear: z.number().int().min(1).max(6).default(3),
  /** Students choose subjects (common at secondary level) or take a fixed set. */
  useSubjectSelection: z.boolean().default(false),
  /** Automatically produce the next year's enrolment on promotion. */
  autoPromote: z.boolean().default(false),
  /** Minimum average required for promotion, when auto-promotion is used. */
  promotionMinAverage: z.number().min(0).max(100).default(50),
  /** Pattern for generated student codes; {year} {seq} {grade} are substituted. */
  studentCodeFormat: z.string().default('{year}/{seq}'),
  studentCodeSeqPadding: z.number().int().min(1).max(8).default(4),
  /** Pattern for generated staff codes; {year} and {seq} are substituted. */
  staffCodeFormat: z.string().default('STF/{seq}'),
  staffCodeSeqPadding: z.number().int().min(1).max(8).default(3),
});
export type AcademicSettings = z.infer<typeof academicSettingsSchema>;

// ---------------------------------------------------------------------------
// Report cards
// ---------------------------------------------------------------------------

export const reportCardSettingsSchema = z.object({
  showLogo: z.boolean().default(true),
  showPhoto: z.boolean().default(true),
  showAttendance: z.boolean().default(true),
  showRank: z.boolean().default(false),
  showClassAverage: z.boolean().default(true),
  showTeacherComment: z.boolean().default(true),
  showPrincipalComment: z.boolean().default(true),
  showConduct: z.boolean().default(false),
  showSignatures: z.boolean().default(true),
  headerText: z.string().max(200).optional(),
  headerTextAm: z.string().max(200).optional(),
  footerText: z.string().max(300).optional(),
  /** Which language the printed report card uses. */
  printLocale: z.enum(['en', 'am', 'both']).default('en'),
  /** Approval steps, in order. Each is a permission key that must sign off. */
  approvalChain: z
    .array(z.enum(['grade.review', 'reportCard.approve']))
    .default(['reportCard.approve']),
  /** Parents and students may view results only once published. */
  publishToPortals: z.boolean().default(true),
});
export type ReportCardSettings = z.infer<typeof reportCardSettingsSchema>;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Field-level defaults for per-event notification toggles. */
function notificationChannelDefaults() {
  return {
    attendanceAbsent: true,
    attendanceRisk: true,
    gradePublished: true,
    reportCardPublished: true,
    paymentRecorded: true,
    feeDue: true,
    homeworkAssigned: false,
    announcement: true,
  };
}

/** 24-hour clock time, 00:00 to 23:59. */
const TIME_24H = /^([01]\d|2[0-3]):[0-5]\d$/;

export const notificationSettingsSchema = z.object({
  channels: z
    .object({
      inApp: z.boolean().default(true),
      sms: z.boolean().default(false),
      email: z.boolean().default(false),
      push: z.boolean().default(false),
    })
    .default({ inApp: true, sms: false, email: false, push: false }),
  events: z
    .object({
      attendanceAbsent: z.boolean().default(true),
      attendanceRisk: z.boolean().default(true),
      gradePublished: z.boolean().default(true),
      reportCardPublished: z.boolean().default(true),
      paymentRecorded: z.boolean().default(true),
      feeDue: z.boolean().default(true),
      homeworkAssigned: z.boolean().default(false),
      announcement: z.boolean().default(true),
    })
    // Parsing an empty object applies each field default; this keeps the
    // default in one place instead of restating all eight values here.
    .default(() => notificationChannelDefaults()),
  /** Do not send automated messages outside these hours (24h, school time). */
  // Must be a real clock time: \d{2}:\d{2} would happily accept "25:99".
  quietHoursStart: z.string().regex(TIME_24H, 'Use a 24-hour time such as 21:00.').default('21:00'),
  quietHoursEnd: z.string().regex(TIME_24H, 'Use a 24-hour time such as 06:30.').default('06:30'),

  /**
   * SMS provider wiring.
   *
   * `provider: 'none'` is the honest default — no provider is connected, so
   * nothing is sent and the outbox reports `unconfigured` rather than
   * pretending. `apiKeyRef` names an environment variable or secret; the
   * credential itself is never stored in the database.
   */
  sms: z
    .object({
      /**
       * Which provider integration to use. A free string rather than a closed
       * enum because the registry (src/lib/sms/provider.ts) is the authority
       * on what is installed — adding an Ethiopian gateway must not require a
       * schema change here. An unrecognised key is reported honestly as
       * "not-implemented" and nothing is sent.
       */
      provider: z.string().max(40).default('none'),
      senderId: z.string().max(32).default(''),
      apiKeyRef: z.string().max(120).default(''),
      endpoint: z.string().max(300).default(''),
      isEnabled: z.boolean().default(false),
    })
    .default({
      provider: 'none',
      senderId: '',
      apiKeyRef: '',
      endpoint: '',
      isEnabled: false,
    }),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export const financeSettingsSchema = z.object({
  currency: z.string().default('ETB'),
  /** Prefix for generated receipt numbers. */
  receiptPrefix: z.string().max(16).default('RCP'),
  /** Allow a payment larger than the outstanding balance (creates credit). */
  allowOverpayment: z.boolean().default(false),
  /** Allow partial payments against an installment. */
  allowPartialPayment: z.boolean().default(true),
  /** Days after the due date before a fee is marked overdue. */
  graceDays: z.number().int().min(0).max(90).default(7),
  /** Send a reminder this many days before a due date. */
  reminderDaysBefore: z.number().int().min(0).max(60).default(5),
  /** Payment methods this school accepts. */
  paymentMethods: z
    .array(z.enum(['cash', 'bank', 'telebirr', 'cbebirr', 'cheque', 'other']))
    .default(['cash', 'bank']),
  /** Automatic sibling discount, as a percentage off the second child onward. */
  siblingDiscountPercent: z.number().min(0).max(100).default(0),
});
export type FinanceSettings = z.infer<typeof financeSettingsSchema>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every settings group, keyed by the value stored in school_settings.key.
 * Adding a group here makes it available everywhere with validation and
 * defaults, with no other wiring.
 */
export const SETTINGS_SCHEMAS = {
  modules: modulesSchema,
  locale: localeSettingsSchema,
  grading: gradingSettingsSchema,
  attendance: attendanceSettingsSchema,
  academic: academicSettingsSchema,
  reportCard: reportCardSettingsSchema,
  notifications: notificationSettingsSchema,
  finance: financeSettingsSchema,
} as const;

export type SettingsKey = keyof typeof SETTINGS_SCHEMAS;

export type SettingsValue<K extends SettingsKey> = z.infer<(typeof SETTINGS_SCHEMAS)[K]>;

export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMAS) as SettingsKey[];

/** Parse a stored value, falling back to schema defaults when absent. */
export function parseSettings<K extends SettingsKey>(key: K, raw: unknown): SettingsValue<K> {
  const schema = SETTINGS_SCHEMAS[key];
  const result = schema.safeParse(raw ?? {});
  if (result.success) return result.data as SettingsValue<K>;

  // A stored value that no longer validates (e.g. after a schema change) must
  // not break the school. But discarding the whole group over one bad field
  // would silently revert unrelated policies — a school that had disabled
  // backdating would find it switched back on. So drop only the offending
  // fields and keep the rest.
  const bad = new Set(
    result.error.issues.map((issue) => String(issue.path[0])).filter((name) => name !== 'undefined'),
  );

  if (bad.size > 0 && raw && typeof raw === 'object') {
    const salvaged: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!bad.has(field)) salvaged[field] = value;
    }
    const retry = schema.safeParse(salvaged);
    if (retry.success) {
      console.warn(
        `[settings] Ignored invalid field(s) in "${key}": ${[...bad].join(', ')}. Defaults used for those.`,
      );
      return retry.data as SettingsValue<K>;
    }
  }

  console.warn(`[settings] Stored value for "${key}" is unusable; falling back to defaults.`);
  const fallback = schema.safeParse({});
  if (fallback.success) return fallback.data as SettingsValue<K>;
  throw new Error(`Settings schema "${key}" has no valid default: ${result.error.message}`);
}

/** Defaults for a settings group. */
export function defaultSettings<K extends SettingsKey>(key: K): SettingsValue<K> {
  return parseSettings(key, {});
}

// ---------------------------------------------------------------------------
// Building patch schemas
// ---------------------------------------------------------------------------

/**
 * Turn a settings group into a schema suitable for a PATCH body, where an
 * absent key means "leave this alone".
 *
 * Zod's own `.optional()` and `.partial()` are not enough here. A field
 * carrying `.default()` still produces that default when the key is missing,
 * so a naive patch schema turns `{ sms: { isEnabled: false } }` into a
 * complete object and wipes the school's provider, sender ID and credential
 * reference — configuration destroyed by pressing a toggle, with no error.
 *
 * This strips the default from every field first (recursing one level into
 * nested objects, which is as deep as the settings groups go) so that an
 * omitted key stays `undefined` and the caller's merge preserves what is
 * stored. Types are still validated: a wrong type is still rejected.
 */
export function patchSchemaFor(schema: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};
  const source = schema.shape as unknown as Record<string, z.ZodTypeAny>;

  for (const key of Object.keys(source)) {
    const undefaulted = stripDefault(source[key]!);

    shape[key] =
      undefaulted instanceof z.ZodObject
        ? patchSchemaFor(undefaulted).optional()
        : undefaulted.optional();
  }

  return z.object(shape);
}

function stripDefault(field: z.ZodTypeAny): z.ZodTypeAny {
  const candidate = field as z.ZodTypeAny & { removeDefault?: () => z.ZodTypeAny };
  return typeof candidate.removeDefault === 'function' ? candidate.removeDefault() : field;
}
