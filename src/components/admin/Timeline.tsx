/**
 * Timeline: a vertical rail of real events (correlation timeline, processing jobs). Each item is a
 * node disc on the rail (a kind icon in its tone: a status tone when the item is a status, the
 * panel hue for plain record events) beside its time, title and detail. Items rise in once with a
 * list stagger (first 8 move, none under reduced motion, never on refresh). The rail fades toward
 * the end so the newest-last order reads top to bottom. Server-safe.
 */
import type { ReactNode } from 'react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { TONE_NODE } from './admin-vocabulary';

export type TimelineTone = StatusTone | 'panel';

export type TimelineEntry = {
  key: string;
  icon: ReactNode;
  tone: TimelineTone;
  /** Short time label, e.g. formatDateTime(at). */
  time: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** Trailing element on the title row, e.g. a status chip. */
  aside?: ReactNode;
};

const PANEL_NODE = 'bg-panel/14 text-panel ring-panel/40';

export function Timeline(props: { items: TimelineEntry[]; className?: string; inView?: boolean }) {
  const last = props.items.length - 1;
  return (
    <Stagger as="ol" step="list" className={cn('flex flex-col', props.className)}>
      {props.items.map((item, i) => (
        <StaggerItem as="li" key={item.key} inView={props.inView} className="relative flex gap-3 pb-4 last:pb-0">
          {i < last ? (
            <span aria-hidden="true" className="absolute top-8 bottom-0 left-[15px] w-px bg-gradient-to-b from-border-strong to-border-subtle" />
          ) : null}
          <span
            aria-hidden="true"
            className={cn('relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset [&>svg]:size-4', item.tone === 'panel' ? PANEL_NODE : TONE_NODE[item.tone])}
          >
            {item.icon}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-border-subtle bg-bg-1/70 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="min-w-0 text-sm text-fg-1">{item.title}</div>
              {item.aside}
            </div>
            {item.detail ? <div className="text-xs [overflow-wrap:anywhere] text-fg-2">{item.detail}</div> : null}
            <div className="tabular text-xs text-fg-2">{item.time}</div>
          </div>
        </StaggerItem>
      ))}
    </Stagger>
  );
}
