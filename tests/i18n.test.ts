import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../src/lib/i18n/messages/en.ts';
import am from '../src/lib/i18n/messages/am.ts';
import { createTranslator, interpolate, resolveLocale, LOCALES } from '../src/lib/i18n/index.ts';

test('Amharic catalogue covers every English key', () => {
  const missing = Object.keys(en).filter((k) => !(k in am));
  assert.deepEqual(missing, [], `Missing Amharic translations for: ${missing.join(', ')}`);
});

test('Amharic catalogue has no keys absent from English', () => {
  const extra = Object.keys(am).filter((k) => !(k in en));
  assert.deepEqual(extra, [], `Amharic has orphan keys: ${extra.join(', ')}`);
});

test('no catalogue entry is blank', () => {
  for (const [locale, cat] of [
    ['en', en],
    ['am', am],
  ] as const) {
    for (const [key, value] of Object.entries(cat)) {
      assert.ok(value.trim().length > 0, `${locale}.${key} is blank`);
    }
  }
});

test('placeholders match between locales', () => {
  const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(en)) {
    assert.equal(
      placeholders(am[key]!),
      placeholders(en[key]!),
      `Placeholder mismatch for key "${key}"`,
    );
  }
});

/**
 * The mirror of the Amharic check, and the one that was missing.
 *
 * A whole block of `finance.*` keys was pasted into BOTH catalogues in
 * Amharic, so every finance screen rendered Amharic to an English user and no
 * test noticed: the Amharic file was correct, the key sets matched, and
 * nothing asserted that English is written in English.
 */
test('English strings do not contain Ethiopic script', () => {
  const ethiopic = /[\u1200-\u137F]/;
  const wrong = Object.entries(en)
    .filter(([, value]) => ethiopic.test(value))
    .map(([key]) => key);

  assert.deepEqual(
    wrong,
    [],
    `English values containing Ethiopic script: ${wrong.join(', ')}`,
  );
});

test('Amharic strings actually contain Ethiopic script', () => {
  // Guards against a catalogue that was copy-pasted from English and never
  // translated. Allow keys whose value is legitimately non-alphabetic.
  const ethiopic = /[\u1200-\u137F]/;
  const untranslated = Object.entries(am)
    .filter(([, v]) => !ethiopic.test(v))
    .map(([k]) => k);
  assert.deepEqual(untranslated, [], `Amharic values without Ethiopic script: ${untranslated}`);
});

test('translator interpolates and falls back', () => {
  const t = createTranslator('en');
  assert.equal(t('term.number', { number: 2 }), 'Term 2');
  assert.equal(t('nav.students'), 'Students');
  // Unknown key returns the key itself rather than blank or a crash
  assert.equal(t('does.not.exist'), 'does.not.exist');

  const tAm = createTranslator('am');
  assert.equal(tAm('nav.students'), 'ተማሪዎች');
  assert.equal(tAm('term.number', { number: 2 }), '2ኛ ወቅት');
});

test('interpolate leaves unknown placeholders visible', () => {
  assert.equal(interpolate('Hello {name}', { name: 'Abebe' }), 'Hello Abebe');
  assert.equal(interpolate('Hello {name}'), 'Hello {name}');
  assert.equal(interpolate('{a} and {b}', { a: 1 }), '1 and {b}');
});

test('locale resolution precedence', () => {
  assert.equal(resolveLocale('am', 'en', 'en-US'), 'am'); // user wins
  assert.equal(resolveLocale(null, 'am', 'en-US'), 'am'); // school default next
  assert.equal(resolveLocale(null, null, 'am-ET,am;q=0.9'), 'am'); // header next
  assert.equal(resolveLocale(null, null, null), 'en'); // final fallback
  assert.equal(resolveLocale('klingon', null, null), 'en'); // invalid ignored
});

test('every declared locale has a working translator', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale);
    assert.ok(t('nav.dashboard').length > 0);
  }
});
