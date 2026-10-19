/**
 * Marquee (design spec §3, landing/auth only): a strip that scrolls its items in a loop, for the
 * channels and sources AuraLead really supports (no customer logos, spec §0.1). Technique after
 * Magic UI's marquee (MIT, see THIRD_PARTY_NOTICES.md), re-implemented: two identical tracks
 * translate by one track width (transform only); the second copy is inert and aria-hidden so
 * links are not read or focused twice. Pauses on hover (optional), keyboard focus and offscreen.
 * Under reduced motion it becomes one static, centered, wrapped row. Server-safe.
 */
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { PauseOffscreen } from './PauseOffscreen';

export function Marquee(props: {
  children: ReactNode;
  className?: string;
  reverse?: boolean;
  /** Pause while the pointer is over the strip (default true). */
  pauseOnHover?: boolean;
  vertical?: boolean;
  /** Seconds per loop (default 40). */
  duration?: number;
  /** Gap between items, any CSS length (default 1rem). */
  gap?: string;
}) {
  const style = { '--marquee-duration': `${props.duration ?? 40}s`, '--marquee-gap': props.gap ?? '1rem' } as CSSProperties;
  return (
    <div
      data-visual-motion="marquee"
      data-reverse={props.reverse ? '' : undefined}
      data-vertical={props.vertical ? '' : undefined}
      data-pause-on-hover={props.pauseOnHover === false ? undefined : ''}
      style={style}
      className={cn('visual-marquee', props.className)}
    >
      <div className="visual-marquee__track">{props.children}</div>
      <div className="visual-marquee__track" data-marquee-copy="" aria-hidden="true" inert>
        {props.children}
      </div>
      <PauseOffscreen />
    </div>
  );
}
