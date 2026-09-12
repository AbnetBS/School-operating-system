import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gregorianToEthiopian,
  ethiopianToGregorian,
  isoToEthiopian,
  ethiopianToIso,
  isEthiopianLeapYear,
  ethiopianMonthLength,
  isValidEthiopianDate,
  formatDate,
  addDays,
  daysBetween,
  isoWeekday,
  gregorianToJdn,
  jdnToGregorian,
  ethiopianToJdn,
  jdnToEthiopian,
} from '../src/lib/calendar/ethiopian.ts';

test('Ethiopian New Year (Meskerem 1) maps to 11 September', () => {
  // 2018 EC began on 11 September 2025 GC
  assert.deepEqual(isoToEthiopian('2025-09-11'), { year: 2018, month: 1, day: 1 });
  // 2017 EC began on 11 September 2024 GC
  assert.deepEqual(isoToEthiopian('2024-09-11'), { year: 2017, month: 1, day: 1 });
  // 2016 EC began on 12 September 2023 GC (year preceding a Gregorian leap year)
  assert.deepEqual(isoToEthiopian('2023-09-12'), { year: 2016, month: 1, day: 1 });
});

test('known reference conversions', () => {
  // Ethiopian millennium: Meskerem 1, 2000 EC = 12 September 2007 GC
  assert.equal(ethiopianToIso({ year: 2000, month: 1, day: 1 }), '2007-09-12');
  // Today's reference date used during development
  assert.deepEqual(isoToEthiopian('2026-09-08'), { year: 2018, month: 13, day: 3 });
  // Gregorian New Year 2025 falls in Tahsas 2017 EC.
  // Derived from the Meskerem 1 anchor: 2024-09-11 + 112 days = day 113 of the
  // Ethiopian year = month 4, day 23. Cross-checks against Genna (Tahsas 29 =
  // 2025-01-07), which is 6 days later.
  assert.deepEqual(isoToEthiopian('2025-01-01'), { year: 2017, month: 4, day: 23 });
});

test('Genna (Tahsas 29) shifts by one day around Gregorian leap years', () => {
  // Genna is Tahsas 29, normally 7 January, but 8 January when the Gregorian
  // year is a leap year. This is a real property of the calendars, not an
  // off-by-one: it is why the observance date is quoted as "7 or 8 January".
  assert.equal(ethiopianToIso({ year: 2016, month: 4, day: 29 }), '2024-01-08'); // 2024 is a leap year
  assert.equal(ethiopianToIso({ year: 2017, month: 4, day: 29 }), '2025-01-07');
  assert.equal(ethiopianToIso({ year: 2018, month: 4, day: 29 }), '2026-01-07');
  assert.equal(ethiopianToIso({ year: 2019, month: 4, day: 29 }), '2027-01-07');
  assert.equal(ethiopianToIso({ year: 2020, month: 4, day: 29 }), '2028-01-08'); // 2028 is a leap year
});

test('round-trip conversion is stable across a long range', () => {
  // Walk ~40 years of days and assert Gregorian -> Ethiopian -> Gregorian is identity
  let jdn = gregorianToJdn(2000, 1, 1);
  const end = gregorianToJdn(2040, 1, 1);
  for (; jdn < end; jdn++) {
    const g = jdnToGregorian(jdn);
    const e = gregorianToEthiopian(g);
    assert.ok(isValidEthiopianDate(e), `invalid Ethiopian date produced for JDN ${jdn}`);
    const back = ethiopianToGregorian(e);
    assert.deepEqual(back, g, `round-trip failed at JDN ${jdn}`);
    assert.equal(ethiopianToJdn(e.year, e.month, e.day), jdn);
    assert.deepEqual(jdnToEthiopian(jdn), e);
  }
});

test('leap years and Pagume length', () => {
  // Ethiopian leap year when year % 4 === 3
  assert.equal(isEthiopianLeapYear(2015), true);
  assert.equal(isEthiopianLeapYear(2016), false);
  assert.equal(isEthiopianLeapYear(2011), true);
  assert.equal(ethiopianMonthLength(2015, 13), 6);
  assert.equal(ethiopianMonthLength(2016, 13), 5);
  assert.equal(ethiopianMonthLength(2016, 1), 30);
  // Pagume 6 exists only in a leap year
  assert.equal(isValidEthiopianDate({ year: 2015, month: 13, day: 6 }), true);
  assert.equal(isValidEthiopianDate({ year: 2016, month: 13, day: 6 }), false);
});

test('Pagume 6 in a leap year converts correctly', () => {
  // 2015 EC is a leap year; Pagume 6 = 11 September 2023 GC, day before New Year
  const iso = ethiopianToIso({ year: 2015, month: 13, day: 6 });
  assert.equal(iso, '2023-09-11');
  assert.deepEqual(isoToEthiopian('2023-09-12'), { year: 2016, month: 1, day: 1 });
});

test('rejects invalid dates', () => {
  assert.equal(isValidEthiopianDate({ year: 2016, month: 14, day: 1 }), false);
  assert.equal(isValidEthiopianDate({ year: 2016, month: 1, day: 31 }), false);
  assert.equal(isValidEthiopianDate({ year: 2016, month: 0, day: 1 }), false);
  assert.equal(isValidEthiopianDate({ year: 2016, month: 1, day: 0 }), false);
  assert.throws(() => isoToEthiopian('not-a-date'));
  assert.throws(() => isoToEthiopian('2024-13-01'));
});

test('date arithmetic', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29'); // Gregorian leap day
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(daysBetween('2024-01-01', '2024-12-31'), 365); // 2024 is a leap year
  assert.equal(daysBetween('2025-09-11', '2025-09-11'), 0);
  assert.equal(daysBetween('2025-09-12', '2025-09-11'), -1);
});

test('weekday calculation matches JS Date', () => {
  for (const iso of ['2026-09-08', '2025-09-11', '2024-01-07', '2000-02-29']) {
    const expected = new Date(`${iso}T00:00:00Z`).getUTCDay();
    assert.equal(isoWeekday(iso), expected, `weekday mismatch for ${iso}`);
  }
});

test('formatting respects calendar preference and locale', () => {
  assert.equal(
    formatDate('2025-09-11', { calendar: 'ethiopian', locale: 'en' }),
    'Meskerem 1, 2018',
  );
  assert.equal(formatDate('2025-09-11', { calendar: 'ethiopian', locale: 'am' }), 'መስከረም 1, 2018');
  assert.equal(
    formatDate('2025-09-11', { calendar: 'gregorian', locale: 'en' }),
    'September 11, 2025',
  );
  assert.equal(
    formatDate('2025-09-11', { calendar: 'both', locale: 'en' }),
    'Meskerem 1, 2018 (September 11, 2025)',
  );
  assert.equal(
    formatDate('2025-09-11', { calendar: 'ethiopian', monthName: false }),
    '01/01/2018',
  );
});
