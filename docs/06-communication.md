# Group 6 — Communication

Design record for announcements, direct messaging, in-app notifications and the
SMS provider abstraction. Read this before changing anything in
`src/lib/comms/`, `src/lib/notifications/` or `src/lib/sms/`.

## What this group is for

Schools already hold every relationship the communication system needs: who
teaches which class, who parents which child, who is enrolled where. Group 6
adds no new identity system. It answers one question — *who is allowed to say
what to whom* — using the relationships Groups 2–5 already established.

## Scope

| Built | Deferred |
|---|---|
| Announcements with audience targeting | Email delivery (no provider) |
| Direct messages (threads + participants) | Push notifications |
| In-app notifications with read/unread | Attachments on messages |
| Notification engine wired to domain events | Message search |
| Configurable per-event notification rules | Rich text / HTML bodies |
| Notification templates (EN + AM) | Group chat with arbitrary membership |
| SMS provider abstraction + outbox | A real SMS provider integration |

## Key decisions

### 1. Audience is a rule, not a copied list

An announcement stores its **targeting rule** (`audience` + optional
`sectionIds`/`gradeLevelIds`), not a materialised list of recipient ids.

Copying recipients at publish time would freeze the audience: a student who
enrols the next morning would never see "School closed Friday". Resolving the
rule at read time means the audience is always current, and a class of 400
costs one row rather than 400.

The trade-off is that "who has read this" needs its own table
(`announcement_reads`), which is written only when someone actually opens it.

### 2. Notifications are per-recipient rows; announcements are not

A notification is a personal fact ("your child was marked absent"), so it gets
one row per person with its own `readAt`. An announcement is a public fact, so
it gets one row for the school.

This is the opposite of a uniform design, and deliberately so — making
announcements per-recipient would multiply a whole-school notice by every
enrolled pupil for no benefit.

### 3. The notification engine is a subscriber, not a caller

`src/lib/notifications/handlers.ts` registers handlers on the **existing**
event bus (`src/lib/events/index.ts`). Attendance does not import
notifications; it emits `attendance.recorded` as it already does today, and a
handler here decides whether anyone should be told.

This means Group 6 changes **no** existing module's logic. The integration
points already existed — Group 6 is the first subscriber to use them.

Events currently subscribed:

| Event | Notifies | Setting gate |
|---|---|---|
| `attendance.recorded` | guardians of absent/late pupils | `events.attendanceAbsent` |
| `attendance.riskDetected` | guardians | `events.attendanceRisk` |
| `reportCard.published` | guardians + the student | `events.reportCardPublished` |
| `announcement.published` | the resolved audience | `events.announcement` |
| `payment.recorded`, `fee.due`, `homework.assigned` | seams registered, fire when Groups 7–8 emit | respective flags |

A handler that throws is caught by the bus, recorded on `domain_events.last_error`
and never rolls back the originating action. Marking a register must not fail
because a notification could not be written.

### 4. SMS is honest about not being configured

`sms_messages` rows carry an explicit status:

```
queued  → the message is stored, awaiting a provider
sent    → a provider accepted it and returned a reference
failed  → a provider rejected it; error recorded
unconfigured → no provider is set up; nothing was sent and nothing will be
```

`unconfigured` is a first-class state, not an error dressed up as success. When
no provider is configured the UI says *"SMS is not configured — N messages are
queued"* rather than implying delivery. There is no fake provider that pretends
to send.

`src/lib/sms/provider.ts` defines the `SmsProvider` interface and a registry.
Connecting an Ethiopian provider later means implementing `send()` and
registering it — no changes to the calling code.

### 5. Threads carry participants; permission is checked per thread

A direct message thread has explicit `message_participants`. Access is
*membership*, not role: a teacher is not allowed into a thread merely for being
a teacher. `assertThreadAccess` checks the participant row every time.

Who may *start* a thread with whom is a separate question, answered by
`canInitiateWith()` using existing relationships:

- staff with `message.send` → any parent/student of a class they teach
- a parent → staff who teach their child, and office staff
- a student → staff who teach them
- a parent may **never** open a thread with another parent
- nobody may start a thread across schools

## Schema

Six tables, all in `src/db/schema/comms.ts`, all carrying `school_id`:

- `announcements` — title/body (+ Amharic), audience rule, publish state
- `announcement_reads` — who opened what, when
- `message_threads` — subject, kind, optional student context
- `message_participants` — membership + per-participant `last_read_at`
- `messages` — body, sender, timestamps
- `notifications` — per-recipient, typed, with `read_at` and a dedupe key
- `sms_messages` — outbox with provider status

Tenant integrity follows the established pattern (`0007_comms_integrity.sql`):
parents carry `UNIQUE (id, school_id)` and children reference the **pair**, so
a cross-school row is rejected by the database rather than by application code.

## Deduplication

`notifications.dedupe_key` has a partial unique index. A handler that runs
twice — a retried event, a double-submitted form — produces one notification,
not two. The key encodes the meaningful identity of the notification, e.g.
`absent:{studentId}:{date}`, so a genuinely new fact still gets through.

## Who counts as "office staff"

A parent may write to their child's teachers and to the front office. Deciding
who is front office by job title is wrong — the seeded titles are
`Administration` / `Teacher` / `Subject Teacher`, schools rename roles freely,
and a title may be written in Amharic.

The signal used instead is **school-wide reach**: a role that grants
`student.view` *without* `restrict.ownSectionsOnly`. Matching on `student.view`
alone was tried first and was wrong — every teacher holds it, so every parent
in the school could message all fourteen staff. With the restriction excluded,
the demo parent sees eight contacts: their two children's six teachers, plus
the two administrators.

## Settings and the partial-update trap

`/api/settings/notifications` exposes the notification and SMS configuration.
Two permissions guard it separately: `notification.manageTemplates` for events,
channels and quiet hours, and `sms.configure` for the provider wiring, because
one costs money and the other does not.

Building the PATCH body schema needed care, and two real bugs were found and
fixed here:

1. **`/^\d{2}:\d{2}$/` accepted `25:99`** as a quiet-hours time. Now
   `/^([01]\d|2[0-3]):[0-5]\d$/`.

2. **A partial PATCH silently reset whole blocks.** A Zod field carrying
   `.default()` still emits that default when its key is absent, *even behind
   `.optional()`* — and `.partial()` does not strip the defaults of an object's
   inner fields either. So `{ sms: { isEnabled: false } }` parsed into a
   complete block and wiped the school's provider, sender ID and credential
   reference. A school would have destroyed its SMS configuration by pressing a
   toggle, with no error shown.

   `patchSchemaFor()` in `src/lib/settings/schemas.ts` strips defaults
   recursively so an omitted key stays `undefined` and the route's field-by-field
   merge preserves what is stored. Types are still validated.

This is the same failure mode as the closed SMS-provider enum recorded above:
**a schema that helpfully supplies a value is a data-loss bug when the caller
meant "don't touch this".** Both are covered by `tests/settings-notifications.test.ts`,
and both fixes were mutation-tested — reverting either makes the suite fail.

## Verified end to end

Checked over HTTP against a seeded database, not in unit tests alone:

- an admin publishes school-wide; parent, student and staff all see it, and the
  other school's admin sees nothing
- a class teacher's unscoped "all parents" broadcast is **narrowed by the server**
  to the classes they actually teach; school-wide and foreign-section attempts
  return 403
- a thread is readable only by its participants — the school admin gets 404
- marking a real register notifies the absent child's guardians, **with no change
  to the attendance module**; a replayed register produces no second notification
- switching `events.attendanceAbsent` off in settings genuinely stops the
  notification, and switching it back on resumes it
- an SMS requested with no provider is recorded `unconfigured`, never `sent`
- a forged notification id belonging to another user updates nothing (`updated: 0`)
