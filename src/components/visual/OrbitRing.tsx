/**
 * OrbitRing (design spec §3, landing/auth and empty-state motifs): items circling a center on a
 * faint ring, each counter-rotated so icons stay upright. Technique after Magic UI's orbiting
 * circles (MIT, see THIRD_PARTY_NOTICES.md), re-implemented with one transform-only keyframe whose
 * start angle comes from a CSS variable. Decorative and aria-hidden: put real labels in the page.
 * Paused offscreen; under reduced motion the items rest at their evenly spaced angles. Nest two
 * rings (one `reverse`) for depth. Server-safe.
 */
import { Children, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { PauseOffscreen } from './PauseOffscreen';

export function OrbitRing(props: {
  /** One element per orbiting item (icon chips). */
  children: ReactNode;
  /** Shown in the middle, not rotating. */
  center?: ReactNode;
  className?: string;
  /** Ring radius in px (default 96). */
  radius?: number;
  /** Item box size in px (default 40). */
  iconSize?: number;
  /** Seconds per revolution (default 30). */
  duration?: number;
  reverse?: boolean;
  /** Draw the ring line (default true). */
  path?: boolean;
}) {
  const radius = props.radius ?? 96;
  const iconSize = props.iconSize ?? 40;
  const items = Children.toArray(props.children);
  const box = radius * 2 + iconSize;
  const style = {
    width: box,
    height: box,
    '--orbit-radius': `${radius}px`,
    '--orbit-icon': `${iconSize}px`,
    '--orbit-duration': `${props.duration ?? 30}s`,
  } as CSSProperties;
  return (
    <div
      aria-hidden="true"
      data-visual-motion="orbit"
      data-reverse={props.reverse ? '' : undefined}
      style={style}
      className={cn('visual-orbit pointer-events-none relative shrink-0', props.className)}
    >
      {props.path === false ? null : (
        <svg className="absolute inset-0 size-full overflow-visible" fill="none">
          <circle cx="50%" cy="50%" r={radius} className="stroke-border-strong" strokeWidth={1} />
        </svg>
      )}
      {props.center ? <div className="absolute inset-0 flex items-center justify-center">{props.center}</div> : null}
      {items.map((item, index) => (
        <div key={index} className="visual-orbit__item" style={{ '--orbit-angle': `${((360 / items.length) * index).toFixed(2)}deg` } as CSSProperties}>
          {item}
        </div>
      ))}
      <PauseOffscreen />
    </div>
  );
}
