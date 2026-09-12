# Groups 8 and 9 — Operations, and Advanced / Intelligence

Design record written before the code, in the same spirit as `docs/07-finance.md`.
It exists so the reasoning survives after the diff stops being readable.

## What was already there

Groups 1–7 left a great deal that these two groups must **reuse rather than
rebuild**:

- `src/db/scope.ts` — `createScope`, `TenantIsolationError`.
- `src/lib/auth/context.ts` — `has / hasAny / require / requireModule /
  requireStudentAccess / canViewStudent / requireSectionAccess`.
- `src/lib/api/respond.ts` — `route()`, the error contract, `readPagination`.
- `src/lib/audit/index.ts` — `recordAudit`, `queryAuditLog` (the query function
  already existed with no screen in front of it).
- `src/lib/events/index.ts` — the domain-event engine with retry and
  `last_error`. **Group 9 adds events; it does not add an engine.**
- `src/lib/notifications/*` — `notifyAboutStudent`, templates, dedupe.
- `src/lib/import/csv.ts` — `toCsv`, already used by the student export.
- `modulesSchema` — flags for `hr`, `library`, `inventory`, `maintenance`,
  `transport`, `documents`, `aiAssistant` were defined in Group 1 as seams and
  are only now switched on.
- Role templates for `librarian` and `hr_officer` existed with no module to
  manage.

## Group 8 — operations

### One principle: a physical thing and a record of it are different rows

The library is the clearest case. A *title* ("Fikir Eske Mekabir") is not a
*copy*; a school owns six copies of one title and can lend five while one is
lost. Modelling only the title forces a `quantity` integer that drifts the
moment two librarians work at once.

So: `library_items` is the title, `library_copies` is the physical book with
its own accession number and condition, and `library_loans` points at a **copy**.
Availability is then not a stored number at all — it is
`copies where status='available' and no open loan`, derived exactly the way
Group 7 derives a fee balance. The same reasoning gives assets their own rows.

Inventory is the exception, deliberately. A box of chalk has no identity worth
tracking, so `inventory_items` does carry a quantity — but it is **never
updated by reading and writing**. Every change is an append-only
`stock_movements` row, and the quantity column is recomputed inside the same
transaction under `SELECT … FOR UPDATE`. The movement history is the truth; the
column is a cache that can be rebuilt.

### Concurrency

Two clerks issuing the last copy of a book, or two storekeepers taking stock
from the same bin, is exactly the race Group 7 solved for payments. The same
mechanism is used: a transaction, `SELECT … FOR UPDATE` on the row that decides
the outcome, then the write. A partial unique index enforces "one open loan per
copy" at the database, so even a lost lock cannot double-issue.

Note the constraint that made this necessary in Group 7 and applies again here:
**PGlite serialises transactions**, so a behavioural concurrency test cannot
distinguish a locked implementation from an unlocked one. Tests therefore
assert on the emitted SQL *and* on the database constraint, not on timing.

### Staff attendance and leave

Not a copy of student attendance. Student attendance is a register taken per
section per day by a teacher; staff attendance is a single daily status per
person, usually entered by an administrator. Sharing the tables would mean a
nullable `section_id` on every student row and a permission model that has to
ask "is this a pupil or a member of staff?" on every query.

What *is* shared is the shape: a school-local `date`, an idempotency key so a
resubmitted day is a no-op, and a status vocabulary the school configures.

Leave is a small approval workflow — `pending → approved | rejected |
cancelled` — with the same rule Group 4 used for grade approval: the transition
records who and why, and an approver cannot approve their own request.

### Events

The school calendar reuses the announcement audience model rather than
inventing a second visibility system. An event has a start, an optional end, a
location, an audience rule, and a `visibility` flag; who can see it is computed
the same way an announcement's audience is.

### Documents

Metadata only, with the file stored outside the database. This is a foundation:
an upload endpoint that validates and records, a download that re-checks
permission and tenancy on every request, and no direct file paths in the
client. Nothing here guesses at a storage provider.

## Group 9 — intelligence

### Nothing here is a new source of truth

Every figure on the leadership dashboard, every risk signal, every work-queue
item is a **query over data another group already owns**. Group 9 adds no
authoritative table. That is what keeps it honest: if the dashboard disagrees
with the ledger, the dashboard is wrong.

### Risk is explainable or it is not shipped

The early-warning system produces, for each pupil, a list of *signals* — each
with the rule that fired, the observed value, the configured threshold, and a
weight. The score is the sum. The UI shows the signals, never a bare number,
and never a label like "weak".

Thresholds live in `schoolSettings` under a new `risk` key, so a school that
considers 85% attendance acceptable and one that considers 92% acceptable both
get a system that agrees with them. A school can disable any signal entirely.

The system **never acts on a risk score**. It surfaces it to someone with
permission, and that is the end of its authority.

Because the thresholds are the policy, they are edited in the product rather
than in code: `/settings/risk` (page) over `GET`/`PATCH /api/settings/risk`,
reading with `analytics.view` or `school.manage` and writing with
`school.manage` alone. Every change is audited with its previous and new value.

One guard is worth naming. If a school sets an attention score no combination
of its *enabled* signals can reach, the list is silently empty forever — which
reads as "no child needs help" rather than "the filter is impossible". The
`PATCH` handler recomputes the maximum reachable score and refuses such a
setting with a field error, and the form does the same arithmetic live so the
submit button is disabled before the round trip.

### Search must not become a discovery channel

The single most dangerous thing in Group 9. A global search that queries every
table and then filters results is a leak waiting to happen — a count, a
suggestion, or a "no results in Students" is itself information.

The rule implemented here: **search asks each module for results the caller
could already have fetched directly**, using the same permission and
relationship checks as that module's own list endpoint. A teacher restricted to
their own sections searches only those pupils. A parent searches nothing but
their own children. If a user cannot open the record, the record does not exist
as far as search is concerned.

### The AI assistant is a seam, not a product

No external provider is contacted. What is built is the part that has to be
right regardless of which provider is chosen later: a **context builder** that
assembles, for a given question, only the facts the current user is already
authorised to read, tagged with where each came from. Group 10 can put a model
behind it. Without that boundary, connecting a model later would mean handing
it a database connection, which is exactly the mistake this defers.

## Deferred to Group 10 — recorded, not built

- **Payroll.** Salary structures, deductions, tax, payslips. Real payroll is a
  compliance product, not a feature.
- **Live GPS tracking** for transport. Routes and assignments are here; vehicle
  telemetry is not.
- **Actual AI provider integration.** The context builder is here; the model
  call is not.
- Marketplace, public website builder, online exams.

## Group 8 write UI — notes for whoever runs this next

### Operational hazard: `npm run build` while `npm run dev` is running

Both use `.next/`, and on this stack both also open the same PGlite data
directory. Running a production build against a live dev server produces two
failures that look like application bugs and are not:

1. `Error: Cannot find module './8543.js'` — the build replaced the webpack
   chunks the running dev server had already loaded. Pages that worked a moment
   earlier return 500.
2. `RuntimeError: Aborted()` from `PGlite.create` — PGlite keeps recent writes
   in memory until `close()`. A dev server killed while holding the datadir can
   leave it unopenable, and the running process caches the failed handle in
   `globalThis`, so every later request fails even after the directory is
   repaired.

**Stop the dev server before building or running migrations**, and if the
datadir does get into this state:

```
rm -rf .data/pgdata && npm run db:migrate && npm run db:seed \
  && npx tsx scripts/seed-finance.ts && npx tsx scripts/seed-operations.ts
```

then restart the server — a repaired directory is not picked up by a process
that already cached a broken handle.

`scripts/migrate.ts` now clears a stale `postmaster.pid` the same way
`src/db/client.ts` does; before that fix it aborted with an opaque `Aborted()`
whenever a previous run had exited without closing cleanly.

### Where the write paths live

Every form is a client island that calls the SAME API a script would. There is
no server action that bypasses a route, so the permission, module and tenancy
checks proven by the route-contract tests apply to the UI unchanged.

- `src/components/form.tsx` — the shared kit. `useSubmit()` holds an in-flight
  ref so a double-tap cannot submit twice even before React re-renders the
  disabled button, and it never reports success on a non-2xx response.
- `src/lib/operations/storage.ts` — the only module that touches file bytes.
  Storage keys are `<schoolId>/<uuid>`, both server-generated; the uploaded
  filename is display metadata and never part of a path. File type is decided
  by magic bytes, not by `Content-Type` or the extension.

### Deliberately still deferred

- **Antivirus scanning of uploads.** Type sniffing rejects anything that is not
  a document or image, but a malicious PDF is still a malicious PDF. A real
  deployment should put a scanner in front of `putObject`.
- **Object storage.** Local disk is correct for a school on one server. The
  seam is the three functions in `storage.ts`.
