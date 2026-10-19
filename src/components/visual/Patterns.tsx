/**
 * GridPattern and DotPattern (design spec §3): pure CSS background textures (no SVG per dot)
 * faded with a mask, for page header bands, empty states, the pipeline canvas and the auth hero.
 * Server-safe, static, aria-hidden, absolutely placed behind content (-z-10; parent `relative
 * isolate`). Never behind tables, forms or long text (spec §7).
 */
import type { CSSProperties } from 'react';
import { cn } from '@/components/ui/cn';

export type PatternFade = 'radial' | 'bottom' | 'top' | 'none';

const FADE: Record<PatternFade, string | null> = {
  radial: 'visual-fade-radial',
  bottom: 'visual-fade-bottom',
  top: 'visual-fade-top',
  none: null,
};

export function GridPattern(props: { className?: string; fade?: PatternFade; size?: number; lineColor?: string }) {
  const style = {
    '--grid-size': `${props.size ?? 40}px`,
    '--grid-line': props.lineColor ?? 'var(--border-subtle)',
  } as CSSProperties;
  return (
    <div
      aria-hidden="true"
      data-pattern="grid"
      style={style}
      className={cn('visual-grid pointer-events-none absolute inset-0 -z-10', FADE[props.fade ?? 'radial'], props.className)}
    />
  );
}

export function DotPattern(props: { className?: string; fade?: PatternFade; gap?: number; dotColor?: string }) {
  const style = {
    '--dot-gap': `${props.gap ?? 18}px`,
    '--dot-color': props.dotColor ?? 'color-mix(in oklab, var(--text-1) 11%, transparent)',
  } as CSSProperties;
  return (
    <div
      aria-hidden="true"
      data-pattern="dots"
      style={style}
      className={cn('visual-dots pointer-events-none absolute inset-0 -z-10', FADE[props.fade ?? 'radial'], props.className)}
    />
  );
}
