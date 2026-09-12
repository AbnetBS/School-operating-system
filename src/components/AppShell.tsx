'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export type NavItem = { href: string; label: string; icon: string };

/**
 * Application shell.
 *
 * Mobile-first: on a phone the navigation collapses to a bottom bar of the
 * most-used destinations plus a drawer for the rest; on a tablet or desktop it
 * becomes a persistent sidebar. Teachers work on phones, so the primary
 * actions must be reachable with a thumb.
 */
export default function AppShell({
  children,
  nav,
  userName,
  roleLabel,
  schoolName,
  ethiopianDate,
  gregorianDate,
}: {
  children: React.ReactNode;
  nav: NavItem[];
  userName: string;
  roleLabel: string;
  schoolName: string;
  ethiopianDate: string;
  gregorianDate: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));

  // The four most-used destinations get a slot in the bottom bar.
  const primary = nav.slice(0, 4);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-ink-50">
      {/* Sidebar — tablet and desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-ink-200 bg-white lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-ink-200 px-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-base font-bold text-white">
            ት
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-900">{schoolName}</p>
            <p className="text-[11px] text-ink-500">School OS</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                isActive(item.href)
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900'
              }`}
            >
              <span aria-hidden className="w-5 text-center text-base">
                {item.icon}
              </span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-ink-200 p-3">
          <div className="mb-2 px-2">
            <p className="truncate text-sm font-medium text-ink-900">{userName}</p>
            <p className="text-xs text-ink-500">{roleLabel}</p>
          </div>
          <button
            onClick={signOut}
            className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-600 hover:bg-ink-50 hover:text-red-600"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/95 px-4 backdrop-blur lg:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          className="tap-target -ml-2 flex items-center justify-center rounded-lg px-2 text-ink-600"
          aria-label="Open menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-900">{schoolName}</p>
          <p className="truncate text-[11px] text-ink-500">{ethiopianDate}</p>
        </div>
      </header>

      {/* Drawer — mobile */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-ink-200 px-4">
              <p className="truncate font-semibold text-ink-900">{schoolName}</p>
              <button
                onClick={() => setDrawerOpen(false)}
                className="tap-target px-2 text-ink-500"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setDrawerOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium ${
                    isActive(item.href) ? 'bg-brand-50 text-brand-700' : 'text-ink-700'
                  }`}
                >
                  <span aria-hidden className="w-5 text-center text-base">
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="border-t border-ink-200 p-3">
              <div className="mb-2 px-2">
                <p className="text-sm font-medium text-ink-900">{userName}</p>
                <p className="text-xs text-ink-500">{roleLabel}</p>
              </div>
              <button
                onClick={signOut}
                className="w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="pb-20 lg:ml-64 lg:pb-0">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>

      {/* Bottom bar — mobile */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-ink-200 bg-white lg:hidden">
        {primary.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`tap-target flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
              isActive(item.href) ? 'text-brand-600' : 'text-ink-500'
            }`}
          >
            <span aria-hidden className="text-lg leading-none">
              {item.icon}
            </span>
            <span className="truncate px-1">{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
