/**
 * Display formatting helpers shared by server and client components.
 */

import { formatDate, type CalendarSystem, type DateLocale } from './calendar/ethiopian.ts';

/**
 * Compose an Ethiopian name for display.
 *
 * Names are never parsed or split — they are stored as separate fields and
 * joined here. `short` gives "Abebe Kebede" (given + father), which is how
 * students are normally addressed; the full form adds the grandfather's name
 * and is used on official documents.
 */
export function personName(
  person: {
    givenName: string;
    fatherName?: string | null;
    grandfatherName?: string | null;
    givenNameAm?: string | null;
    fatherNameAm?: string | null;
    grandfatherNameAm?: string | null;
  },
  options: { locale?: DateLocale; full?: boolean } = {},
): string {
  const { locale = 'en', full = false } = options;

  if (locale === 'am' && person.givenNameAm) {
    const parts = [person.givenNameAm, person.fatherNameAm];
    if (full) parts.push(person.grandfatherNameAm);
    return parts.filter(Boolean).join(' ');
  }

  const parts: (string | null | undefined)[] = [person.givenName, person.fatherName];
  if (full) parts.push(person.grandfatherName);
  return parts.filter(Boolean).join(' ');
}

/** Initials for an avatar placeholder. */
export function initials(person: { givenName: string; fatherName?: string | null }): string {
  const a = person.givenName?.[0] ?? '';
  const b = person.fatherName?.[0] ?? '';
  return (a + b).toUpperCase();
}

export function formatSchoolDate(
  iso: string | null | undefined,
  calendar: CalendarSystem = 'both',
  locale: DateLocale = 'en',
): string {
  if (!iso) return '—';
  try {
    return formatDate(iso, { calendar, locale });
  } catch {
    return iso;
  }
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

/** Pick a colour treatment for an attendance or performance percentage. */
export function statusTone(
  value: number | null,
  thresholds: { good: number; warn: number } = { good: 90, warn: 75 },
): 'good' | 'warn' | 'bad' | 'neutral' {
  if (value === null) return 'neutral';
  if (value >= thresholds.good) return 'good';
  if (value >= thresholds.warn) return 'warn';
  return 'bad';
}

export const TONE_CLASSES: Record<'good' | 'warn' | 'bad' | 'neutral', string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
  neutral: 'bg-ink-100 text-ink-600 border-ink-200',
};
