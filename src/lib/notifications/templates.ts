/**
 * Built-in notification wording, in English and Amharic.
 *
 * These are defaults, not hard-coded copy: a school can override any of them
 * per channel in `notification_templates`, and the override wins. They exist so
 * that a school which never opens the template editor still gets correct,
 * translated text rather than a blank or an English-only string.
 *
 * Placeholders use the same {name} syntax as the i18n catalogue.
 */

import type { Database } from '../../db/client.ts';
import { and, eq } from 'drizzle-orm';
import { notificationTemplates } from '../../db/schema/comms.ts';
import type { Locale } from '../i18n/types.ts';
import { interpolate } from '../i18n/index.ts';

export type NotificationChannel = 'inApp' | 'sms';

type TemplateText = {
  titleEn: string;
  titleAm: string;
  bodyEn: string;
  bodyAm: string;
};

/**
 * Defaults keyed by `${type}:${channel}`.
 *
 * SMS wording is deliberately shorter and repeats the school name, because it
 * arrives with no surrounding context and costs money per segment.
 */
export const DEFAULT_TEMPLATES: Record<string, TemplateText> = {
  'attendance.absent:inApp': {
    titleEn: 'Absent today',
    titleAm: 'ዛሬ አልተገኘም',
    bodyEn: '{studentName} was marked absent on {date}.',
    bodyAm: '{studentName} በ{date} እንዳልተገኘ ተመዝግቧል።',
  },
  'attendance.absent:sms': {
    titleEn: 'Absent',
    titleAm: 'አልተገኘም',
    bodyEn: '{schoolName}: {studentName} was absent on {date}.',
    bodyAm: '{schoolName}፦ {studentName} በ{date} አልተገኘም።',
  },
  'attendance.late:inApp': {
    titleEn: 'Arrived late',
    titleAm: 'ዘግይቶ ደርሷል',
    bodyEn: '{studentName} arrived late on {date}.',
    bodyAm: '{studentName} በ{date} ዘግይቶ ደርሷል።',
  },
  'attendance.late:sms': {
    titleEn: 'Late',
    titleAm: 'ዘግይቷል',
    bodyEn: '{schoolName}: {studentName} arrived late on {date}.',
    bodyAm: '{schoolName}፦ {studentName} በ{date} ዘግይቶ ደርሷል።',
  },
  'attendance.risk:inApp': {
    titleEn: 'Attendance needs attention',
    titleAm: 'ተገኝነት ትኩረት ይፈልጋል',
    bodyEn: "{studentName}'s attendance is {percent}%, below the school's {threshold}% expectation.",
    bodyAm: 'የ{studentName} ተገኝነት {percent}% ሲሆን፣ ከትምህርት ቤቱ {threshold}% መጠበቂያ በታች ነው።',
  },
  'attendance.risk:sms': {
    titleEn: 'Attendance',
    titleAm: 'ተገኝነት',
    bodyEn: '{schoolName}: {studentName} attendance is {percent}%. Please contact the school.',
    bodyAm: '{schoolName}፦ የ{studentName} ተገኝነት {percent}% ነው። እባክዎ ትምህርት ቤቱን ያነጋግሩ።',
  },
  'reportCard.published:inApp': {
    titleEn: 'Report card available',
    titleAm: 'የውጤት ካርድ ተዘጋጅቷል',
    bodyEn: "{studentName}'s report card for {termName} has been published.",
    bodyAm: 'የ{studentName} የ{termName} የውጤት ካርድ ታትሟል።',
  },
  'reportCard.published:sms': {
    titleEn: 'Report card',
    titleAm: 'የውጤት ካርድ',
    bodyEn: '{schoolName}: {studentName} report card for {termName} is ready.',
    bodyAm: '{schoolName}፦ የ{studentName} የ{termName} የውጤት ካርድ ዝግጁ ነው።',
  },
  'grade.published:inApp': {
    titleEn: 'New results available',
    titleAm: 'አዲስ ውጤት ተለጥፏል',
    bodyEn: 'New results have been published for {studentName}.',
    bodyAm: 'ለ{studentName} አዲስ ውጤት ታትሟል።',
  },
  'grade.published:sms': {
    titleEn: 'Results',
    titleAm: 'ውጤቶች',
    bodyEn: '{schoolName}: new results are available for {studentName}.',
    bodyAm: '{schoolName}፦ ለ{studentName} አዲስ ውጤት ተዘጋጅቷል።',
  },
  'announcement:inApp': {
    titleEn: '{title}',
    titleAm: '{title}',
    bodyEn: '{preview}',
    bodyAm: '{preview}',
  },
  'announcement:sms': {
    titleEn: '{title}',
    titleAm: '{title}',
    bodyEn: '{schoolName}: {title} — {preview}',
    bodyAm: '{schoolName}፦ {title} — {preview}',
  },
  'message:inApp': {
    titleEn: 'New message from {senderName}',
    titleAm: 'ከ{senderName} አዲስ መልእክት',
    bodyEn: '{preview}',
    bodyAm: '{preview}',
  },
  'message:sms': {
    titleEn: 'New message',
    titleAm: 'አዲስ መልእክት',
    bodyEn: '{schoolName}: new message from {senderName}.',
    bodyAm: '{schoolName}፦ ከ{senderName} አዲስ መልእክት።',
  },
  // Seams for Groups 7 and 8. Wording is ready so those groups only have to
  // emit their event.
  'homework.assigned:inApp': {
    titleEn: 'New homework',
    titleAm: 'አዲስ የቤት ሥራ',
    bodyEn: 'New homework has been set for {studentName}, due {dueDate}.',
    bodyAm: 'ለ{studentName} አዲስ የቤት ሥራ ተሰጥቷል፣ የመጨረሻ ቀን {dueDate}።',
  },
  'homework.assigned:sms': {
    titleEn: 'Homework',
    titleAm: 'የቤት ሥራ',
    bodyEn: '{schoolName}: new homework for {studentName}, due {dueDate}.',
    bodyAm: '{schoolName}፦ ለ{studentName} አዲስ የቤት ሥራ፣ የመጨረሻ ቀን {dueDate}።',
  },
  'fee.due:inApp': {
    titleEn: 'Fee due',
    titleAm: 'ክፍያ ይጠበቃል',
    bodyEn: 'A payment of {amount} for {studentName} is due on {dueDate}.',
    bodyAm: 'ለ{studentName} የ{amount} ክፍያ በ{dueDate} መከፈል አለበት።',
  },
  'fee.due:sms': {
    titleEn: 'Fee due',
    titleAm: 'ክፍያ ይጠበቃል',
    bodyEn: '{schoolName}: {amount} for {studentName} is due {dueDate}.',
    bodyAm: '{schoolName}፦ ለ{studentName} {amount} በ{dueDate} ይከፈላል።',
  },
  'payment.recorded:inApp': {
    titleEn: 'Payment received',
    titleAm: 'ክፍያ ተቀብለናል',
    bodyEn: 'We received {amount} for {studentName}. Receipt {receiptNumber}.',
    bodyAm: 'ለ{studentName} {amount} ተቀብለናል። ደረሰኝ {receiptNumber}።',
  },
  'payment.recorded:sms': {
    titleEn: 'Payment received',
    titleAm: 'ክፍያ ተቀብለናል',
    bodyEn: '{schoolName}: received {amount} for {studentName}. Receipt {receiptNumber}.',
    bodyAm: '{schoolName}፦ ለ{studentName} {amount} ተቀብለናል። ደረሰኝ {receiptNumber}።',
  },
};

export type RenderedNotification = { title: string; body: string };

/**
 * Render a notification in the recipient's language.
 *
 * A school override replaces the default entirely. If the override has no
 * Amharic text the English is used rather than showing a blank — a missing
 * translation should degrade to readable, not to nothing.
 */
export async function renderTemplate(
  db: Database,
  schoolId: string,
  type: string,
  channel: NotificationChannel,
  locale: Locale,
  values: Record<string, string | number>,
): Promise<RenderedNotification> {
  const [override] = await db
    .select({
      titleEn: notificationTemplates.titleEn,
      titleAm: notificationTemplates.titleAm,
      bodyEn: notificationTemplates.bodyEn,
      bodyAm: notificationTemplates.bodyAm,
    })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.schoolId, schoolId),
        eq(notificationTemplates.type, type),
        eq(notificationTemplates.channel, channel),
        eq(notificationTemplates.isActive, true),
      ),
    )
    .limit(1);

  const fallback = DEFAULT_TEMPLATES[`${type}:${channel}`] ??
    DEFAULT_TEMPLATES[`${type}:inApp`] ?? {
      titleEn: type,
      titleAm: type,
      bodyEn: '',
      bodyAm: '',
    };

  const source = override
    ? {
        titleEn: override.titleEn,
        titleAm: override.titleAm || override.titleEn,
        bodyEn: override.bodyEn,
        bodyAm: override.bodyAm || override.bodyEn,
      }
    : fallback;

  const title = locale === 'am' ? source.titleAm || source.titleEn : source.titleEn;
  const body = locale === 'am' ? source.bodyAm || source.bodyEn : source.bodyEn;

  return {
    title: interpolate(title, values).slice(0, 200),
    body: interpolate(body, values),
  };
}

/** Every template a school can customise, with its current effective text. */
export function listDefaultTemplates(): {
  type: string;
  channel: NotificationChannel;
  titleEn: string;
  titleAm: string;
  bodyEn: string;
  bodyAm: string;
}[] {
  return Object.entries(DEFAULT_TEMPLATES).map(([key, text]) => {
    const [type, channel] = key.split(':') as [string, NotificationChannel];
    return { type, channel, ...text };
  });
}
