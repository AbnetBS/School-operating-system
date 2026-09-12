/**
 * Formatting helpers shared by the finance screens.
 *
 * Aggregate queries come back as plain `number` — PostgreSQL `sum(...)::int`
 * has no idea about the `Cents` brand. Rather than sprinkling casts through
 * the pages, funnel those values through here so the integer check in
 * `cents()` still runs on every figure that reaches a user.
 */

import { cents, formatMoney, type Cents } from '../money.ts';

/**
 * Format a whole number of cents that came from the database.
 *
 * A non-integer here means a query lost its `::int` cast and money is being
 * computed in floating point, which is worth failing loudly over rather than
 * rendering a rounded number that quietly disagrees with the ledger.
 */
export function money(value: number, options?: { currency?: string; locale?: string }): string {
  return formatMoney(cents(value), options);
}

/** Same, but tolerates a missing figure — an absent total reads as zero. */
export function moneyOrZero(
  value: number | null | undefined,
  options?: { currency?: string; locale?: string },
): string {
  return money(value ?? 0, options);
}

/** Re-exported so pages need only one finance formatting import. */
export type { Cents };
export { cents };
