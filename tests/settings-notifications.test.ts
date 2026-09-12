/**
 * Notification & SMS settings.
 *
 * Two real bugs were found by exercising this endpoint over HTTP and are
 * locked down here:
 *
 *   1. `/^\d{2}:\d{2}$/` accepted "25:99" as a quiet-hours time.
 *
 *   2. A partial PATCH silently reset the whole `events` block. A Zod field
 *      carrying `.default()` still emits that default when the key is absent,
 *      even behind `.optional()` — so sending only `quietHoursStart` parsed
 *      into a complete object and switched a school's notification choices
 *      back on without anyone asking. That is silent data loss of exactly the
 *      kind the SMS-provider enum produced earlier, so it gets a test.
 *
 * These are schema and merge concerns, so they are tested directly against
 * the schema and the same merge the route performs — no database needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  notificationSettingsSchema,
  patchSchemaFor,
} from '../src/lib/settings/schemas.ts';

// ---------------------------------------------------------------------------
// Quiet hours must be a real clock time
// ---------------------------------------------------------------------------

test('quiet hours reject times that are not on the clock', () => {
  const invalid = ['25:99', '24:00', '23:60', '99:99', '7:30', '0730', '', 'abc', '21:0'];

  for (const value of invalid) {
    const result = notificationSettingsSchema.safeParse({ quietHoursStart: value });
    assert.equal(
      result.success,
      false,
      `"${value}" is not a valid 24-hour time and must be rejected`,
    );
  }
});

test('quiet hours accept the boundaries of the day', () => {
  for (const value of ['00:00', '23:59', '09:05', '21:00', '06:30']) {
    const result = notificationSettingsSchema.safeParse({ quietHoursStart: value });
    assert.equal(result.success, true, `"${value}" is a valid time and must be accepted`);
  }
});

// ---------------------------------------------------------------------------
// A partial update must not reset anything it did not mention
// ---------------------------------------------------------------------------

/** Exactly what the route uses. */
const patchSchema = patchSchemaFor(notificationSettingsSchema);

type Settings = z.infer<typeof notificationSettingsSchema>;
type Patch = { [K in keyof Settings]?: Partial<Settings[K]> };

/** The same merge the route performs. */
function applyPatch(current: Settings, patch: Patch) {
  return notificationSettingsSchema.parse({
    channels: { ...current.channels, ...patch.channels },
    events: { ...current.events, ...patch.events },
    quietHoursStart: patch.quietHoursStart ?? current.quietHoursStart,
    quietHoursEnd: patch.quietHoursEnd ?? current.quietHoursEnd,
    sms: { ...current.sms, ...patch.sms },
  });
}

test('an omitted key parses to undefined rather than to its default', () => {
  const parsed = patchSchema.parse({ quietHoursStart: '22:00' });

  // This is the actual bug: with a plain `.optional()` on a defaulted field,
  // `events` came back fully populated and overwrote what was stored.
  assert.equal(parsed.events, undefined, 'events was not sent, so it must stay undefined');
  assert.equal(parsed.channels, undefined, 'channels was not sent, so it must stay undefined');
  assert.equal(parsed.sms, undefined, 'sms was not sent, so it must stay undefined');
  assert.equal(parsed.quietHoursStart, '22:00');
});

test('CRITICAL: an unrelated patch does not switch notification events back on', () => {
  const current = notificationSettingsSchema.parse({
    events: { attendanceAbsent: false, announcement: false },
  });
  assert.equal(current.events.attendanceAbsent, false);
  assert.equal(current.events.announcement, false);

  // A school turned two events off, then edits only their quiet hours.
  const next = applyPatch(current, patchSchema.parse({ quietHoursStart: '22:00' }) as Patch);

  assert.equal(next.quietHoursStart, '22:00', 'the requested change is applied');
  assert.equal(
    next.events.attendanceAbsent,
    false,
    'an event the school switched off must stay off',
  );
  assert.equal(next.events.announcement, false, 'an event the school switched off must stay off');
});

test('a single flag can be changed without restating the others', () => {
  const current = notificationSettingsSchema.parse({});
  assert.equal(current.events.attendanceRisk, true);

  const next = applyPatch(current, patchSchema.parse({ events: { attendanceAbsent: false } }) as Patch);

  assert.equal(next.events.attendanceAbsent, false, 'the named flag changes');
  assert.equal(next.events.attendanceRisk, true, 'its siblings are preserved');
  assert.equal(next.events.announcement, true, 'its siblings are preserved');
});

test('an SMS field can be changed without wiping the rest of the block', () => {
  const current = notificationSettingsSchema.parse({
    sms: { provider: 'telebirr-sms', senderId: 'BFA', apiKeyRef: 'SMS_KEY', isEnabled: true },
  });

  const next = applyPatch(current, patchSchema.parse({ sms: { isEnabled: false } }) as Patch);

  assert.equal(next.sms.isEnabled, false, 'the named field changes');
  assert.equal(next.sms.provider, 'telebirr-sms', 'the provider survives being switched off');
  assert.equal(next.sms.apiKeyRef, 'SMS_KEY', 'the credential reference is not lost');
  assert.equal(next.sms.senderId, 'BFA');
});

test('an empty patch changes nothing at all', () => {
  const current = notificationSettingsSchema.parse({
    events: { attendanceAbsent: false },
    quietHoursStart: '20:00',
    sms: { provider: 'someone', isEnabled: true },
  });

  const next = applyPatch(current, patchSchema.parse({}) as Patch);

  assert.deepEqual(next, current, 'a no-op patch must be a no-op');
});

// ---------------------------------------------------------------------------
// The provider key stays a free string (regression guard)
// ---------------------------------------------------------------------------

test('an unknown SMS provider key is preserved, not silently dropped', () => {
  // The registry decides what is installed. If this schema ever becomes a
  // closed enum again, a school's configuration would be salvaged away to
  // 'none' and nothing would be sent — with no error.
  const parsed = notificationSettingsSchema.parse({
    sms: { provider: 'an-ethiopian-gateway-added-later', isEnabled: true },
  });

  assert.equal(parsed.sms.provider, 'an-ethiopian-gateway-added-later');
  assert.equal(parsed.sms.isEnabled, true);
});
