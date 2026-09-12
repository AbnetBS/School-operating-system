/**
 * Password hashing using scrypt from Node's built-in crypto module.
 *
 * scrypt is memory-hard, which makes GPU-accelerated cracking expensive. It
 * ships with Node, so there is no native module to compile and no dependency
 * to audit — relevant for a system that must be deployable on modest
 * infrastructure.
 *
 * Stored format:  scrypt$N$r$p$<salt-base64>$<hash-base64>
 * Storing the parameters alongside the hash means the cost can be raised later
 * without invalidating existing passwords.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP-aligned parameters: N=2^15, r=8, p=1. */
const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; allow headroom over the 32 MB default.
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

export async function hashPassword(password: string): Promise<string> {
  validatePasswordInput(password);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 * Always compares in constant time, and never throws on malformed input —
 * a corrupt hash must read as "wrong password", not as a server error that
 * distinguishes valid from invalid accounts.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(MAX_MEM, 128 * N * r * 2),
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a hash was made with weaker parameters and should be upgraded. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r;
}

function validatePasswordInput(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }
  // Node's scrypt would happily hash a megabyte; refuse obvious abuse.
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new RangeError('Password is too long');
  }
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

export type PasswordPolicy = {
  minLength: number;
  requireNumber: boolean;
  requireLetter: boolean;
  requireMixedCase: boolean;
  requireSymbol: boolean;
};

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireNumber: true,
  requireLetter: true,
  requireMixedCase: false,
  requireSymbol: false,
};

/** A short list of passwords that are common in school deployments. */
const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'admin123',
  'school123',
  'teacher1',
  'welcome1',
  'changeme',
  'ethiopia1',
]);

export type PasswordCheck = { ok: true } | { ok: false; problems: string[] };

export function checkPasswordStrength(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordCheck {
  const problems: string[] = [];
  if (password.length < policy.minLength) {
    problems.push(`Password must be at least ${policy.minLength} characters.`);
  }
  if (policy.requireLetter && !/[a-zA-Z]/.test(password)) {
    problems.push('Password must contain a letter.');
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    problems.push('Password must contain a number.');
  }
  if (policy.requireMixedCase && !(/[a-z]/.test(password) && /[A-Z]/.test(password))) {
    problems.push('Password must contain both uppercase and lowercase letters.');
  }
  if (policy.requireSymbol && !/[^a-zA-Z0-9]/.test(password)) {
    problems.push('Password must contain a symbol.');
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    problems.push('This password is too common. Choose something less guessable.');
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Generate a readable temporary password for staff onboarding.
 * Avoids characters that are easily confused when read off a printout.
 */
export function generateTemporaryPassword(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  // Guarantee the policy is satisfied.
  if (!/\d/.test(out)) out = `${out.slice(0, -1)}${bytes[0]! % 10}`;
  return out;
}
