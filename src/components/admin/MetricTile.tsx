/**
 * MetricTile: the StatTile look (2px top hairline, 10% corner tint, icon chip, text-1 tabular
 * value that never counts up) as a name-value group for a parent <dl>: the tile is a <div> whose
 * only children are its <dt> and <dd>s, so the grid stays one valid description list (the admin
 * home keeps the `dl > div` structure its e2e smoke test reads). The hairline and tint are pseudo
 * elements and the icon sits inside the <dt>, aria-hidden.
 *
 * `hue` names the panel a role works in (client = aura, operator = zest, admin = flare), so each
 * role tile carries the signature of the panel those people use; status tones are only for
 * status facts (danger for disabled accounts). `index` staggers a one-time CSS rise (45ms apart,
 * first 8 only, motion-safe, so it rests at once under reduced motion). Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export type MetricHue = 'client' | 'operator' | 'admin' | 'danger' | 'neutral';

const HUES: Record<MetricHue, { hairline: string; chip: string; tint: string }> = {
  client: { hairline: 'after:[background-image:var(--grad-client)]', chip: 'bg-aura/14 text-aura', tint: '[--tile-tone:var(--aura)]' },
  operator: { hairline: 'after:[background-image:var(--grad-operator)]', chip: 'bg-zest/14 text-zest', tint: '[--tile-tone:var(--zest)]' },
  admin: { hairline: 'after:[background-image:var(--grad-admin)]', chip: 'bg-flare/14 text-flare', tint: '[--tile-tone:var(--flare)]' },
  danger: { hairline: 'after:bg-danger', chip: 'bg-danger/14 text-danger', tint: '[--tile-tone:var(--danger)]' },
  neutral: { hairline: 'after:bg-border-strong', chip: 'bg-bg-3 text-fg-2', tint: '[--tile-tone:var(--text-3)]' },
};

export function MetricTile(props: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; hue?: MetricHue; index?: number; className?: string }) {
  const hue = HUES[props.hue ?? 'admin'];
  const reveal = props.index !== undefined && props.index < 8;
  return (
    <div
      data-metric-tile=""
      style={reveal ? { animationDelay: `${60 + (props.index ?? 0) * 45}ms` } : undefined}
      className={cn(
        reveal && 'motion-safe:animate-reveal-rise',
        'relative isolate flex min-w-0 flex-col gap-1 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4',
        'before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(140%_110%_at_100%_0%,color-mix(in_oklab,var(--tile-tone)_12%,transparent),transparent_58%)]',
        'after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-0.5',
        hue.hairline,
        hue.tint,
        props.className,
      )}
    >
      <dt className="flex min-h-10 items-start justify-between gap-3 text-sm text-fg-2">
        <span className="pt-1">{props.label}</span>
        {props.icon ? (
          <span aria-hidden="true" className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4.5', hue.chip)}>
            {props.icon}
          </span>
        ) : null}
      </dt>
      <dd className="tabular -mt-2 font-display text-3xl font-semibold text-fg-1">{props.value}</dd>
      {props.hint ? <dd className="text-xs text-fg-2">{props.hint}</dd> : null}
    </div>
  );
}
