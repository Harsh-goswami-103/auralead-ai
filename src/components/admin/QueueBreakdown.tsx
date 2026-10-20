'use client';

/**
 * QueueBreakdown: the real job counts per status (QueueHealth.byStatus) as one stacked bar and a
 * legend of status filters. Segment widths follow the counts (a non-zero count keeps a 4px sliver
 * so it never disappears); every segment is named in the legend with its icon, label and exact
 * count, so color is never the only signal and the bar itself is aria-hidden. Each legend entry
 * links to the job list filtered by that status (plain links, they work without JS); the active
 * filter carries aria-current and a panel-hue pill that slides between entries (layoutId).
 *
 * Motion: the bar grows in once on mount (scaleX, 450ms, the chart duration) and never again on
 * a refresh or a filter change (the island stays mounted across them). Under reduced motion the
 * global MotionConfig drops the transform, so the bar renders at its final width.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Layers } from 'lucide-react';
import type { JobStatus } from '@/lib/domain/enums';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { duration, ease, spring } from '@/components/motion/presets';
import { JOB_STATUS_VOCABULARY, TONE_FILL } from './admin-vocabulary';

export type QueueSegment = { status: JobStatus; count: number; href: string; active: boolean };

const SWATCH: Readonly<Record<JobStatus, string>> = {
  QUEUED: 'bg-fg-3',
  RUNNING: TONE_FILL.info,
  SUCCEEDED: TONE_FILL.success,
  DEAD: TONE_FILL.danger,
  CANCELLED: 'bg-border-strong',
};

export function QueueBreakdown(props: { segments: QueueSegment[]; allHref: string; allActive: boolean }) {
  const total = props.segments.reduce((sum, s) => sum + s.count, 0);
  const visible = props.segments.filter((s) => s.count > 0);
  return (
    <div className="flex flex-col gap-4">
      <div aria-hidden="true" className="h-3 w-full overflow-hidden rounded-full bg-bg-2 ring-1 ring-border-subtle ring-inset">
        {total > 0 ? (
          <motion.div
            className="flex h-full w-full gap-0.5"
            style={{ originX: 0 }}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: duration.chart, ease: ease.emphasized }}
          >
            {visible.map((s) => (
              <span key={s.status} data-queue-segment={s.status} className={cn('h-full min-w-1 first:rounded-l-full last:rounded-r-full', SWATCH[s.status])} style={{ flexGrow: s.count, flexBasis: 0 }} />
            ))}
          </motion.div>
        ) : null}
      </div>
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
        <LegendLink href={props.allHref} active={props.allActive} label="All jobs" count={total} icon={<Layers aria-hidden="true" className="size-3.5" />} swatch="bg-[image:var(--panel-grad)]" />
        {props.segments.map((s) => {
          const entry = JOB_STATUS_VOCABULARY[s.status];
          const Icon = entry.icon;
          return (
            <LegendLink
              key={s.status}
              href={s.href}
              active={s.active}
              label={entry.label}
              count={s.count}
              swatch={SWATCH[s.status]}
              icon={
                <span className={cn('flex size-5 items-center justify-center rounded-full border', TONE_CLASSES[entry.tone])}>
                  <Icon aria-hidden="true" className="size-3" />
                </span>
              }
            />
          );
        })}
      </ul>
    </div>
  );
}

function LegendLink(props: { href: string; active: boolean; label: string; count: number; icon: ReactNode; swatch: string }) {
  return (
    <li className="min-w-0">
      <Link
        href={props.href}
        aria-current={props.active ? 'page' : undefined}
        className={cn(
          'relative isolate flex min-h-11 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors duration-fast ease-enter lg:min-h-10',
          props.active ? 'border-transparent text-fg-1' : 'border-border-subtle text-fg-2 hover:border-border-strong hover:bg-bg-2/70 hover:text-fg-1',
        )}
      >
        {props.active ? <motion.span layoutId="queue-filter-active" transition={spring.smooth} aria-hidden="true" className="absolute inset-0 -z-10 rounded-lg bg-panel/12 ring-1 ring-panel/45 ring-inset" /> : null}
        <span aria-hidden="true" className={cn('hidden h-6 w-1 shrink-0 rounded-full sm:block', props.swatch)} />
        <span className="flex shrink-0 items-center text-fg-2">{props.icon}</span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span className="tabular font-medium text-fg-1">{props.count}</span>
      </Link>
    </li>
  );
}
