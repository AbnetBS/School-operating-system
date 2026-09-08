import { DEFAULT_LOCALE, isLocale, type Locale, type Messages } from './types.ts';
import en from './messages/en.ts';
import am from './messages/am.ts';

export * from './types.ts';

const CATALOGUES: Record<Locale, Messages> = { en, am };

export function getMessages(locale: Locale): Messages {
  return CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
}

export type TranslateValues = Record<string, string | number>;

/**
 * Substitute {placeholders} in a message template.
 * Unknown placeholders are left intact so the gap is visible rather than
 * silently rendering "undefined" to a parent.
 */
export function interpolate(template: string, values?: TranslateValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export type Translator = (key: string, values?: TranslateValues) => string;

/**
 * Build a translator for a locale.
 *
 * Resolution order: requested locale → default locale → the key itself.
 * Returning the key (rather than throwing or rendering blank) means a missing
 * translation degrades to something diagnosable instead of breaking the page.
 */
export function createTranslator(locale: Locale): Translator {
  const primary = getMessages(locale);
  const fallback = getMessages(DEFAULT_LOCALE);
  return (key, values) => {
    const template = primary[key] ?? fallback[key] ?? key;
    return interpolate(template, values);
  };
}

/**
 * Resolve the effective locale from a user preference, a school default and an
 * Accept-Language header, in that order of precedence.
 */
export function resolveLocale(
  userPreference?: string | null,
  schoolDefault?: string | null,
  acceptLanguage?: string | null,
): Locale {
  if (isLocale(userPreference)) return userPreference;
  if (isLocale(schoolDefault)) return schoolDefault;
  if (acceptLanguage) {
    for (const part of acceptLanguage.split(',')) {
      const tag = part.split(';')[0]!.trim().toLowerCase();
      const base = tag.split('-')[0]!;
      if (isLocale(base)) return base;
    }
  }
  return DEFAULT_LOCALE;
}
