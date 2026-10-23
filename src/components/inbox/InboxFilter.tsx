'use client';

/**
 * The inbox's All / Needs you / Handed over filter (design spec §2 "layoutId indicators"; ADR-124
 * handed-over leads): plain links (the filter is a query parameter, so it works without script and
 * survives reloads) styled as a pill strip with one highlight that slides to the current filter.
 * The counts are the server's; Needs you takes the warning tone only when it is above zero (with
 * its words, never color alone). `basePath` is the client's inbox or the operator's `[ws]` inbox.
 */
import Link from 'next/link';
import { motion } from 'motion/react';
import { spring } from '@/components/motion/presets';
import { cn } from '@/components/ui/cn';
import type { InboxFilterKey } from './filters';

export type { InboxFilterKey };

export function InboxFilter(props: { current: InboxFilterKey; counts: { all: number; needsYou: number; handedOver: number }; basePath?: string }) {
  const base = props.basePath ?? '/dashboard/user/inbox';
  const tabs = [
    { key: 'all', label: 'All', count: props.counts.all, href: base, attention: false },
    { key: 'needs_you', label: 'Needs you', count: props.counts.needsYou, href: `${base}?filter=needs_you`, attention: props.counts.needsYou > 0 },
    { key: 'handed_over', label: 'Handed over', count: props.counts.handedOver, href: `${base}?filter=handed_over`, attention: false },
  ] as const;
  return (
    <nav aria-label="Inbox filter" className="w-fit max-w-full">
      <ul className="inline-flex max-w-full flex-wrap gap-1 rounded-3xl border border-border-subtle bg-bg-1/80 p-1 sm:rounded-full">
        {tabs.map((t) => {
          const active = props.current === t.key;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative isolate inline-flex min-h-11 items-center gap-2 rounded-full lg:min-h-9 px-3.5 py-1.5 text-sm font-medium transition-colors duration-fast',
                  active ? 'text-fg-1' : 'text-fg-2 hover:text-fg-1',
                )}
              >
                {active ? <motion.span layoutId="inbox-filter-pill" transition={spring.smooth} aria-hidden="true" className="absolute inset-0 -z-10 rounded-full bg-panel/14 ring-1 ring-panel/40 ring-inset" /> : null}
                {t.label}
                <span
                  className={cn(
                    'tabular inline-flex min-w-6 items-center justify-center rounded-full border px-1.5 text-xs',
                    t.attention ? 'border-warning/40 bg-warning/14 text-warning' : 'border-border-strong bg-bg-2 text-fg-2',
                  )}
                >
                  <span className="sr-only">(</span>
                  {t.count}
                  <span className="sr-only">)</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
