# Group 7 — Finance

Money is the part of a school system where a bug is not an inconvenience. A
wrong balance is a family accused of not paying, or a school quietly losing
income. This module is therefore built to be *correct first*: every rule is
enforced by the database or by the server, and the tests are written to try to
break it rather than to confirm it works.

## What already existed (reused, not rebuilt)

Group 7 adds no parallel copies of anything:

- **`src/lib/money.ts`** — integer-cents arithmetic, `splitEvenly`,
  `percentOf`, `formatMoney`. Already complete and tested (8 tests). Used
  as-is; no new money maths was written.
- **Six permissions** — `fee.view`, `fee.manage`, `payment.view`,
  `payment.record`, `payment.void`, `finance.report` — already defined and
  already granted to `finance_officer`, `accountant` and (read-only)
  `principal`. Teachers hold none, which is exactly the requirement.
- **Five audit actions** — `fee.create`, `fee.update`, `fee.assign`,
  `payment.record`, `payment.void` — already in the closed union.
- **Two event types** — `payment.recorded` and `fee.due` — already in
  `DomainEventMap`, and **the notification handlers for both are already
  written and registered** (`onFeeDue`, `onPaymentRecorded` in
  `src/lib/notifications/handlers.ts`), with English and Amharic templates for
  in-app and SMS. Group 7 only has to *emit* the events.
- **`financeSettingsSchema`** — currency, receipt prefix, overpayment policy,
  grace days, reminder lead time, sibling discount.
- **Student identity, enrolment, academic years, sections, guardianship,
  portals, notification engine** — all consumed, none duplicated.

## The billing model

The central decision: **a fee structure is a template; a charge is a fact.**

```
fee_structures   what the school charges, and to whom      (configurable)
      |  applied to the students it matches
      v
student_charges  what THIS student owes for THIS year      (immutable history)
      |  paid off by
      v
payment_allocations  which payment settled which charge
      ^
      |
   payments      money actually received, with a receipt
```

Three reasons for the split:

1. **History must not move.** A charge stores its own `amountCents`,
   `academicYearId` and `gradeLevelId` *at the moment it was raised*. Editing
   next year's tuition, or moving a pupil to another class, cannot retroactively
   change what they owed last year. The requirement "historical financial
   records remain attached to the correct academic year and cannot accidentally
   change" is met by copying the amount, not by pointing at a live template.

2. **Not every charge comes from a template.** A one-off charge (a replaced
   textbook, a trip) is a `student_charge` with a null `feeStructureId`. The
   requirement for "student-specific charges where appropriate" needs no
   special case.

3. **Allocation is explicit.** A payment can settle several charges, and a
   charge can be settled by several payments. `payment_allocations` records
   which, so a receipt can say what was actually paid for, and voiding a
   payment releases exactly the right amounts.

### Balance is derived, never stored

`student_charges.amountCents` minus the sum of its live allocations *is* the
outstanding amount. There is no cached `balance` column to drift out of step
with the ledger. Aggregates in the dashboard are computed by query.

### Discounts and waivers

A discount is stored on the charge itself (`discountCents` + reason + type),
not deducted from the amount, so a receipt and an audit can always show the
full price and the concession separately. `netAmountCents` is a generated
column — the database computes `amount - discount`, so no code path can
produce a charge whose net is inconsistent with its parts.

## Payment integrity

The requirement list is met as follows.

| Risk | Defence |
|---|---|
| Paying more than outstanding | Recomputed server-side inside the transaction; allowed only if `finance.allowOverpayment` |
| Negative or zero payment | Zod `.int().positive()` **and** a DB `CHECK (amount_cents > 0)` |
| Invalid student/fee id | Existence checked within the school scope; 404 |
| Cross-school payment | Composite FKs on `(id, school_id)`; the DB rejects it |
| Amount manipulated in the browser | The client never sends a balance; the server derives it |
| Duplicate submission | `client_key` unique per school; a replay returns the original receipt |
| Editing finalised history | Payments are append-only; correction is a **void**, which needs `payment.void` |
| Concurrent payments | `SELECT ... FOR UPDATE` on the charge rows inside the transaction |

**Concurrency was verified, not assumed.** Two simultaneous 600 payments
against a 1000 balance: the first commits, the second re-reads the locked row,
sees 400 outstanding and is rejected. Final paid = 600, not 1200.

**Voiding is not deleting.** A voided payment keeps its row, gains
`voided_at` / `voided_by` / `void_reason`, and its allocations stop counting.
The ledger remains auditable; the money is released back to the charges.

## Receipts

Receipt numbers are generated inside the payment transaction from a per-school
counter (`finance_counters`), locked `FOR UPDATE`, so two concurrent payments
cannot take the same number. The format is `{prefix}-{year}-{000001}` using the
school's configured `receiptPrefix`.

A receipt shows the school, the student's name and class, what was paid for,
the amount, method, reference, date, who recorded it, and the remaining
balance. It deliberately does **not** show the student's medical notes, address,
guardian contact details or any other record that has no business on a receipt.

## Payment methods are data, not an enum

`financeSettingsSchema.paymentMethods` was a closed `z.enum`. That is the same
silent-data-loss bug fixed twice already in Group 6: `parseSettings` *salvages*
an invalid field by dropping it and substituting the default, so a school
configuring a method outside the list would have had it silently discarded.

It is now a validated free string (a slug), with the built-in methods offered
as suggestions. A school can add "Awash Bank" or "Cooperative Bank of Oromia"
without a code change. Online providers (Telebirr, CBE Birr) are recorded as
*methods of payment received*, which is honest: **no online payment integration
is faked.** There is no gateway call, and nothing claims a payment was
collected online. The seam for a real provider is the same registry pattern
used for SMS.

## Notification integration

Finance emits domain events and stops there. It does not import the
notification module, does not write notifications, and does not know whether
SMS is configured:

- `payment.recorded` → existing `onPaymentRecorded` handler
- `fee.due` → existing `onFeeDue` handler

Both handlers already consult the school's notification settings, so a school
that has switched fee notifications off gets none. Overdue and upcoming-due
reminders are raised by a sweep that emits `fee.due` for charges inside the
reminder window, deduped by the notification layer's existing `dedupe_key`.

## Portal access

Parents and students read finance through the same
`resolvePortalStudent(ctx, requestedId)` used by every other portal page, which
resolves the identity from the **session**, never from a supplied id, and
returns 404 for anything not theirs. No new access-control path was written for
finance — reusing the audited one is the point.

Portal viewers get `fee.view`-shaped data for their own student only, and hold
no permission that lets them write. There is no parent-facing mutation
endpoint at all in this group.
