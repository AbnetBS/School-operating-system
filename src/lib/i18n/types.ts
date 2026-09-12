/**
 * Localization types.
 *
 * The architecture supports adding languages (e.g. Afaan Oromo, Tigrinya)
 * without touching application code: add a locale code here and supply a
 * message catalogue. Every user-facing string must come from a catalogue —
 * never hard-code display text in components.
 */

export const LOCALES = ['en', 'am'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_NAMES: Record<Locale, { native: string; english: string }> = {
  en: { native: 'English', english: 'English' },
  am: { native: 'አማርኛ', english: 'Amharic' },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** A catalogue is a flat map of dotted keys to translated strings. */
export type Messages = Record<string, string>;
