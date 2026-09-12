'use client';

/**
 * Portal navigation.
 *
 * A parent's phone screen, so this is a horizontal strip of large tap targets
 * rather than a sidebar. Unread counts are passed in from the server, which is
 * also where they are authorised — this component only draws them.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function PortalNav({
  home,
  showAnnouncements,
  showMessages,
  showFees,
  feesLabel,
  unreadNotifications,
  unreadAnnouncements,
}: {
  home: string;
  showAnnouncements: boolean;
  showMessages: boolean;
  showFees: boolean;
  feesLabel: string;
  unreadNotifications: number;
  unreadAnnouncements: number;
}) {
  const pathname = usePathname();

  const items = [
    { href: home, label: 'Overview', badge: 0 },
    ...(showAnnouncements
      ? [{ href: '/portal/announcements', label: 'Notices', badge: unreadAnnouncements }]
      : []),
    ...(showMessages ? [{ href: '/portal/messages', label: 'Messages', badge: 0 }] : []),
    ...(showFees ? [{ href: '/portal/fees', label: feesLabel, badge: 0 }] : []),
    { href: '/portal/notifications', label: 'Alerts', badge: unreadNotifications },
  ];

  return (
    <nav className="border-b border-ink-200 bg-white">
      <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`tap-target relative shrink-0 border-b-2 px-3 py-3 text-sm font-medium ${
                active
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-600 hover:text-ink-900'
              }`}
            >
              {item.label}
              {item.badge > 0 && (
                <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
