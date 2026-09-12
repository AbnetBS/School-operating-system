# Group 10 — Future / Expansion

Group 10 is deliberately the smallest group in the build. It is not a feature
sprint; it is the point where the system stops growing outward and is checked
for the things a real deployment needs that no earlier group owned.

The rule for this group was: **inspect first, and only build what is genuinely
missing.** Most of the Group 10 roadmap turned out to be already implemented by
Groups 1–9, because those groups were built with the expansion in mind. What
follows records that audit honestly, so a future maintainer does not rebuild
something that already works.

## What already existed before Group 10

| Roadmap item | Status found | Where it lives |
| --- | --- | --- |
| Automation engine | **Complete** | `src/lib/events/index.ts` — persisted event bus, 20 event types, isolated handlers, retry via `domain_events.last_error` |
| Automation rules, per-school | **Complete** | `notifications.events.*` in `src/lib/settings/schemas.ts` — 8 toggles, quiet hours, channels |
| Notification dedup / cooldown | **Complete** | `dedupeKey` + partial unique index (`src/lib/notifications/service.ts`) |
| No unconfigured sending | **Complete** | `provider: 'none'` default; outbox reports `unconfigured` |
| Offline attendance | **Complete** | `RegisterForm.tsx` localStorage queue + `POST /api/attendance/sync` per-register outcomes |
| Reporting / exports | **Complete** | `/api/analytics/export` (5 reports), `/api/students/export`, `toCsv()` |
| Document storage + access control | **Complete** | `getDocumentForAccess` single authorisation point, magic-byte sniffing |
| Module enable/disable | **Complete** | `modulesSchema`, 24 flags, `requireModule()` |
| School activation, plan field | **Complete** (schema) | `schools.isActive`, `schools.plan` |
| Configurable academics / fees / grading / attendance policy | **Complete** | 11 settings groups |
| Risk thresholds | **Complete** (Group 9) | `/settings/risk` |

Rebuilding any of the above would have violated the instruction not to create a
second architecture for something that already works.

## What was genuinely missing

The audit found one real gap with a matching data-integrity hole, plus one
dormant permission.

### 1. Custom field definitions were designed but never wired (implemented)

`custom_field_defs` ships in migration `0000_init.sql` with a complete column
set — `entityType`, `key`, `label`, `labelAm`, `fieldType`, `options`,
`isRequired`, `sortOrder`, `isActive` — and a unique index on
`(school_id, entity_type, key)`.

**Nothing in the codebase referenced it.** `grep -rn customFieldDefs src/`
returned zero hits outside the schema file.

Meanwhile `students.customFields` and `staff.customFields` were typed
`z.record(z.string(), z.unknown())`, so the API accepted arbitrary JSON. This
was demonstrated against the running system before any code was written:

    POST /api/students { customFields: { totally_made_up: "accepted",
                                         nested: { deep: [1,2,3] } } }
    → 201, and the object was persisted verbatim.

That is the failure mode the "enter information once" principle exists to
prevent: a field nobody defined, that no form shows, that no export knows
about, that cannot be validated, reported on, or translated. It also means one
mistyped key in an integration silently becomes permanent per-student data.

So Group 10 activates the table that was always intended to govern it.

### 2. `report.build` was defined but unused (documented, not built)

The permission exists and is granted to two role templates, but no endpoint
consumes it. The existing export infrastructure already covers the concrete
reporting needs with permission-checked, tenant-scoped, audited CSV. A generic
report builder that can select arbitrary fields is precisely the feature most
likely to leak a column nobody meant to expose, and the brief warns against
exposing fields "simply because the report builder can technically query them".
It is left as documented future work rather than half-built.

## Design of the custom-fields layer

**Definitions are configuration, values are data.** The definition lives in
`custom_field_defs` and is managed under `school.manage`. The value lives in the
owning record's `customFields` JSONB and is written through the same student and
staff endpoints as every other field — no parallel write path.

**Validation is generated from the school's own definitions.**
`buildCustomFieldsSchema()` reads the active definitions for an entity type and
returns a Zod object. An unknown key is rejected rather than stored; a required
field must be present; a `select` value must be one of its options; `number`
and `date` are checked as such. A school with no definitions gets `{}` — the
previous permissive behaviour is gone, which closes the hole above.

**Keys are immutable once created.** The key is the JSON property name already
written into every existing record, so renaming it would orphan stored values.
The label is freely editable; the key is not. Deleting a definition
deactivates it (`isActive = false`) rather than destroying data that has already
been captured — the values remain in the records and reappear if the field is
re-enabled.

**Reserved keys are refused.** A custom field may not shadow a real column
(`givenName`, `status`, `id`, …) or a JS internal (`__proto__`, `constructor`,
`prototype`). Both would be confusing at best and unsafe at worst.

## Performance notes from building it

Two things were fixed during the build rather than left for later:

- **An N+1 in the usage counts.** The settings page shows how many records hold
  a value for each field. The obvious version calls `countRecordsUsing` per
  definition — one query per row. `countUsageForDefinitions` instead groups
  definitions by table and counts every key in a single scan using
  `count(*) filter (where custom_fields ? key)`, so the page costs at most
  three queries regardless of how many fields a school defines. A test asserts
  the batched numbers equal the one-at-a-time numbers, because a faster count
  that is wrong is worse than a slow one.

- **The definition cache.** Definitions are read on every student and staff
  write, so they are cached — but the first version had neither a TTL nor a
  `globalThis` pin. Both matter: without the pin, Next.js module reloading
  silently replaces the map so invalidation appears to work when it does not;
  without the TTL, a second process keeps validating against definitions the
  school has already changed. It now mirrors `settings/service.ts` exactly:
  30-second TTL, pinned map, explicit invalidation after every write. Tests
  cover both directions — a new field is usable immediately, and a retired one
  stops being accepted immediately.

`customFields` is deliberately **not** selected by `listStudents` unless the
caller passes `withCustomFields`. The list screens do not display it, and a
JSONB column on every row of a 400-pupil school is bytes over the wire for no
benefit. Only the export asks for it.

## Not implemented, and why

- **Generic report builder** — the existing exports cover the need; a
  field-selectable builder is a disclosure risk disproportionate to its value.
  Future work.
- **Public school website / CMS** — the `website` module flag exists but a
  public marketing site is a separate product surface with its own caching,
  SEO and content-approval requirements. Building a shallow version would add a
  second content architecture for no operational gain.
- **Public certificate verification** — documents are already access-controlled
  correctly. A public verification endpoint needs an issuance workflow
  (what is a certificate, who signs it, what does revocation mean) that does not
  exist yet. Adding a public token endpoint over the current document table
  would create a public read path into private storage. Future work.
- **Live payment gateways, payroll, online exams, marketplace, push/email
  delivery, AI provider integration, GPS, antivirus, object storage** — all
  previously deferred; all still correctly deferred. Each needs an external
  provider that is not configured, and the brief forbids faking them.
- **Destructive restore** — deliberately absent. See below.

## Backup and recovery

Backup is an operational concern, not an application feature, and the dangerous
version of it is the one that lives behind a web login. The system therefore
provides **export**, not **restore**:

- Authorised, audited, tenant-scoped CSV export already exists per domain.
- Recovery of the database itself is a `pg_dump`/`pg_restore` procedure run by
  whoever administers the server, documented in `docs/11-operations-runbook.md`.

No UI exposes database credentials, raw SQL, or a restore button. A restore
performed through the application would run as an authenticated web request
with the power to overwrite every school's data; that is not a feature, it is a
vulnerability with a friendly label.
