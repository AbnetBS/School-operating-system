# Group 9 — what already existed, and what was missing

Written before any Group 9 code, from reading the tree. The point of this file
is to make the "reuse, don't rebuild" decision auditable.

## Already implemented — reused as-is

| Capability | Where | Verdict |
|---|---|---|
| School overview aggregates | `src/lib/dashboard/queries.ts` → `getSchoolOverview` | Reuse. All SQL-side, school-scoped. |
| Enrolment by grade / section rolls | same file → `getEnrollmentByGrade`, `getSectionSummaries` | Reuse. Covers most of §2. |
| Setup gaps (no class teacher, unassigned subjects) | same file | Reuse for the actionable dashboard. |
| Per-student attendance %, at-risk flag | `src/lib/attendance/service.ts` → `getAttendanceSummary` | Reuse. Already paginated, already honours `restrictToSectionIds`. |
| Consecutive absences | same → `getConsecutiveAbsences` | Reuse. |
| Missing registers | same → `getMissingRegisters` | Reuse for teacher completion. |
| Today's attendance progress | same → `getTodayProgress` | Reuse for the dashboard. |
| Attendance reports UI | `src/app/(app)/attendance/reports/page.tsx` | Already exists with 4 tabs. Left alone. |
| Finance summary / collection rate | `src/lib/finance/reports.ts` → `getFinanceSummary` | Reuse. |
| Outstanding students | same → `getOutstandingStudents` | Reuse. |
| Fee reminder sweep | `src/lib/finance/reminders.ts` → `sweepDueReminders` | Reuse — this IS the fee-reminder automation §6 asks for. |
| Event bus + handlers + templates | `src/lib/events/`, `src/lib/notifications/` | Reuse. No second engine. |
| Audit query | `src/lib/audit/index.ts` → `queryAuditLog` | Reuse for "recent activity". |
| CSV writer | `src/lib/import/csv.ts` → `toCsv` | Reuse for every new export. |
| Cached term/subject results | `term_results`, `subject_results` tables | Reuse. Academic analytics reads these rather than recomputing. |

## Missing — built in Group 9

| Gap | Why it mattered |
|---|---|
| **Risk service** | `risk` settings key existed in `SETTINGS_SCHEMAS` and was **never read by any code**. The whole early-warning feature was a defined config with no implementation. |
| **Academic intelligence** | No class/subject/student averages, no trend, no improving/declining, no missing-marks or pending-approval counts anywhere. |
| **Teacher completion view** | `getMissingRegisters` existed but nothing aggregated it per teacher alongside marks status. |
| **Global search** | Nothing. No `/api/search`, no search service. |
| **Executive dashboard** | `/dashboard` existed but showed only setup gaps and rolls — no attendance today, no fees, no risk, and every string was **hard-coded English**. |
| **Analytics exports** | Only `students/export` existed. |
| **i18n** | Zero `analytics.*`, `risk.*`, `search.*`, `dashboard.*` keys in either catalogue. |

## Deliberately NOT built (Group 10)

AI assistant, payroll, library/inventory/transport expansion, marketplace,
external integrations. The context-builder seam described in
`docs/08-09-operations-and-intelligence.md` stays unbuilt.
