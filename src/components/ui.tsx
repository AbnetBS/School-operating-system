import Link from 'next/link';

/** Page heading with optional description and actions. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** A single statistic. Clickable when `href` is provided, per §53. */
export function StatCard({
  label,
  value,
  sub,
  href,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneRing =
    tone === 'good'
      ? 'border-emerald-200 bg-emerald-50'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50'
        : tone === 'bad'
          ? 'border-red-200 bg-red-50'
          : 'border-ink-200 bg-white';

  const valueTone =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-800'
        : tone === 'bad'
          ? 'text-red-700'
          : 'text-ink-900';

  const body = (
    <div
      className={`rounded-xl border p-4 transition ${toneRing} ${
        href ? 'hover:border-brand-300 hover:shadow-sm' : ''
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-bold tabular-nums ${valueTone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-500">{sub}</p>}
    </div>
  );

  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
}) {
  const classes = {
    neutral: 'bg-ink-100 text-ink-700',
    good: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    bad: 'bg-red-100 text-red-800',
    info: 'bg-brand-100 text-brand-800',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {children}
    </span>
  );
}

/**
 * An action-oriented alert. Dashboards should let users act, not just read
 * numbers (§53), so these carry a link to the screen that resolves them.
 */
export function ActionAlert({
  tone,
  title,
  detail,
  href,
  linkLabel,
}: {
  tone: 'warn' | 'bad' | 'info';
  title: string;
  detail?: string;
  href?: string;
  linkLabel?: string;
}) {
  const classes = {
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    bad: 'border-red-200 bg-red-50 text-red-900',
    info: 'border-brand-200 bg-brand-50 text-brand-900',
  }[tone];

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${classes}`}>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {detail && <p className="mt-0.5 text-xs opacity-90">{detail}</p>}
      </div>
      {href && (
        <Link
          href={href}
          className="shrink-0 rounded-lg bg-white/80 px-3 py-1.5 text-xs font-semibold underline-offset-2 hover:underline"
        >
          {linkLabel ?? 'View'}
        </Link>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="py-10 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-sm text-xs text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A horizontal bar for simple distribution charts. */
export function BarRow({
  label,
  value,
  max,
  hint,
}: {
  label: string;
  value: number;
  max: number;
  hint?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-24 shrink-0 truncate text-xs font-medium text-ink-600">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-ink-700">
        {hint ?? value}
      </span>
    </div>
  );
}
