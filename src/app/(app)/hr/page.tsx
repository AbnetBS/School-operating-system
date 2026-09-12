/**
 * Staff attendance and leave.
 *
 * Two jobs on one screen because they are the same job in practice: an
 * administrator marking today's register needs to know who is on approved
 * leave, and an approver deciding a request needs to see the register.
 *
 * A person with no HR permission at all still reaches this page if they may
 * request leave for themselves — the leave half renders, the register does
 * not.
 */

import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../lib/auth/context.ts';
import { getSetting } from '../../../lib/settings/service.ts';
import { createTranslator } from '../../../lib/i18n/index.ts';
import { todayIso } from '../../../lib/calendar/ethiopian.ts';
import {
  getStaffAttendanceSheet,
  listLeaveRequests,
  listLeaveTypes,
  getOwnStaffRecord,
  getWhoIsOut,
} from '../../../lib/operations/hr.ts';
import { STAFF_ATTENDANCE_STATUSES } from '../../../lib/operations/schema.ts';
import { users } from '../../../db/schema/core.ts';
import { staff } from '../../../db/schema/people.ts';
import { PageHeader, Card, StatCard, EmptyState, Badge } from '../../../components/ui.tsx';
import { StaffRegister } from './StaffRegister.tsx';
import LeaveWorkflow from './LeaveWorkflow.tsx';
import HrDatePicker from './HrDatePicker.tsx';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'action.save',
  'action.cancel',
  'action.submit',
  'ops.saving',
  'ops.loading',
  'ops.workQueue',
  'asset.note',
  'leave.request',
  'leave.newRequest',
  'leave.submitted',
  'leave.myRequests',
  'leave.pending',
  'leave.type',
  'leave.from',
  'leave.to',
  'leave.days',
  'leave.workingDays',
  'leave.reason',
  'leave.reasonHelp',
  'leave.approve',
  'leave.reject',
  'leave.approved',
  'leave.rejected',
  'leave.rejectReason',
  'leave.rejectReasonRequired',
  'leave.confirmApprove',
  'leave.withdraw',
  'leave.confirmWithdraw',
  'leave.cannotApproveOwn',
  'leave.noTypes',
  'leave.noTypesHelp',
  'leave.forStaff',
  'leave.forSelf',
  'leave.status.pending',
  'leave.status.approved',
  'leave.status.rejected',
  'leave.status.cancelled',
];

export default async function HrPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const t = createTranslator(ctx.locale);
  const modules = await getSetting(ctx.db, ctx.schoolId, 'modules');

  if (!modules.hr) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const canTake = ctx.has('staffAttendance.take');
  const canSeeAttendance = ctx.hasAny('staffAttendance.view', 'staffAttendance.take');
  const canSeeLeave = ctx.has('leave.view');
  const canApprove = ctx.has('leave.approve');
  const canRequest = ctx.has('leave.request');

  // Requesting leave for oneself is enough to belong here.
  if (!canSeeAttendance && !canSeeLeave && !canRequest) {
    return (
      <Card>
        <EmptyState title={t('ops.noAccess')} />
      </Card>
    );
  }

  const locale = await getSetting(ctx.db, ctx.schoolId, 'locale');
  const params = await searchParams;
  const today = todayIso(locale.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today;

  const own = await getOwnStaffRecord(ctx);

  const [sheet, out, pending, leaveTypes, mine] = await Promise.all([
    canSeeAttendance ? getStaffAttendanceSheet(ctx, date) : Promise.resolve([]),
    canSeeAttendance ? getWhoIsOut(ctx, date) : Promise.resolve([]),
    canSeeLeave
      ? listLeaveRequests(ctx, { status: 'pending', limit: 20 })
      : Promise.resolve({ requests: [], total: 0 }),
    canRequest || canSeeLeave ? listLeaveTypes(ctx) : Promise.resolve([]),
    // A person's own history, whatever their permissions.
    own
      ? listLeaveRequests(ctx, { staffId: own.id, limit: 20 })
      : Promise.resolve({ requests: [], total: 0 }),
  ]);

  // Filing on someone else's behalf needs leave.approve, so only fetch the
  // staff list for those people.
  const staffRows = canApprove
    ? await ctx.db
        .select({ id: staff.id, givenName: users.givenName, fatherName: users.fatherName })
        .from(staff)
        .innerJoin(users, eq(users.id, staff.userId))
        .where(and(eq(staff.schoolId, ctx.schoolId), eq(staff.status, 'active')))
        .orderBy(asc(users.givenName))
    : [];

  const marked = sheet.filter((s) => s.status).length;
  const present = sheet.filter((s) => s.status === 'present' || s.status === 'late').length;

  // Labels are resolved on the server: a client component cannot call the
  // translator, so it receives finished strings.
  const statusLabels = Object.fromEntries(
    STAFF_ATTENDANCE_STATUSES.map((s) => [s, t(`staffAttendance.status.${s}`)]),
  );
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, t(key)]));

  return (
    <>
      <PageHeader
        title={t('staffAttendance.title')}
        description={date}
        action={
          canSeeAttendance ? <HrDatePicker current={date} today={today} /> : undefined
        }
      />

      {canSeeAttendance && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t('staff.title')} value={sheet.length} />
          <StatCard label={t('staffAttendance.status.present')} value={present} tone="good" />
          <StatCard
            label={t('staffAttendance.status.absent')}
            value={out.length}
            tone={out.length > 0 ? 'warn' : 'good'}
          />
          <StatCard
            label={t('leave.requests')}
            value={pending.total}
            tone={pending.total > 0 ? 'warn' : 'default'}
          />
        </div>
      )}

      <LeaveWorkflow
        labels={labels}
        leaveTypes={leaveTypes.map((type) => ({
          id: type.id,
          name: ctx.locale === 'am' && type.nameAm ? type.nameAm : type.name,
          requiresApproval: type.requiresApproval,
        }))}
        pending={pending.requests}
        mine={mine.requests}
        staff={staffRows.map((row) => ({
          id: row.id,
          name: [row.givenName, row.fatherName].filter(Boolean).join(' '),
        }))}
        ownStaffId={own?.id ?? null}
        today={today}
        canRequest={canRequest}
        canApprove={canApprove}
        canViewAll={canSeeLeave}
      />

      {canSeeAttendance && (
        <Card title={`${t('staffAttendance.title')} — ${date}`}>
          {sheet.length === 0 ? (
            <EmptyState title={t('staff.noStaff')} />
          ) : canTake ? (
            <StaffRegister
              date={date}
              rows={sheet.map((s) => ({
                staffId: s.staffId,
                staffCode: s.staffCode,
                name: s.name,
                jobTitle: s.jobTitle,
                status: s.status,
              }))}
              statuses={[...STAFF_ATTENDANCE_STATUSES]}
              labels={statusLabels}
              markAllLabel={t('staffAttendance.markAll')}
              saveLabel={t('action.save')}
              savedLabel={t('staffAttendance.saved')}
              recordedLabel={t('staffAttendance.recorded')}
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {sheet.map((row) => (
                <li key={row.staffId} className="flex items-center justify-between gap-3 py-3">
                  <span className="min-w-0 truncate text-ink-900">{row.name}</span>
                  {row.status ? (
                    <Badge
                      tone={
                        row.status === 'present'
                          ? 'good'
                          : row.status === 'absent'
                            ? 'bad'
                            : 'warn'
                      }
                    >
                      {t(`staffAttendance.status.${row.status}`)}
                    </Badge>
                  ) : (
                    <span className="text-xs text-ink-400">
                      {t('staffAttendance.notMarked')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-500">
            {marked} / {sheet.length}
          </p>
        </Card>
      )}
    </>
  );
}
