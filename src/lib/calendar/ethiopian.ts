/**
 * Ethiopian Calendar (Ge'ez / Amete Mihret) ⇄ Gregorian conversion.
 *
 * The Ethiopian calendar has 13 months: 12 months of 30 days, plus Pagume
 * (ጳጉሜን) of 5 days, or 6 days in a leap year. The year begins on Meskerem 1,
 * which falls on 11 September in the Gregorian calendar (12 September in the
 * year preceding a Gregorian leap year).
 *
 * Conversion is done via the Julian Day Number (JDN), which is exact integer
 * arithmetic — no floating point, no timezone involvement.
 *
 * This module is intentionally dependency-free and pure so it can be used on
 * both the server and the client, and unit-tested in isolation.
 */

/** JDN of Ethiopian epoch 1 Meskerem 1 (Amete Mihret). */
const ETHIOPIAN_EPOCH_JDN = 1723856;

export type EthiopianDate = {
  /** Ethiopian year, e.g. 2018 */
  year: number;
  /** 1–13, where 13 is Pagume (ጳጉሜን) */
  month: number;
  /** 1–30 (1–5 or 1–6 for Pagume) */
  day: number;
};

export type GregorianDate = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
};

/** Ethiopian month names. Index 0 is unused so months are 1-indexed. */
export const ETHIOPIAN_MONTHS_AM = [
  '',
  'መስከረም',
  'ጥቅምት',
  'ኅዳር',
  'ታኅሣሥ',
  'ጥር',
  'የካቲት',
  'መጋቢት',
  'ሚያዝያ',
  'ግንቦት',
  'ሰኔ',
  'ሐምሌ',
  'ነሐሴ',
  'ጳጉሜን',
] as const;

export const ETHIOPIAN_MONTHS_EN = [
  '',
  'Meskerem',
  'Tikimt',
  'Hidar',
  'Tahsas',
  'Tir',
  'Yekatit',
  'Megabit',
  'Miyazia',
  'Ginbot',
  'Sene',
  'Hamle',
  'Nehase',
  'Pagume',
] as const;

/** Ethiopian weekday names, index 0 = Sunday, matching JS getDay(). */
export const ETHIOPIAN_WEEKDAYS_AM = [
  'እሑድ',
  'ሰኞ',
  'ማክሰኞ',
  'ረቡዕ',
  'ሐሙስ',
  'ዓርብ',
  'ቅዳሜ',
] as const;

export const ETHIOPIAN_WEEKDAYS_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Gregorian calendar date → Julian Day Number. Exact integer arithmetic. */
export function gregorianToJdn(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** Julian Day Number → Gregorian calendar date. */
export function jdnToGregorian(jdn: number): GregorianDate {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

/** Ethiopian date → Julian Day Number. */
export function ethiopianToJdn(year: number, month: number, day: number): number {
  return (
    ETHIOPIAN_EPOCH_JDN +
    365 +
    365 * (year - 1) +
    Math.floor(year / 4) +
    30 * (month - 1) +
    (day - 1)
  );
}

/** Julian Day Number → Ethiopian date. */
export function jdnToEthiopian(jdn: number): EthiopianDate {
  const r = mod(jdn - ETHIOPIAN_EPOCH_JDN, 1461);
  const n = mod(r, 365) + 365 * Math.floor(r / 1460);
  const year =
    4 * Math.floor((jdn - ETHIOPIAN_EPOCH_JDN) / 1461) +
    Math.floor(r / 365) -
    Math.floor(r / 1460);
  const month = Math.floor(n / 30) + 1;
  const day = mod(n, 30) + 1;
  return { year, month, day };
}

/** True modulo that behaves correctly for negative operands. */
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export function gregorianToEthiopian(g: GregorianDate): EthiopianDate {
  return jdnToEthiopian(gregorianToJdn(g.year, g.month, g.day));
}

export function ethiopianToGregorian(e: EthiopianDate): GregorianDate {
  return jdnToGregorian(ethiopianToJdn(e.year, e.month, e.day));
}

/** An Ethiopian year is a leap year (Pagume has 6 days) when year % 4 === 3. */
export function isEthiopianLeapYear(year: number): boolean {
  return mod(year, 4) === 3;
}

/** Number of days in a given Ethiopian month (13th month varies). */
export function ethiopianMonthLength(year: number, month: number): number {
  if (month < 1 || month > 13) throw new RangeError(`Invalid Ethiopian month: ${month}`);
  if (month === 13) return isEthiopianLeapYear(year) ? 6 : 5;
  return 30;
}

export function isValidEthiopianDate(e: EthiopianDate): boolean {
  if (!Number.isInteger(e.year) || !Number.isInteger(e.month) || !Number.isInteger(e.day)) {
    return false;
  }
  if (e.year < 1 || e.month < 1 || e.month > 13 || e.day < 1) return false;
  return e.day <= ethiopianMonthLength(e.year, e.month);
}

// ---------------------------------------------------------------------------
// ISO date-string helpers.
//
// Throughout the system, calendar dates (as opposed to instants) are stored as
// 'YYYY-MM-DD' strings in the *Gregorian* calendar. This avoids all timezone
// ambiguity: a school day is a calendar date, not a moment in time.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(iso: string): GregorianDate {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new RangeError(`Invalid ISO date: ${iso}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`Invalid ISO date: ${iso}`);
  }
  return { year, month, day };
}

export function toIsoDate(g: GregorianDate): string {
  const mm = String(g.month).padStart(2, '0');
  const dd = String(g.day).padStart(2, '0');
  return `${g.year}-${mm}-${dd}`;
}

/** Convert an ISO Gregorian date string to an Ethiopian date. */
export function isoToEthiopian(iso: string): EthiopianDate {
  return gregorianToEthiopian(parseIsoDate(iso));
}

/** Convert an Ethiopian date to an ISO Gregorian date string. */
export function ethiopianToIso(e: EthiopianDate): string {
  return toIsoDate(ethiopianToGregorian(e));
}

/** Day of week (0 = Sunday) for an ISO date, without constructing a Date. */
export function isoWeekday(iso: string): number {
  const g = parseIsoDate(iso);
  return mod(gregorianToJdn(g.year, g.month, g.day) + 1, 7);
}

/** Add a number of days to an ISO date string. */
export function addDays(iso: string, days: number): string {
  const g = parseIsoDate(iso);
  return toIsoDate(jdnToGregorian(gregorianToJdn(g.year, g.month, g.day) + days));
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const ga = parseIsoDate(a);
  const gb = parseIsoDate(b);
  return gregorianToJdn(gb.year, gb.month, gb.day) - gregorianToJdn(ga.year, ga.month, ga.day);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type CalendarSystem = 'ethiopian' | 'gregorian' | 'both';
export type DateLocale = 'en' | 'am';

export type FormatDateOptions = {
  /** Which calendar to render. Defaults to 'both'. */
  calendar?: CalendarSystem;
  /** Language for month names. Defaults to 'en'. */
  locale?: DateLocale;
  /** Render month as a name rather than a number. Defaults to true. */
  monthName?: boolean;
};

export function formatEthiopian(
  e: EthiopianDate,
  locale: DateLocale = 'en',
  monthName = true,
): string {
  if (!monthName) {
    return `${String(e.day).padStart(2, '0')}/${String(e.month).padStart(2, '0')}/${e.year}`;
  }
  const names = locale === 'am' ? ETHIOPIAN_MONTHS_AM : ETHIOPIAN_MONTHS_EN;
  return `${names[e.month]} ${e.day}, ${e.year}`;
}

export function formatGregorian(
  g: GregorianDate,
  locale: DateLocale = 'en',
  monthName = true,
): string {
  if (!monthName) {
    return `${String(g.day).padStart(2, '0')}/${String(g.month).padStart(2, '0')}/${g.year}`;
  }
  const names =
    locale === 'am'
      ? ['', 'ጃንዩወሪ', 'ፌብሩወሪ', 'ማርች', 'ኤፕሪል', 'ሜይ', 'ጁን', 'ጁላይ', 'ኦገስት', 'ሴፕቴምበር', 'ኦክቶበር', 'ኖቬምበር', 'ዲሴምበር']
      : ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[g.month]} ${g.day}, ${g.year}`;
}

/**
 * Format an ISO (Gregorian) date string according to a school's configured
 * calendar preference. This is the function UI code should normally call.
 */
export function formatDate(iso: string, options: FormatDateOptions = {}): string {
  const { calendar = 'both', locale = 'en', monthName = true } = options;
  const g = parseIsoDate(iso);
  const e = gregorianToEthiopian(g);
  switch (calendar) {
    case 'ethiopian':
      return formatEthiopian(e, locale, monthName);
    case 'gregorian':
      return formatGregorian(g, locale, monthName);
    case 'both':
    default:
      return `${formatEthiopian(e, locale, monthName)} (${formatGregorian(g, locale, monthName)})`;
  }
}

/** Today's date as an ISO string in a given IANA timezone (default Addis Ababa). */
export function todayIso(timeZone = 'Africa/Addis_Ababa'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  // en-CA yields YYYY-MM-DD
  return parts;
}

/** Ethiopian date for today in the school's timezone. */
export function todayEthiopian(timeZone = 'Africa/Addis_Ababa'): EthiopianDate {
  return isoToEthiopian(todayIso(timeZone));
}
