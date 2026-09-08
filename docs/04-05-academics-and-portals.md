# Groups 4 + 5 — Academics (gradebook & report cards) and Portals

Phase 3. Written before implementation; kept as the record of what was decided
and why, so a later reader does not have to reverse-engineer the intent.

## What already existed (inspected, reused, not rewritten)

| Thing | Where | How it is used here |
|---|---|---|
| Grading calculation engine | `src/lib/grading/calculate.ts` | Reused unchanged. It is already pure and configurable: weighted components, drop-lowest, bands, GPA, competition ranking. Group 4 adds persistence *around* it, not a second engine. |
| Configurable grading settings | `src/lib/settings/schemas.ts` → `gradingSettingsSchema` | The source of truth for components, bands, pass mark, ranking, GPA. Already validated (weights sum to 100, bands must not overlap). |
| Report-card settings | same → `reportCardSettingsSchema` | Drives which sections appear on a report card, the approval chain, and whether results reach portals. |
| `sectionSubjects.gradingConfigId` | `src/db/schema/core.ts` | Pre-existing seam for a per-subject override of the school default. Now honoured. |
| Permissions | `src/lib/auth/permissions.ts` | `grade.*`, `reportCard.*`, `portal.student`, `portal.parent` already defined and already assigned to the seeded roles. No new permissions invented. |
| Audit actions | `src/lib/audit/index.ts` | `grade.enter/update/submit/approve/lock/unlock/overrideLocked`, `reportCard.generate/approve/publish` already in the closed union. |
| Relationship authz | `src/lib/auth/context.ts` | `requireStudentAccess`, `canViewStudent`, `requireSectionAccess`, `relationships.{sectionIds,childStudentIds,ownStudentId}`. Portals are built on these rather than on new logic. |
| Attendance history | `src/lib/attendance/service.ts` → `getStudentAttendance` | Reused for the report card's attendance block and the portal attendance view. |

The portal redirects in `src/app/(app)/layout.tsx` and `src/app/page.tsx`
already pointed at `/portal/parent` and `/portal/student`, which did not exist —
parents and students could log in but landed on a 404. Group 5 closes that.

## Group 4 — Academics

### Configurability (the explicit requirement)

Nothing about assessment structure is hard-coded. A mark belongs to an
**assessment**, and an assessment names a **component key** that must exist in
the school's configured `grading.components`. Resolution order for which
structure applies to a class:

1. `section_subjects.grading_config_id` → a `grading_configs` row (per-subject override)
2. otherwise the school's `grading.components` setting

`grading_configs` is a new table holding a named component set, so a school can
say "Practical subjects are 60% coursework" without changing the default for
everyone, and without a code change. The two demo schools already prove the
point with genuinely different structures:

- `bfa`: quiz 10 ×2, assignment 10 ×2, test 20, midterm 20, final 40 — ranking on, GPA off, 5 bands
- `aps`: classwork 20 ×3, test 20 ×2, midterm 25, final 35 — ranking off, GPA on, 8 bands

### Schema (migration `0004_gradebook.sql`)

| Table | Purpose |
|---|---|
| `grading_configs` | Named, reusable component sets. Optional per-subject override of the school default. |
| `assessments` | A concrete piece of work: "Quiz 1" for a section-subject in a term, tied to a configured component key, with its own `max_mark` and optional due date. |
| `marks` | One student's mark for one assessment. `null` mark = not yet entered; `is_excused` distinguishes "excused" from "zero". |
| `subject_results` | Cached per-student, per-section-subject, per-term outcome (percentage, letter, points, pass). Recomputed on change; never the sole source of truth. |
| `term_results` | Per-student, per-term aggregate: average, GPA, rank, pass/fail, attendance percentage. |
| `report_cards` | The published artefact: status, approval trail, comments, snapshot of the results at publication. |

`marks` carries a workflow status at the **assessment** level (`draft →
submitted → approved → locked`), not per mark, because that is how schools
actually work: a teacher submits a whole quiz, not one pupil at a time.

Tenant integrity follows the established pattern from `0001`/`0003`: every
parent gets `UNIQUE (id, school_id)` and children reference the **pair**, so a
cross-school mark is rejected by the database, not merely by application code.

### Workflow

`draft → submitted → approved → locked`, with `grade.overrideLocked` the only
way past a lock, and every transition audited with a reason. The approval chain
itself comes from `reportCard.approvalChain` settings, so a school that does not
want a review step can configure it away.

### Snapshot at publication

A published report card stores a JSON snapshot of the results. If a mark is
later corrected, the published document does not silently change under a
parent who already read it — the correction produces a new version. This is a
deliberate integrity decision, not an optimisation.

## Group 5 — Portals

Three portals, all read-only over the same authorization primitives:

| Portal | Who | Sees |
|---|---|---|
| `/portal/student` | `portal.student` | Own results (published only), own attendance, own subjects. Nothing else. |
| `/portal/parent` | `portal.parent` | Each linked child, switchable. Same restriction to published results. |
| `/portal/teacher` (in-app) | `grade.enter` | Own sections' gradebooks and submission state. |

### Authorization rules (enforced server-side, tested)

1. A student sees exactly `relationships.ownStudentId`. Any other id → **404**, not 403 (a 403 confirms the record exists).
2. A parent sees exactly `relationships.childStudentIds`. Another parent's child → 404.
3. Unpublished results are invisible to both, regardless of any id they supply, when `reportCard.publishToPortals` requires publication.
4. Cross-school ids → 404 via the existing `TenantIsolationError` mapping.
5. Portal users have no `student.view`, so the staff application redirects them out — but that is convenience; each portal endpoint re-checks independently.

## Definition of done (plan §C4)

1. Migration applied and reversible · 2. Server-side permission check on every endpoint ·
3. Zod validation client and server · 4. Tenant-isolation test · 5. Unauthorized-access test ·
6. Duplicate/boundary test · 7. Mobile layout · 8. Audit entries on mutations ·
9. Amharic strings for all new UI · 10. No fake data.

## Deliberately not in this phase

Timetable, homework, exams and documents are Group 8. PDF export of a report
card is done with the browser's own print path (a print stylesheet) rather than
by adding a PDF engine — a dependency that size needs a real justification, and
print-to-PDF is what schools already use.

---

## Implementation notes (added during build)

### Bugs found and fixed while testing

**1. Correlated subqueries silently returned zero.**
Drizzle only renders a column reference table-qualified when the outer query
contains a JOIN. In a join-free query, `${assessments.id}` is emitted as a bare
`"id"`, which Postgres resolves against the *subquery's* table — so
`select count(*) from marks m where m.assessment_id = "id"` compared each mark
to itself and returned 0 for every row. No error, just a wrong number: every
assessment reported "0 of 24 marked".

Fixed by writing the outer column explicitly as
`${assessments}.${sql.identifier('id')}`, which is join-independent. The same
form was applied defensively in `dashboard/queries.ts` and
`attendance/service.ts`; those call sites have joins and were correct, but they
would break silently if a join were ever removed. Pinned by
*"assessment progress counts real marks, not zero"* and
*"teachable class list reports a real student count"*.

**2. A blank mark was stored as a scored nought.**
`markEntrySchema` used `z.union([z.coerce.number(), z.null()])`. Because
`Number(null) === 0` and `Number('') === 0`, and the union tries the coercion
branch first, clearing a mark box recorded **0** rather than "not entered" —
quietly pulling the pupil's average down, and rejecting excused pupils outright
with "an excused student cannot also have a mark".

Fixed with a `preprocess` step that normalises null/undefined/`''` to `null`
*before* any coercion is attempted. The three states the gradebook depends on —
not entered, scored zero, excused — are now all preserved. Pinned by
*"a blank mark is 'not entered', never a zero"*.

**3. Report cards could be generated for any class.**
`generateReportCards` checked only `reportCard.generate`. The Class Teacher role
legitimately holds that permission so teachers can prepare their own class, so
any class teacher could generate — and then read — every other class's results.
A permission says *what* someone may do, never *whose* data they may do it to.

Added `assertSectionAllowed`, applied to `generateReportCards`,
`publishForSection` and `getSectionReportCardStatus`. School-wide roles
(`academic.manage`, `reportCard.publish`, `grade.review`) pass; everyone else
must have the section in `relationships.sectionIds`. Denial is 404, not 403, so
the endpoint cannot be used to enumerate section ids. Pinned by three tests in
`tests/portal.test.ts`.

### Verified end-to-end over HTTP

Mark entry, the full `draft → submitted → approved → locked` workflow, report
card generation/approval/publication, and both portals were exercised with real
sessions against the running server:

- partial save returns `{saved: 3, errors: {...}}` — one bad mark never discards
  the class, and a forged `studentId` is refused with "not in this class"
- a teacher cannot approve their own marks (403); locked marks reject edits
  (403); unlocking without a reason is refused (400)
- `bfa` ↔ `aps` is sealed in both directions (404 on read, list and write)
- a parent sees only their own children; another family's child, a classmate and
  a student from the other school are all 404
- results stay invisible until published, and a published card is served from
  its frozen snapshot even after the underlying mark changes

### Deliberate choices

- **Printing** uses a print stylesheet plus the browser's print-to-PDF rather
  than a PDF library. The browser already has the Ethiopic fonts needed to
  render Amharic subject names; a bundled PDF engine would need its own.
- **`saveMarks` is partial-success** rather than all-or-nothing. A teacher
  entering thirty marks on a phone should not lose twenty-nine of them to one
  typo.
