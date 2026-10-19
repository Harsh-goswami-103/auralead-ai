/**
 * StatTile (design spec §4, color report "KPI cards"): one real fact as a tile. A 2px top hairline
 * (the panel gradient, or the status tone when the fact is a status), a 10% corner tint, an icon
 * chip (tone at 14% behind a tone icon), the label, the value and an optional hint. Truthful UI:
 * the value is text-1 tabular, never colored and never counted up; it renders its final value
 * from the first frame. Each tile is its own <dl>, so place tiles in a plain grid (not inside a
 * <dl>). With `href` the whole tile is a link that lifts 2px and borders in the panel hue on
 * hover. Server-safe.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export type StatTone = 'panel' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<StatTone, { hairline: string; chip: string; tint: string }> = {
  panel: { hairline: '[background-image:var(--panel-grad)]', chip: 'bg-panel/14 text-panel', tint: '[--tile-tone:var(--panel-hue)]' },
  success: { hairline: 'bg-success', chip: 'bg-success/14 text-success', tint: '[--tile-tone:var(--success)]' },
  warning: { hairline: 'bg-warning', chip: 'bg-warning/14 text-warning', tint: '[--tile-tone:var(--warning)]' },
  danger: { hairline: 'bg-danger', chip: 'bg-danger/14 text-danger', tint: '[--tile-tone:var(--danger)]' },
  info: { hairline: 'bg-info', chip: 'bg-info/14 text-info', tint: '[--tile-tone:var(--info)]' },
  neutral: { hairline: 'bg-border-strong', chip: 'bg-bg-3 text-fg-2', tint: '[--tile-tone:var(--text-3)]' },
};

export function StatTile(props: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** A lucide icon element; it is decorative (the label names the fact). */
  icon?: ReactNode;
  tone?: StatTone;
  href?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const tone = TONES[props.tone ?? 'panel'];
  const surface = cn(
    'relative isolate flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4',
    'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(140%_110%_at_100%_0%,color-mix(in_oklab,var(--tile-tone)_10%,transparent),transparent_58%)]',
    tone.tint,
    props.href && 'transition-[translate,border-color] duration-150 ease-enter hover:border-panel/45 motion-safe:hover:-translate-y-0.5',
    props.className,
  );
  const body = (
    <>
      <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5', tone.hairline)} />
      <div className="flex items-start justify-between gap-3">
        <dl className="flex min-w-0 flex-col gap-1">
          <dt className="text-sm text-fg-2">{props.label}</dt>
          <dd className="tabular font-display text-2xl font-semibold text-fg-1">{props.value}</dd>
          {props.hint ? <dd className="text-xs text-fg-2">{props.hint}</dd> : null}
        </dl>
        {props.icon ? (
          <span aria-hidden="true" className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4.5', tone.chip)}>
            {props.icon}
          </span>
        ) : null}
      </div>
      {props.footer ? <div className="mt-auto text-xs text-fg-2">{props.footer}</div> : null}
    </>
  );
  if (props.href) {
    return (
      <Link href={props.href} data-stat-tile="" className={surface}>
        {body}
      </Link>
    );
  }
  return (
    <div data-stat-tile="" className={surface}>
      {body}
    </div>
  );
}
