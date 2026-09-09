/**
 * Communication schema: announcements, messages, notifications, SMS outbox.
 *
 * DESIGN NOTES
 * ------------
 * AUDIENCE IS A RULE, NOT A COPIED LIST. An announcement stores who it is for
 * (`audience`, plus section/grade filters) rather than a materialised list of
 * recipients. Copying recipients at publish time would freeze the audience —
 * a pupil who enrols tomorrow would never see today's notice — and would turn
 * one whole-school announcement into hundreds of rows. The audience is
 * resolved when it is read, so it is always current.
 *
 * NOTIFICATIONS ARE PER-RECIPIENT; ANNOUNCEMENTS ARE NOT. A notification is a
 * personal fact ("your child was absent today") and needs its own read state
 * per person. An announcement is a public fact and needs one row for the
 * school, with a separate small table recording who has opened it.
 *
 * MEMBERSHIP, NOT ROLE, GRANTS ACCESS TO A THREAD. `message_participants` is
 * the authority on who may read a conversation. Being a teacher does not admit
 * you to another teacher's thread; being named as a participant does. Who may
 * *start* a thread is a different question, answered from the existing
 * teaching and guardianship relationships.
 *
 * SMS STATUS IS HONEST. `unconfigured` is a real status, distinct from
 * `failed`. A school with no provider set up must never see "sent". Nothing in
 * this module simulates delivery.
 */

import {
  pgTable,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { schools, users, sections, gradeLevels } from './core.ts';
import { students } from './people.ts';

/** Shared column builders, matching the conventions in core.ts. */
const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/**
 * Who an announcement is aimed at.
 *
 * `section` and `grade` narrow by the accompanying id arrays. The rest are
 * whole-population audiences. A school that wants "all parents in Grade 5"
 * uses audience `parents` with `gradeLevelIds: [grade5]`.
 */
export const ANNOUNCEMENT_AUDIENCES = [
  'everyone',
  'staff',
  'parents',
  'students',
  'section',
  'grade',
] as const;

export const announcements = pgTable(
  'announcements',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),

    title: varchar('title', { length: 200 }).notNull(),
    titleAm: varchar('title_am', { length: 200 }),
    body: text('body').notNull(),
    bodyAm: text('body_am'),

    audience: varchar('audience', { length: 24 }).notNull().default('everyone'),
    /** Narrowing filters, used when audience is 'section' or 'grade'. */
    sectionIds: jsonb('section_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    gradeLevelIds: jsonb('grade_level_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    /** Pinned notices sort above the rest regardless of date. */
    isPinned: boolean('is_pinned').notNull().default(false),
    /** Draft announcements are invisible to everyone but their author. */
    isPublished: boolean('is_published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Optional automatic expiry; past this the notice stops being shown. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** Whether the school also wanted this pushed out over SMS. */
    sendSms: boolean('send_sms').notNull().default(false),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('announcements_school_idx').on(t.schoolId, t.isPublished, t.publishedAt),
    index('announcements_audience_idx').on(t.schoolId, t.audience),
  ],
);

/**
 * Who has opened an announcement.
 *
 * Written on first read rather than pre-created for every possible reader,
 * so an unread whole-school notice costs nothing.
 */
export const announcementReads = pgTable(
  'announcement_reads',
  {
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    announcementId: text('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.announcementId, t.userId] }),
    index('announcement_reads_user_idx').on(t.schoolId, t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

/** What kind of conversation this is, for display and filtering. */
export const THREAD_KINDS = ['direct', 'group'] as const;

export const messageThreads = pgTable(
  'message_threads',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),

    subject: varchar('subject', { length: 200 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull().default('direct'),

    /**
     * The pupil this conversation is about, when there is one. A parent–teacher
     * thread is nearly always about a specific child, and recording it lets the
     * thread be shown on that child's record later.
     */
    studentId: text('student_id').references(() => students.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalised for cheap inbox ordering without a join to messages. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('message_threads_school_idx').on(t.schoolId, t.lastMessageAt),
    index('message_threads_student_idx').on(t.schoolId, t.studentId),
  ],
);

/**
 * Thread membership.
 *
 * This table — not a role — decides who may read a conversation.
 * `lastReadAt` gives each participant their own unread count.
 */
export const messageParticipants = pgTable(
  'message_participants',
  {
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    /** A participant may leave a conversation without deleting its history. */
    leftAt: timestamp('left_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    index('message_participants_user_idx').on(t.schoolId, t.userId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').references(() => users.id, { onDelete: 'set null' }),

    body: text('body').notNull(),
    /** Set when a sender retracts a message; the row stays for the audit trail. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('messages_thread_idx').on(t.schoolId, t.threadId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// In-app notifications
// ---------------------------------------------------------------------------

/**
 * Notification categories.
 *
 * Kept as a small closed list so the UI can group and icon them, and so a
 * school's notification preferences can switch whole categories on and off.
 */
export const NOTIFICATION_TYPES = [
  'attendance.absent',
  'attendance.late',
  'attendance.risk',
  'grade.published',
  'reportCard.published',
  'homework.assigned',
  'fee.due',
  'payment.recorded',
  'announcement',
  'message',
] as const;

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    /** The person being told. Always a real user account. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    type: varchar('type', { length: 40 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),

    /** Where clicking it should go, e.g. /portal/parent?studentId=… */
    linkPath: varchar('link_path', { length: 300 }),
    /** The pupil this concerns, when relevant — lets a parent filter by child. */
    studentId: text('student_id').references(() => students.id, { onDelete: 'cascade' }),

    /**
     * Identity of the underlying fact, e.g. "absent:{studentId}:{date}".
     * A partial unique index on this column makes redelivery idempotent: a
     * retried event produces one notification, not a duplicate.
     */
    dedupeKey: varchar('dedupe_key', { length: 200 }),

    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_idx').on(t.schoolId, t.userId, t.readAt, t.createdAt),
    uniqueIndex('notifications_dedupe_uq')
      .on(t.schoolId, t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// SMS outbox
// ---------------------------------------------------------------------------

/**
 * Delivery state of an SMS.
 *
 * `unconfigured` is deliberately distinct from `failed`: it means the school
 * has no provider connected, so nothing was attempted and nothing will be
 * until one is. Reporting that as "sent" would be a lie, and reporting it as
 * "failed" would send staff hunting for a fault that does not exist.
 */
export const SMS_STATUSES = ['queued', 'sent', 'failed', 'unconfigured', 'cancelled'] as const;

export const smsMessages = pgTable(
  'sms_messages',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),

    /** Stored as given; normalisation happens before insert. */
    toPhone: varchar('to_phone', { length: 32 }).notNull(),
    body: text('body').notNull(),

    status: varchar('status', { length: 16 }).notNull().default('queued'),
    /** Which provider handled it, once one does. */
    provider: varchar('provider', { length: 40 }),
    /** The provider's own id, for reconciliation against their dashboard. */
    providerRef: varchar('provider_ref', { length: 120 }),
    error: text('error'),

    /** What caused this message, for tracing and for the outbox UI. */
    relatedType: varchar('related_type', { length: 40 }),
    relatedId: text('related_id'),
    recipientUserId: text('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
    studentId: text('student_id').references(() => students.id, { onDelete: 'set null' }),

    attempts: text('attempts').notNull().default('0'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('sms_messages_school_idx').on(t.schoolId, t.status, t.createdAt),
    index('sms_messages_related_idx').on(t.schoolId, t.relatedType, t.relatedId),
  ],
);

// ---------------------------------------------------------------------------
// Notification templates
// ---------------------------------------------------------------------------

/**
 * Editable message templates, per school and per notification type.
 *
 * The wording of "your child was absent" is a school's own voice, and must be
 * changeable without a deployment — and available in Amharic. When no row
 * exists the built-in default in src/lib/notifications/templates.ts is used,
 * so a school that never touches this still gets sensible text.
 */
export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: id(),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),

    /** One of NOTIFICATION_TYPES. */
    type: varchar('type', { length: 40 }).notNull(),
    /** 'inApp' | 'sms' — the same event reads differently in each channel. */
    channel: varchar('channel', { length: 16 }).notNull().default('inApp'),

    titleEn: varchar('title_en', { length: 200 }).notNull(),
    titleAm: varchar('title_am', { length: 200 }),
    bodyEn: text('body_en').notNull(),
    bodyAm: text('body_am'),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notification_templates_uq').on(t.schoolId, t.type, t.channel),
  ],
);
