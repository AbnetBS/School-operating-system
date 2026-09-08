/**
 * Money handling for the School Operating System.
 *
 * RULE: money is ALWAYS stored and computed as an integer number of cents
 * ("santim" for ETB). Never use a float for money. `0.1 + 0.2 !== 0.3` in
 * IEEE-754, and those errors compound across thousands of fee lines until a
 * school's ledger no longer balances.
 *
 * Values are typed as `Cents` to make accidental mixing with major-unit
 * numbers a type error.
 */

export type Cents = number & { readonly __brand: 'Cents' };

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Money must be an integer number of cents, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money value out of safe integer range: ${value}`);
  }
  return value as Cents;
}

/**
 * Render a number as a plain decimal string, expanding exponential notation.
 * `String(n)` yields the shortest representation that round-trips to the same
 * double, which is the best available reconstruction of the user's intent.
 */
function toPlainDecimalString(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const [mantissa = '', expPart = '0'] = s.split(/e/i);
  const exp = Number(expPart);
  const negative = mantissa.startsWith('-');
  const m = negative ? mantissa.slice(1) : mantissa;
  const [intPart = '', fracPart = ''] = m.split('.');
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length);
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  return (negative ? '-' : '') + out;
}

/**
 * Convert a major-unit amount (e.g. 30000.50 ETB) to cents, rounding half away
 * from zero.
 *
 * This deliberately does NOT compute `amount * 100`. In IEEE-754,
 * `1.005 * 100 === 100.49999999999999`, so multiplying then rounding would
 * charge a student one santim less than intended. Instead the decimal digits
 * are read from the string representation, which is exact.
 */
export function fromMajor(amount: number): Cents {
  if (!Number.isFinite(amount)) {
    throw new TypeError(`Invalid money amount: ${amount}`);
  }
  const s = toPlainDecimalString(amount);
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [intPart, fracPart = ''] = body.split('.');
  const frac2 = `${fracPart}00`.slice(0, 2);
  const nextDigit = fracPart.length > 2 ? Number(fracPart[2]) : 0;
  let magnitude = Number(intPart) * 100 + Number(frac2);
  if (nextDigit >= 5) magnitude += 1; // round half away from zero
  return cents(negative ? -magnitude : magnitude);
}

/**
 * Parse a user-entered money string such as "30,000.50" or "30000" into cents.
 * Returns null when the input is not a valid amount, so callers can surface a
 * validation error rather than silently storing a wrong number.
 */
export function parseMoney(input: string): Cents | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (trimmed === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return fromMajor(value);
}

/** Convert cents to a major-unit number. Use only for display or export. */
export function toMajor(value: Cents): number {
  return value / 100;
}

export function addMoney(...values: Cents[]): Cents {
  return cents(values.reduce<number>((sum, v) => sum + v, 0));
}

export function subtractMoney(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function negateMoney(a: Cents): Cents {
  return cents(-a);
}

export function multiplyMoney(value: Cents, factor: number): Cents {
  const scaled = value * factor;
  return cents(scaled < 0 ? -Math.round(-scaled) : Math.round(scaled));
}

/**
 * Apply a percentage (e.g. 15 for 15%) to an amount, rounding half away from
 * zero. Used for percentage-based discounts and scholarships.
 */
export function percentOf(value: Cents, percent: number): Cents {
  if (!Number.isFinite(percent)) throw new TypeError(`Invalid percentage: ${percent}`);
  return multiplyMoney(value, percent / 100);
}

export function maxMoney(a: Cents, b: Cents): Cents {
  return a >= b ? a : b;
}

export function minMoney(a: Cents, b: Cents): Cents {
  return a <= b ? a : b;
}

/** Clamp to zero — balances should not go negative unless explicitly allowed. */
export function clampToZero(value: Cents): Cents {
  return value < 0 ? cents(0) : value;
}

export const ZERO = cents(0);

/**
 * Split an amount into `n` installments without losing or inventing cents.
 * The remainder is distributed one cent at a time across the earliest
 * installments, so the parts always sum exactly to the original amount.
 *
 * e.g. splitEvenly(10000, 3) => [3334, 3333, 3333]
 */
export function splitEvenly(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`Installment count must be a positive integer, received ${parts}`);
  }
  const base = Math.trunc(total / parts);
  const remainder = total - base * parts;
  const sign = remainder < 0 ? -1 : 1;
  const absRemainder = Math.abs(remainder);
  return Array.from({ length: parts }, (_, i) =>
    cents(base + (i < absRemainder ? sign : 0)),
  );
}

/**
 * Format money for display. Defaults to ETB with the `Br` symbol commonly used
 * in Ethiopia; `currencyDisplay: 'code'` renders "ETB 30,000.00" instead.
 */
export function formatMoney(
  value: Cents,
  options: {
    currency?: string;
    locale?: string;
    withSymbol?: boolean;
  } = {},
): string {
  const { currency = 'ETB', locale = 'en-ET', withSymbol = true } = options;
  const major = toMajor(value);
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(major);
  if (!withSymbol) return formatted;
  return currency === 'ETB' ? `Br ${formatted}` : `${currency} ${formatted}`;
}
