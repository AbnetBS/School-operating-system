# Ethiopian School Operating System — Repository Assessment & Implementation Plan

**Date:** 2026-09-08
**Branch:** `arena/01a080fc-school-operating-system`
**Base commit:** `890fbb2` (Initial commit)

---

## Part A — Inspection Results

### A1. What already exists

Almost nothing. The repository is a bare initial commit:

| Item | Finding |
|---|---|
| Tracked files | **1** (`README.md`, containing only the heading `# School-operating-system`) |
| Commits | **1** (`890fbb2 Initial commit`) |
| Source code | none |
| Database schema / migrations | none |
| Authentication / authorization | none |
| APIs | none |
| UI components | none |
| Tests | none |
| CI, linting, tooling config | none |
| Dependency manifest | none (`package.json`, `requirements.txt`, etc. all absent) |

**Conclusion: this is a greenfield build, not a refactor.** Your instructions §68 ("inspect the existing project, do not rewrite working functionality") and §69 ("build one module at a time") still fully apply — they just apply to code I am about to write rather than code that is already here.

### A2. What is missing

Everything in your specification. There is no partial implementation to integrate with, and no legacy decision constraining the design. This is good news: we get to make the multi-tenancy, permission, and configurability decisions correctly at the schema level rather than retrofitting them, which is exactly where school-management products usually fail.

### A3. What should be reused

Nothing from the repo. What we *will* reuse heavily is a set of internal primitives that must be built **once** and then consumed by every module — this is the technical expression of your §1 "enter information once, reuse everywhere":

| Primitive | Reused by |
|---|---|
| Tenant-scoped data access layer | every query in the system |
| Permission guard (`requirePermission`) | every API route |
| Settings/config resolver (typed, per-school) | grading, fees, terms, policies, modules |
| Ethiopian⇄Gregorian calendar module | every date input, display, report |
| i18n message catalogue | every string in UI, reports, SMS |
| Audit writer | every mutation |
| Domain-event bus + automation runner | attendance, grades, payments, notifications |
| Notification dispatcher (channel-abstracted) | in-app, SMS, email |
| Import/validate/commit pipeline | students, teachers, subjects, fees, grades |
| Money & fee-calculation engine | fees, discounts, payments, receipts |

### A4. What needs modification

Nothing exists to modify. The `README.md` will be replaced with real project documentation.

### A5. What needs to be newly implemented

All of it. Sequencing is in Part C.

### A6–A7. MVP vs. later

See Part C. Summary: I agree with your §62 MVP list, with **one change** — I recommend moving *basic fee/payment recording* into the MVP tail rather than Phase 2, because "what does this student still owe?" is the single most common front-desk question in Ethiopian schools and it is cheap to add once students and academic years exist. Everything else in your Phase 2/3/4 ordering I agree with and will not pre-build.

---

## Part B — Risks Identified Before Writing Code

You asked specifically for architectural, security, database, and workflow problems. Since there is no existing code, these are the problems that *would* occur if this system were built the obvious way. Each has a stated mitigation that is baked into the plan.

### B1. Architectural

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Tenancy added later.** Retrofitting `school_id` after modules exist is the #1 killer of school SaaS products. | `school_id` on every tenant-owned table from migration 001; a single scoped DB handle is the *only* sanctioned way route code reaches the database. |
| 2 | **Config baked into code.** Hard-coded terms/grade scales/fee rules force a code change per school (your §12, §27, §65). | Configuration is *data*: per-school settings rows validated by typed schemas, with defaults. No school-specific branching in code, ever. |
| 3 | **Modules coupled directly to each other.** Attendance calling notification code inline makes both untestable and unconfigurable. | Modules emit **domain events**; an automation runner reads per-school rules and dispatches. Your §51 becomes real infrastructure, not a metaphor. |
| 4 | **Prisma ORM is unusable in this environment.** Verified: `binaries.prisma.sh` is unreachable from the sandbox, so engine download fails. | Use **Drizzle ORM** — pure TypeScript, no engine binaries, plain SQL migrations. Verified working. |
| 5 | **No database server in the sandbox.** No Postgres/MySQL binary, no Docker, no root. | Use **PGlite** — real PostgreSQL compiled to WASM, embedded in-process. Verified working with Drizzle, including `jsonb`. Same SQL dialect as production Postgres; the driver is selected by env var, so production points at managed Postgres with no code change. |
| 6 | **N+1 queries in dashboards** will make the principal dashboard time out at 2,000 students. | Aggregates computed in SQL, list endpoints paginated by default, dashboard counters served from purpose-built queries. |

### B2. Security

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Frontend-only permission checks** (your §48 warning). | Every API route calls a server-side guard before touching data. UI hiding is cosmetic only. |
| 2 | **Cross-tenant data leakage** (your §70 critical test). | Scoped DB handle + automated test suite that actively attempts School A → School B reads and must fail. |
| 3 | **Horizontal privilege escalation** — Parent A fetching Student B by guessing an ID (your §49). | Authorization is *relationship-based*, not just role-based: parent scope = own children, teacher scope = assigned sections/subjects. Enforced in the data layer, not the handler. |
| 4 | **Weak password storage.** | `scrypt` via Node's built-in `crypto` — memory-hard, zero dependencies, no native build. Per-user random salt, constant-time verify. |
| 5 | **Session fixation / no revocation.** JWT-only sessions can't be revoked when a teacher leaves. | Server-side session records, httpOnly + SameSite cookies, revocable, with expiry and rotation. |
| 6 | **Unrestricted file access** — report cards and IDs served from a public folder. | Documents served through an authorizing route that re-checks permission and tenancy on every request. |
| 7 | **Audit trail that can be edited.** | Append-only audit table, written inside the same transaction as the change it records. No update/delete path exposed. |
| 8 | **Brute-force login.** | Per-account and per-IP rate limiting on auth endpoints. |

### B3. Database

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Western name columns** (`first_name`, `last_name`) — breaks Ethiopian naming (your §4). | Store `given_name`, `father_name`, `grandfather_name` as first-class columns, plus Amharic variants. Display name is composed, never parsed. |
| 2 | **Floating-point money.** `0.1 + 0.2` errors compound across thousands of fee lines. | Money stored as **integer cents** of ETB. All arithmetic in integers. Formatting at the edge only. |
| 3 | **Duplicate attendance rows** on double-submit or offline re-sync (your §59, §70). | Unique constraint on `(school_id, section_id, subject_id, date, session)` + idempotency keys on the write API → upsert, never duplicate. |
| 4 | **Duplicate student IDs** (your §59). | Unique constraint `(school_id, student_code)` at the database level, not just in validation. |
| 5 | **Mutable history.** Changing a student's section retroactively rewrites last term's attendance reports. | Enrolment is a **time-scoped record** (student ↔ section ↔ academic year), so history stays correct. Your §4 "keep historical student records". |
| 6 | **Grades stored as computed totals only.** Changing the weighting config would silently rewrite past results. | Store raw marks per assessment; store *published* term results as immutable snapshots including the grading config used. |
| 7 | **Timezone drift** on attendance dates. | Attendance keyed by a school-local calendar date (`date` type), not a timestamp. |
| 8 | **No soft-delete / no recovery.** | Status fields and soft-delete on core records; backup strategy documented and scriptable (your §47). |

### B4. Workflow

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Assuming schools start at the beginning of the year** (your §63). | Setup wizard supports mid-year start: create year → grades → sections → import students → assign → start attendance today. Admission is *not* a prerequisite. |
| 2 | **Assuming admission always runs** (your §8). | Admission is a toggleable module, off by default. |
| 3 | **Assuming every school ranks students** (your §16). | Ranking is a per-school report-card option, default off. |
| 4 | **Assuming a fixed approval chain** (your §55). | Approval workflow is configured per school as an ordered list of steps. Teacher→Principal and Teacher→Coordinator→Principal both work with no code change. |
| 5 | **Attendance too slow to actually be used.** If it takes more than ~30 seconds for a class, teachers revert to paper. | Default-all-present, tap-to-toggle, one submit, works offline, mobile-first. This is the make-or-break screen of the product. |
| 6 | **Locked grades with no escape hatch.** | Locked marks are changeable only with elevated permission, and only with a mandatory reason recorded in the audit log (your §14). |

---

## Part C — Proposed Implementation Plan

### C1. Technology decisions (and why)

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 (App Router) + TypeScript** | One codebase for UI and API, server-side rendering for low-bandwidth mobile, mature. Verified booting in this sandbox behind the preview proxy. |
| Database | **PostgreSQL** — PGlite (embedded WASM) in dev/demo, managed Postgres in production | Real Postgres semantics everywhere. Chosen by `DATABASE_URL`; no code change to move to production. |
| ORM / migrations | **Drizzle ORM** + plain SQL migrations | Typed, no engine binaries, transparent SQL, works offline. |
| Styling | **Tailwind CSS v4** | Mobile-first utility CSS; fast, no runtime cost. |
| Auth | Server sessions, httpOnly cookies, `scrypt` hashing | Revocable, no native deps. |
| Validation | **Zod** | One schema reused for client validation, server validation, and typed config (your §59 "validate both frontend and backend"). |
| Testing | Node's built-in test runner | Zero extra tooling; security tests are first-class. |

Pinned: TypeScript **5.9** — TypeScript 7 is now default on npm and is incompatible with Next 15 (verified failure).

### C2. Build order

Each group ends in a state that **actually works end-to-end: UI → API → DB → permissions → validation → result**, with tests. Nothing is mocked or faked. Modules not yet built are simply absent, not stubbed with fake data.

| Group | Contents | Status |
|---|---|---|
| **0. Foundation** | Project scaffold, DB layer, migrations, tenancy guard, settings engine, Ethiopian calendar, i18n (EN/AM), audit writer, event bus, session auth, RBAC | Prerequisite for everything |
| **1. School & academic setup** | Schools, module toggles, academic years, terms/semesters, grade levels, sections, subjects, rooms, periods, policies, grading configs | MVP |
| **2. People** | Users, configurable roles/permissions, staff & teachers, students (Ethiopian naming, custom fields, status history), parents & guardian links, enrolment, teacher assignments, Excel/CSV import with validation preview, exports | MVP |
| **3. Attendance** | Fast mobile attendance, offline queue + idempotent sync, daily/subject modes, reasons, percentages, at-risk detection, automation rules, analytics | MVP |
| **4. Gradebook & report cards** | Assessment types & weights, mark entry, auto-calculation, submit→review→lock workflow with audit, term results, configurable report cards, PDF, approval chain | MVP |
| **5. Portals** | Student portal, parent portal (multi-child switching), teacher portal, principal action-oriented dashboard | MVP |
| **6. Communication** | Notification engine, in-app inbox, announcements, messaging, SMS templates + provider abstraction | MVP tail |
| **7. Finance** | Configurable fee structures, per-student assignment, discounts/scholarships/installments, payments, receipts, finance dashboard, provider abstraction for Telebirr/CBE | MVP tail / Phase 2 |
| **8. Operations** | Timetable with conflict detection, homework, documents, exams, certificate verification | Phase 2 |
| **9. Advanced** | Early warning, report builder, deeper analytics, automation expansion, AI assistant | Phase 3–4 |
| **10. Future modules** | HR, payroll, transport, library, inventory, maintenance, website, marketplace | Phase 3–4, not now |

### C3. Explicitly deferred

Per your §67 (do not overengineer) and §62 (not everything now), these are **designed for but not built** in the MVP: online exams, AI assistant, payroll, transport, library, inventory, marketplace, public school website, live payment-gateway integrations. Where they affect schema or interfaces (e.g. payment provider abstraction, module toggles, subscription plan fields) the seams are put in place so they can be added without migration pain.

### C4. Definition of done, per group

1. Migrations applied and reversible
2. Server-side permission checks on every endpoint
3. Zod validation on both client and server
4. Tenant isolation test passing
5. Unauthorized-access test passing
6. Duplicate/boundary-condition test passing
7. Mobile layout verified
8. Audit entries written for mutations
9. Amharic strings present for all new UI text
10. No fake data presented as real functionality
