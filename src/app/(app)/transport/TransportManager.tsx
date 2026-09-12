'use client';

/**
 * Vehicles and routes.
 *
 * Driver and assistant are chosen from the staff register rather than typed,
 * so "who was driving?" resolves to a person the school can contact. The
 * service re-checks that both ids belong to this school (`assertStaffOwned`).
 *
 * Route capacity is a property of the vehicle, so the seat count shown here is
 * derived, never entered twice.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Badge, EmptyState } from '../../../components/ui.tsx';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  CheckboxRow,
  ErrorBanner,
  SuccessBanner,
  SubmitButton,
  SecondaryButton,
  Disclosure,
  useSubmit,
} from '../../../components/form.tsx';

type Labels = Record<string, string>;
type Option = { id: string; name: string };

type Vehicle = {
  id: string;
  plateNumber: string;
  label: string | null;
  vehicleType: string;
  capacity: number;
  status: string;
  driverName: string | null;
  driverStaffId: string | null;
  assistantStaffId: string | null;
  insuranceUntil: string | null;
  inspectionUntil: string | null;
  routeCount: number;
};

type Route = {
  id: string;
  name: string;
  code: string | null;
  direction: string;
  monthlyFeeCents: number | null;
  active: boolean;
  vehicleId: string | null;
  plateNumber: string | null;
  capacity: number | null;
  stopCount: number;
  riderCount: number;
};

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCost(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function RouteManager({
  labels,
  routes,
  vehicles,
  directions,
  canManage,
}: {
  labels: Labels;
  routes: Route[];
  vehicles: { id: string; plateNumber: string }[];
  directions: string[];
  canManage: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Card title={t('transport.routes')} className="mb-6">
      {canManage && (
        <Disclosure
          open={creating}
          onToggle={(next) => {
            setCreating(next);
            setEditingId(null);
          }}
          openLabel={t('transport.newRoute')}
          closeLabel={t('action.cancel')}
        >
          <RouteForm
            labels={labels}
            t={t}
            vehicles={vehicles}
            directions={directions}
            initial={{
              name: '',
              code: '',
              vehicleId: '',
              direction: 'both',
              monthlyFee: '',
              active: true,
              note: '',
            }}
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </Disclosure>
      )}

      {routes.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t('transport.noRoutes')} />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {routes.map((route) => {
            const riders = Number(route.riderCount ?? 0);
            const capacity = route.capacity ?? 0;
            const left = capacity > 0 ? capacity - riders : null;
            return (
              <li key={route.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink-900">
                      {route.name}
                      {!route.active && (
                        <span className="ml-2">
                          <Badge tone="neutral">{t('library.inactive')}</Badge>
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-ink-500">
                      {route.plateNumber ?? t('transport.noVehicle')} ·{' '}
                      {t(`transport.direction.${route.direction}`)} · {route.stopCount}{' '}
                      {t('transport.stops')} · {riders} {t('transport.riders')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {left === null ? (
                      <Badge tone="neutral">{riders}</Badge>
                    ) : left <= 0 ? (
                      <Badge tone="bad">{t('transport.full')}</Badge>
                    ) : (
                      <Badge tone={left <= 3 ? 'warn' : 'good'}>
                        {fill(labels['transport.seatsLeft'] ?? '', { count: String(left) })}
                      </Badge>
                    )}
                    <Link
                      href={`/transport/${route.id}`}
                      className="tap-target rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
                    >
                      {t('transport.manageRoute')}
                    </Link>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => setEditingId(editingId === route.id ? null : route.id)}
                        className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                      >
                        {t('action.edit')}
                      </button>
                    )}
                  </div>
                </div>

                {canManage && editingId === route.id && (
                  <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                    <RouteForm
                      labels={labels}
                      t={t}
                      routeId={route.id}
                      vehicles={vehicles}
                      directions={directions}
                      initial={{
                        name: route.name,
                        code: route.code ?? '',
                        vehicleId: route.vehicleId ?? '',
                        direction: route.direction,
                        monthlyFee:
                          route.monthlyFeeCents === null
                            ? ''
                            : (route.monthlyFeeCents / 100).toFixed(2),
                        active: route.active,
                        note: '',
                      }}
                      onDone={() => {
                        setEditingId(null);
                        router.refresh();
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

type RouteDraft = {
  name: string;
  code: string;
  vehicleId: string;
  direction: string;
  monthlyFee: string;
  active: boolean;
  note: string;
};

function RouteForm({
  labels,
  t,
  initial,
  routeId,
  vehicles,
  directions,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  initial: RouteDraft;
  routeId?: string;
  vehicles: { id: string; plateNumber: string }[];
  directions: string[];
  onDone: () => void;
}) {
  const { saving, error, fieldErrors, submit } = useSubmit();
  const [draft, setDraft] = useState<RouteDraft>(initial);
  const [success, setSuccess] = useState<string | null>(null);

  function set<K extends keyof RouteDraft>(key: K, value: RouteDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const body = {
      name: draft.name.trim(),
      code: orNull(draft.code),
      vehicleId: draft.vehicleId || null,
      direction: draft.direction,
      monthlyFeeCents: parseCost(draft.monthlyFee),
      active: draft.active,
      note: orNull(draft.note),
    };
    const result = routeId
      ? await submit(`/api/transport/routes/${routeId}`, { method: 'PATCH', body })
      : await submit('/api/transport/routes', { method: 'POST', body });
    if (!result) return;
    setSuccess(t('transport.routeSaved'));
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('transport.route')}
          error={fieldErrors.name}
          required
          className="sm:col-span-2"
        >
          <TextInput
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            required
            maxLength={200}
            invalid={Boolean(fieldErrors.name)}
          />
        </Field>

        <Field label={t('transport.routeCode')} error={fieldErrors.code}>
          <TextInput
            value={draft.code}
            onChange={(e) => set('code', e.target.value)}
            maxLength={32}
            invalid={Boolean(fieldErrors.code)}
          />
        </Field>

        <Field label={t('transport.vehicle')} error={fieldErrors.vehicleId}>
          <Select value={draft.vehicleId} onChange={(e) => set('vehicleId', e.target.value)}>
            <option value="">{t('transport.noVehicle')}</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.plateNumber}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('transport.direction')} error={fieldErrors.direction}>
          <Select value={draft.direction} onChange={(e) => set('direction', e.target.value)}>
            {directions.map((d) => (
              <option key={d} value={d}>
                {t(`transport.direction.${d}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('transport.monthlyFee')} error={fieldErrors.monthlyFeeCents}>
          <TextInput
            value={draft.monthlyFee}
            onChange={(e) => set('monthlyFee', e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            invalid={Boolean(fieldErrors.monthlyFeeCents)}
          />
        </Field>
      </div>

      <CheckboxRow
        id={`route-active-${routeId ?? 'new'}`}
        label={t('transport.active')}
        checked={draft.active}
        onChange={(next) => set('active', next)}
      />

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      <div className="flex flex-wrap gap-2">
        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={draft.name.trim().length === 0}
        >
          {t('action.save')}
        </SubmitButton>
        {routeId && (
          <SecondaryButton onClick={onDone} disabled={saving}>
            {t('action.cancel')}
          </SecondaryButton>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

type VehicleDraft = {
  plateNumber: string;
  label: string;
  vehicleType: string;
  capacity: string;
  driverStaffId: string;
  assistantStaffId: string;
  status: string;
  insuranceUntil: string;
  inspectionUntil: string;
  note: string;
};

const EMPTY_VEHICLE: VehicleDraft = {
  plateNumber: '',
  label: '',
  vehicleType: 'bus',
  capacity: '0',
  driverStaffId: '',
  assistantStaffId: '',
  status: 'active',
  insuranceUntil: '',
  inspectionUntil: '',
  note: '',
};

export function VehicleManager({
  labels,
  vehicles,
  types,
  statuses,
  staff,
  canManage,
}: {
  labels: Labels;
  vehicles: Vehicle[];
  types: string[];
  statuses: string[];
  staff: Option[];
  canManage: boolean;
}) {
  const t = useCallback((key: string) => labels[key] ?? key, [labels]);
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Card title={t('transport.vehicles')}>
      {canManage && (
        <Disclosure
          open={creating}
          onToggle={(next) => {
            setCreating(next);
            setEditingId(null);
          }}
          openLabel={t('transport.newVehicle')}
          closeLabel={t('action.cancel')}
        >
          <VehicleForm
            labels={labels}
            t={t}
            initial={EMPTY_VEHICLE}
            types={types}
            statuses={statuses}
            staff={staff}
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </Disclosure>
      )}

      {vehicles.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t('transport.noVehicles')} />
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {vehicles.map((vehicle) => (
            <li key={vehicle.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium text-ink-900">
                    {vehicle.plateNumber}
                  </p>
                  <p className="text-xs text-ink-500">
                    {[
                      vehicle.label,
                      t(`transport.vehicleType.${vehicle.vehicleType}`),
                      vehicle.driverName
                        ? `${t('transport.driver')}: ${vehicle.driverName}`
                        : null,
                      `${vehicle.capacity} ${t('transport.capacity')}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      vehicle.status === 'active'
                        ? 'good'
                        : vehicle.status === 'maintenance'
                          ? 'warn'
                          : 'neutral'
                    }
                  >
                    {t(`transport.status.${vehicle.status}`)}
                  </Badge>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === vehicle.id ? null : vehicle.id)}
                      className="tap-target rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
                    >
                      {t('action.edit')}
                    </button>
                  )}
                </div>
              </div>

              {canManage && editingId === vehicle.id && (
                <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
                  <VehicleForm
                    labels={labels}
                    t={t}
                    vehicleId={vehicle.id}
                    initial={{
                      plateNumber: vehicle.plateNumber,
                      label: vehicle.label ?? '',
                      vehicleType: vehicle.vehicleType,
                      capacity: String(vehicle.capacity),
                      driverStaffId: vehicle.driverStaffId ?? '',
                      assistantStaffId: vehicle.assistantStaffId ?? '',
                      status: vehicle.status,
                      insuranceUntil: vehicle.insuranceUntil ?? '',
                      inspectionUntil: vehicle.inspectionUntil ?? '',
                      note: '',
                    }}
                    types={types}
                    statuses={statuses}
                    staff={staff}
                    onDone={() => {
                      setEditingId(null);
                      router.refresh();
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function VehicleForm({
  labels,
  t,
  initial,
  vehicleId,
  types,
  statuses,
  staff,
  onDone,
}: {
  labels: Labels;
  t: (k: string) => string;
  initial: VehicleDraft;
  vehicleId?: string;
  types: string[];
  statuses: string[];
  staff: Option[];
  onDone: () => void;
}) {
  const { saving, error, fieldErrors, submit } = useSubmit();
  const [draft, setDraft] = useState<VehicleDraft>(initial);
  const [success, setSuccess] = useState<string | null>(null);

  function set<K extends keyof VehicleDraft>(key: K, value: VehicleDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const body = {
      plateNumber: draft.plateNumber.trim(),
      label: orNull(draft.label),
      vehicleType: draft.vehicleType,
      capacity: Number(draft.capacity) || 0,
      driverStaffId: draft.driverStaffId || null,
      assistantStaffId: draft.assistantStaffId || null,
      status: draft.status,
      insuranceUntil: draft.insuranceUntil || null,
      inspectionUntil: draft.inspectionUntil || null,
      note: orNull(draft.note),
    };
    const result = vehicleId
      ? await submit(`/api/transport/vehicles/${vehicleId}`, { method: 'PATCH', body })
      : await submit('/api/transport/vehicles', { method: 'POST', body });
    if (!result) return;
    setSuccess(t('transport.vehicleSaved'));
    if (!vehicleId) setDraft(EMPTY_VEHICLE);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('transport.plateNumber')} error={fieldErrors.plateNumber} required>
          <TextInput
            value={draft.plateNumber}
            onChange={(e) => set('plateNumber', e.target.value)}
            required
            maxLength={32}
            invalid={Boolean(fieldErrors.plateNumber)}
          />
        </Field>

        <Field label={t('transport.vehicleType')} error={fieldErrors.vehicleType}>
          <Select value={draft.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}>
            {types.map((type) => (
              <option key={type} value={type}>
                {t(`transport.vehicleType.${type}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('transport.capacity')} error={fieldErrors.capacity}>
          <TextInput
            value={draft.capacity}
            onChange={(e) => set('capacity', e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            invalid={Boolean(fieldErrors.capacity)}
          />
        </Field>

        <Field label={t('finance.status')} error={fieldErrors.status}>
          <Select value={draft.status} onChange={(e) => set('status', e.target.value)}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {t(`transport.status.${s}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('transport.driver')} error={fieldErrors.driverStaffId}>
          <Select
            value={draft.driverStaffId}
            onChange={(e) => set('driverStaffId', e.target.value)}
          >
            <option value="">{t('asset.unassigned')}</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('transport.assistant')} error={fieldErrors.assistantStaffId}>
          <Select
            value={draft.assistantStaffId}
            onChange={(e) => set('assistantStaffId', e.target.value)}
          >
            <option value="">{t('asset.unassigned')}</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('transport.insuranceUntil')} error={fieldErrors.insuranceUntil}>
          <TextInput
            type="date"
            value={draft.insuranceUntil}
            onChange={(e) => set('insuranceUntil', e.target.value)}
          />
        </Field>

        <Field label={t('transport.inspectionUntil')} error={fieldErrors.inspectionUntil}>
          <TextInput
            type="date"
            value={draft.inspectionUntil}
            onChange={(e) => set('inspectionUntil', e.target.value)}
          />
        </Field>

        <Field label={t('asset.note')} error={fieldErrors.note} className="sm:col-span-2">
          <TextArea
            value={draft.note}
            onChange={(e) => set('note', e.target.value)}
            maxLength={500}
          />
        </Field>
      </div>

      <ErrorBanner message={error} />
      {!error && <SuccessBanner message={success} />}

      <div className="flex flex-wrap gap-2">
        <SubmitButton
          saving={saving}
          savingLabel={labels['ops.saving'] ?? '…'}
          disabled={draft.plateNumber.trim().length === 0}
        >
          {t('action.save')}
        </SubmitButton>
        {vehicleId && (
          <SecondaryButton onClick={onDone} disabled={saving}>
            {t('action.cancel')}
          </SecondaryButton>
        )}
      </div>
    </form>
  );
}
