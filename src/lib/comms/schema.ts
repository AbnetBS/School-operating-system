/**
 * Validation for communication.
 *
 * The same schemas run in the browser and on the server. The server never
 * trusts the client's copy — every route re-parses — but sharing them means a
 * teacher sees "this message is empty" before a round trip, and the two can
 * never disagree about what is valid.
 */

import { z } from 'zod';
import { ANNOUNCEMENT_AUDIENCES, NOTIFICATION_TYPES } from '../../db/schema/comms.ts';

/** Bodies are capped so one paste cannot fill a phone screen or an SMS bill. */
const MAX_BODY = 5000;
const MAX_MESSAGE = 2000;

export const announcementAudienceSchema = z.enum(ANNOUNCEMENT_AUDIENCES);

export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1, 'A title is required').max(200),
    titleAm: z.string().trim().max(200).optional().or(z.literal('')),
    body: z.string().trim().min(1, 'A message is required').max(MAX_BODY),
    bodyAm: z.string().trim().max(MAX_BODY).optional().or(z.literal('')),

    audience: announcementAudienceSchema.default('everyone'),
    sectionIds: z.array(z.string().min(1)).max(200).default([]),
    gradeLevelIds: z.array(z.string().min(1)).max(50).default([]),

    isPinned: z.boolean().default(false),
    /** Publish immediately, or keep as a draft the author can edit. */
    publish: z.boolean().default(true),
    expiresAt: z.string().trim().optional().or(z.literal('')),
    sendSms: z.boolean().default(false),
  })
  .refine((a) => a.audience !== 'section' || a.sectionIds.length > 0, {
    message: 'Choose at least one class',
    path: ['sectionIds'],
  })
  .refine((a) => a.audience !== 'grade' || a.gradeLevelIds.length > 0, {
    message: 'Choose at least one grade',
    path: ['gradeLevelIds'],
  });
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const updateAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  titleAm: z.string().trim().max(200).optional().or(z.literal('')),
  body: z.string().trim().min(1).max(MAX_BODY).optional(),
  bodyAm: z.string().trim().max(MAX_BODY).optional().or(z.literal('')),
  isPinned: z.boolean().optional(),
  publish: z.boolean().optional(),
});
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

/**
 * Starting a conversation.
 *
 * `recipientUserIds` names people, not roles. The service checks every one of
 * them against the sender's real relationships before the thread exists — a
 * crafted id here buys nothing.
 */
export const createThreadSchema = z.object({
  subject: z.string().trim().min(1, 'A subject is required').max(200),
  body: z.string().trim().min(1, 'A message is required').max(MAX_MESSAGE),
  recipientUserIds: z
    .array(z.string().min(1))
    .min(1, 'Choose at least one recipient')
    .max(50, 'Too many recipients for one conversation'),
  /** The pupil the conversation concerns, when there is one. */
  studentId: z.string().min(1).optional().or(z.literal('')),
});
export type CreateThreadInput = z.infer<typeof createThreadSchema>;

export const sendMessageSchema = z.object({
  threadId: z.string().min(1),
  body: z.string().trim().min(1, 'A message is required').max(MAX_MESSAGE),
  /**
   * Optional client-supplied key. A retried submission carrying the same key
   * is answered with the original message instead of creating a duplicate.
   */
  clientKey: z.string().trim().max(100).optional().or(z.literal('')),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const markReadSchema = z.object({
  /** Omit to mark everything read. */
  notificationIds: z.array(z.string().min(1)).max(500).optional(),
});

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const notificationTemplateSchema = z.object({
  type: notificationTypeSchema,
  channel: z.enum(['inApp', 'sms']).default('inApp'),
  titleEn: z.string().trim().min(1, 'An English title is required').max(200),
  titleAm: z.string().trim().max(200).optional().or(z.literal('')),
  bodyEn: z.string().trim().min(1, 'English text is required').max(1000),
  bodyAm: z.string().trim().max(1000).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});
export type NotificationTemplateInput = z.infer<typeof notificationTemplateSchema>;

/**
 * SMS provider configuration.
 *
 * Stored per school. `provider: 'none'` is the honest default: no provider is
 * connected, so nothing is sent and the outbox says so.
 */
export const smsConfigSchema = z.object({
  /** Validated against the provider registry, not a fixed list. */
  provider: z.string().trim().max(40).default('none'),
  senderId: z.string().trim().max(32).optional().or(z.literal('')),
  apiKeyRef: z.string().trim().max(120).optional().or(z.literal('')),
  endpoint: z.string().trim().max(300).optional().or(z.literal('')),
  isEnabled: z.boolean().default(false),
});
export type SmsConfigInput = z.infer<typeof smsConfigSchema>;
