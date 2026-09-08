import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cents,
  fromMajor,
  toMajor,
  parseMoney,
  addMoney,
  subtractMoney,
  percentOf,
  splitEvenly,
  formatMoney,
  clampToZero,
  multiplyMoney,
  ZERO,
} from '../src/lib/money.ts';

test('rejects non-integer cents', () => {
  assert.throws(() => cents(10.5));
  assert.throws(() => cents(Number.MAX_SAFE_INTEGER + 10));
  assert.doesNotThrow(() => cents(0));
  assert.doesNotThrow(() => cents(-500));
});

test('major/cents conversion avoids float error', () => {
  assert.equal(fromMajor(30000), 3000000);
  assert.equal(fromMajor(0.1) + fromMajor(0.2), fromMajor(0.3));
  assert.equal(fromMajor(1.005), 101); // rounds half away from zero
  assert.equal(fromMajor(-1.005), -101);
  assert.equal(toMajor(cents(3000000)), 30000);
});

test('the classic float bug does not occur', () => {
  // Plain float arithmetic fails this; integer cents must not.
  assert.notEqual(0.1 + 0.2, 0.3);
  const a = fromMajor(0.1);
  const b = fromMajor(0.2);
  assert.equal(addMoney(a, b), fromMajor(0.3));
});

test('parses user input safely', () => {
  assert.equal(parseMoney('30,000.50'), 3000050);
  assert.equal(parseMoney('30000'), 3000000);
  assert.equal(parseMoney('  1200.5 '), 120050);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('12.345'), null); // too many decimals
  assert.equal(parseMoney('1.2.3'), null);
  assert.equal(parseMoney('NaN'), null);
});

test('arithmetic', () => {
  assert.equal(addMoney(cents(100), cents(250), cents(50)), 400);
  assert.equal(subtractMoney(cents(1000), cents(250)), 750);
  assert.equal(multiplyMoney(cents(1000), 1.5), 1500);
  assert.equal(clampToZero(cents(-500)), 0);
  assert.equal(clampToZero(cents(500)), 500);
  assert.equal(addMoney(), ZERO);
});

test('percentage discounts round predictably', () => {
  assert.equal(percentOf(cents(3000000), 10), 300000); // 10% of 30,000.00
  assert.equal(percentOf(cents(333), 50), 167); // 1.665 -> 1.67 (half away from zero)
  assert.equal(percentOf(cents(100), 0), 0);
});

test('installment split never loses or invents cents', () => {
  const total = cents(10000);
  const parts = splitEvenly(total, 3);
  assert.deepEqual(parts, [3334, 3333, 3333]);
  assert.equal(addMoney(...parts), total);

  // Property: for many totals and part counts, the parts must sum exactly.
  for (let t = 0; t < 500; t++) {
    for (const n of [1, 2, 3, 4, 5, 7, 9, 12]) {
      const split = splitEvenly(cents(t), n);
      assert.equal(split.length, n);
      assert.equal(addMoney(...split), cents(t), `split ${t} into ${n} did not sum back`);
    }
  }
  assert.throws(() => splitEvenly(cents(100), 0));
  assert.throws(() => splitEvenly(cents(100), 2.5));
});

test('formatting', () => {
  assert.equal(formatMoney(cents(3000000)), 'Br 30,000.00');
  assert.equal(formatMoney(cents(50)), 'Br 0.50');
  assert.equal(formatMoney(cents(3000000), { withSymbol: false }), '30,000.00');
  assert.equal(formatMoney(cents(3000000), { currency: 'USD' }), 'USD 30,000.00');
});
