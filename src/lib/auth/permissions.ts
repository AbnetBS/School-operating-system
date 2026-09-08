/**
 * Permission catalogue.
 *
 * Permissions are fine-grained strings in `resource.action` form. Roles are
 * per-school bundles of these, editable by the school administrator, so a
 * school can decide that its registrar may edit grades while another decides
 * the opposite — without a code change.
 *
 * Two principles enforced here:
 *   1. Least privilege. A finance officer has no grade permissions at all;
 *      a teacher has no school-wide finance permissions.
 *   2. Server-side truth. This catalogue is consulted in API handlers. Hiding
 *      a button in the UI is presentation, never protection.
 */

export const PERMISSIONS = {
  // School configuration
  'school.view': 'View school profile and settings',
  'school.manage': 'Edit school profile, settings and modules',
  'school.billing': 'Manage subscription and billing',

  // Users, roles
  'user.view': 'View user accounts',
  'user.manage': 'Create, edit and deactivate user accounts',
  'role.view': 'View roles and permissions',
  'role.manage': 'Create and edit roles and their permissions',

  // Academic structure
  'academic.view': 'View academic years, terms, grades, sections and subjects',
  'academic.manage': 'Create and edit academic years, terms, grades, sections and subjects',
  'academic.assignTeacher': 'Assign teachers to sections and subjects',

  // Students
  'student.view': 'View student list and profiles',
  'student.create': 'Register new students',
  'student.edit': 'Edit student information',
  'student.delete': 'Archive or delete student records',
  'student.viewSensitive': 'View medical and other sensitive student information',
  'student.import': 'Bulk import students from Excel or CSV',
  'student.export': 'Export student data',

  // Guardians
  'guardian.view': 'View parent and guardian records',
  'guardian.manage': 'Create and edit parent and guardian records',

  // Staff
  'staff.view': 'View staff records',
  'staff.manage': 'Create and edit staff records',

  // Attendance
  'attendance.view': 'View attendance records and reports',
  'attendance.take': 'Record attendance for assigned classes',
  'attendance.editAny': 'Edit attendance for any class, including past dates',
  'attendance.report': 'Run attendance reports and analytics',

  // Gradebook
  'grade.view': 'View marks and results',
  'grade.enter': 'Enter and edit marks for assigned subjects',
  'grade.submit': 'Submit marks for review',
  'grade.review': 'Review and approve submitted marks',
  'grade.lock': 'Lock and unlock marks',
  'grade.overrideLocked': 'Change marks after they have been locked',
  'grade.configure': 'Configure assessment types, weights and grading scales',

  // Report cards
  'reportCard.view': 'View report cards',
  'reportCard.generate': 'Generate report cards',
  'reportCard.approve': 'Approve report cards for publication',
  'reportCard.publish': 'Publish report cards to parents and students',
  'reportCard.configure': 'Configure report card layout and content',

  // Finance
  'fee.view': 'View fee structures and student balances',
  'fee.manage': 'Create and edit fee structures, discounts and scholarships',
  'payment.view': 'View payment records',
  'payment.record': 'Record payments and issue receipts',
  'payment.void': 'Void or reverse a payment',
  'finance.report': 'View finance dashboards and reports',

  // Communication
  'announcement.view': 'View announcements',
  'announcement.create': 'Create announcements',
  'message.send': 'Send direct messages',
  'sms.send': 'Send SMS messages',
  'sms.configure': 'Configure SMS templates and provider settings',

  // Documents
  'document.view': 'View documents',
  'document.upload': 'Upload documents',
  'document.issue': 'Issue official documents such as transcripts and certificates',

  // Analytics and audit
  'analytics.view': 'View school analytics dashboards',
  'audit.view': 'View the audit log',
  'report.build': 'Build and run custom reports',

  // Portals (relationship-scoped; see scope resolution)
  'portal.student': 'Access the student portal for own record',
  'portal.parent': 'Access the parent portal for own children',
} as const;

/**
 * RESTRICTIONS are the inverse of permissions: holding one NARROWS what a user
 * may see, rather than widening it.
 *
 * They are kept in a separate namespace deliberately. When they lived in the
 * permission list, "grant this role everything" also granted the restriction,
 * so a school owner was silently limited to sections they personally taught —
 * which for an owner is none, making the student list appear empty.
 *
 * A restriction must always be granted explicitly, never by a bulk grant.
 */
export const RESTRICTIONS = {
  'restrict.ownSectionsOnly':
    'Limit this role to students, attendance and marks in their own assigned sections',
} as const;

export type Restriction = keyof typeof RESTRICTIONS;

export type Permission = keyof typeof PERMISSIONS | Restriction;

/**
 * Every grantable permission. Restrictions are excluded by design, so
 * `ALL_PERMISSIONS` can safely be used to build an administrator role.
 */
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[];

export const ALL_RESTRICTIONS = Object.keys(RESTRICTIONS) as Restriction[];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS || value in RESTRICTIONS;
}

export function isRestriction(value: string): value is Restriction {
  return value in RESTRICTIONS;
}

/** Human-readable label for any permission or restriction key. */
export function permissionLabel(key: string): string {
  return (
    (PERMISSIONS as Record<string, string>)[key] ??
    (RESTRICTIONS as Record<string, string>)[key] ??
    key
  );
}

/**
 * Built-in role templates used when a school is created. A school may edit
 * these freely afterwards — they are starting points, not fixed policy.
 *
 * Note what is deliberately absent:
 *   - `teacher` has no fee/payment permissions.
 *   - `finance` has no grade permissions.
 *   - `parent`/`student` have only their portal permission; what they can see
 *     within it is decided by relationship scoping, not by role.
 */
export const ROLE_TEMPLATES: Record<
  string,
  { name: string; nameAm: string; description: string; permissions: Permission[] }
> = {
  owner: {
    name: 'School Owner',
    nameAm: 'የትምህርት ቤት ባለቤት',
    description: 'Full access to everything in the school, including billing.',
    permissions: [...ALL_PERMISSIONS],
  },

  director: {
    name: 'Director',
    nameAm: 'ዳይሬክተር',
    description: 'Full operational access; no billing.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'school.billing'),
  },

  principal: {
    name: 'Principal',
    nameAm: 'ርዕሰ መምህር',
    description: 'Oversees academics, staff and students; approves results.',
    permissions: [
      'school.view',
      'user.view',
      'role.view',
      'academic.view',
      'academic.manage',
      'academic.assignTeacher',
      'student.view',
      'student.create',
      'student.edit',
      'student.viewSensitive',
      'student.export',
      'guardian.view',
      'guardian.manage',
      'staff.view',
      'staff.manage',
      'attendance.view',
      'attendance.editAny',
      'attendance.report',
      'grade.view',
      'grade.review',
      'grade.lock',
      'grade.overrideLocked',
      'grade.configure',
      'reportCard.view',
      'reportCard.generate',
      'reportCard.approve',
      'reportCard.publish',
      'reportCard.configure',
      'fee.view',
      'finance.report',
      'announcement.view',
      'announcement.create',
      'message.send',
      'sms.send',
      'document.view',
      'document.issue',
      'analytics.view',
      'audit.view',
      'report.build',
    ],
  },

  vice_principal: {
    name: 'Vice Principal',
    nameAm: 'ምክትል ርዕሰ መምህር',
    description: 'Supports the principal in academic and student affairs.',
    permissions: [
      'school.view',
      'academic.view',
      'student.view',
      'student.edit',
      'guardian.view',
      'staff.view',
      'attendance.view',
      'attendance.editAny',
      'attendance.report',
      'grade.view',
      'grade.review',
      'reportCard.view',
      'reportCard.generate',
      'announcement.view',
      'announcement.create',
      'message.send',
      'analytics.view',
      'report.build',
    ],
  },

  registrar: {
    name: 'Registrar',
    nameAm: 'መዝጋቢ',
    description: 'Owns student records, enrolment and official documents.',
    permissions: [
      'school.view',
      'academic.view',
      'academic.manage',
      'student.view',
      'student.create',
      'student.edit',
      'student.delete',
      'student.viewSensitive',
      'student.import',
      'student.export',
      'guardian.view',
      'guardian.manage',
      'attendance.view',
      'attendance.report',
      'grade.view',
      'reportCard.view',
      'reportCard.generate',
      'document.view',
      'document.upload',
      'document.issue',
      'announcement.view',
      'report.build',
    ],
  },

  academic_coordinator: {
    name: 'Academic Coordinator',
    nameAm: 'የትምህርት አስተባባሪ',
    description: 'Coordinates teaching, reviews marks before the principal.',
    permissions: [
      'school.view',
      'academic.view',
      'academic.manage',
      'academic.assignTeacher',
      'student.view',
      'attendance.view',
      'attendance.report',
      'grade.view',
      'grade.review',
      'grade.configure',
      'reportCard.view',
      'reportCard.generate',
      'announcement.view',
      'announcement.create',
      'message.send',
      'analytics.view',
      'report.build',
    ],
  },

  teacher: {
    name: 'Teacher',
    nameAm: 'መምህር',
    description:
      'Teaches assigned subjects. Sees only their own classes. No access to school finances.',
    permissions: [
      'academic.view',
      'student.view',
      'restrict.ownSectionsOnly',
      'attendance.view',
      'attendance.take',
      'grade.view',
      'grade.enter',
      'grade.submit',
      'reportCard.view',
      'announcement.view',
      'message.send',
      'document.view',
    ],
  },

  class_teacher: {
    name: 'Class Teacher',
    nameAm: 'የክፍል መምህር',
    description: 'A teacher additionally responsible for a homeroom section.',
    permissions: [
      'academic.view',
      'student.view',
      'restrict.ownSectionsOnly',
      'student.edit',
      'guardian.view',
      'attendance.view',
      'attendance.take',
      'attendance.report',
      'grade.view',
      'grade.enter',
      'grade.submit',
      'reportCard.view',
      'reportCard.generate',
      'announcement.view',
      'message.send',
      'document.view',
    ],
  },

  finance_officer: {
    name: 'Finance Officer',
    nameAm: 'የፋይናንስ ኃላፊ',
    description: 'Manages fees and payments. Cannot change academic grades.',
    permissions: [
      'school.view',
      'academic.view',
      'student.view',
      'guardian.view',
      'fee.view',
      'fee.manage',
      'payment.view',
      'payment.record',
      'payment.void',
      'finance.report',
      'announcement.view',
      'message.send',
      'sms.send',
      'document.view',
      'report.build',
    ],
  },

  accountant: {
    name: 'Accountant',
    nameAm: 'ሒሳብ ሹም',
    description: 'Records payments and reconciles accounts.',
    permissions: [
      'school.view',
      'student.view',
      'fee.view',
      'payment.view',
      'payment.record',
      'finance.report',
      'document.view',
    ],
  },

  hr_officer: {
    name: 'HR Officer',
    nameAm: 'የሰው ኃይል ኃላፊ',
    description: 'Manages staff records.',
    permissions: [
      'school.view',
      'user.view',
      'user.manage',
      'staff.view',
      'staff.manage',
      'document.view',
      'document.upload',
      'announcement.view',
    ],
  },

  librarian: {
    name: 'Librarian',
    nameAm: 'ቤተ መጻሕፍት ኃላፊ',
    description: 'Manages the library.',
    permissions: ['school.view', 'student.view', 'announcement.view', 'document.view'],
  },

  receptionist: {
    name: 'Receptionist',
    nameAm: 'የፊት ለፊት አገልግሎት',
    description: 'Handles front-desk enquiries. Limited, read-mostly access.',
    permissions: [
      'school.view',
      'student.view',
      'guardian.view',
      'attendance.view',
      'announcement.view',
      'message.send',
    ],
  },

  parent: {
    name: 'Parent',
    nameAm: 'ወላጅ',
    description: 'Sees only their own children.',
    permissions: ['portal.parent'],
  },

  student: {
    name: 'Student',
    nameAm: 'ተማሪ',
    description: 'Sees only their own record.',
    permissions: ['portal.student'],
  },
};

export const ROLE_TEMPLATE_KEYS = Object.keys(ROLE_TEMPLATES);
