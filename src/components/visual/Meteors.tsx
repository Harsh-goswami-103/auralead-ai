/**
 * Meteors (design spec §3, landing/auth only, never inside data panels): thin shooting streaks
 * that cross the parent diagonally. Technique after Magic UI's meteors (MIT, see
 * THIRD_PARTY_NOTICES.md), re-implemented without Math.random or effects: lanes, delays and
 * speeds come from a seeded mulberry32 sequence, so the server render, the client and tests agree.
 * Fill a `relative overflow-hidden` parent. Under reduced motion they rest as a faint starfield.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/components/ui/cn';
import { between, mulberry32 } from './prng';

const COLORS = ['var(--ice)', 'var(--aura)', 'var(--ice)', 'var(--zest)'] as const;

export function Meteors(props: { count?: number; className?: string; seed?: number; angle?: number }) {
  const next = mulberry32(props.seed ?? 7);
  const count = Math.max(0, Math.min(props.count ?? 14, 40));
  const meteors = Array.from({ length: count }, (_, index) => ({
    left: between(next, 8, 118),
    top: between(next, -8, 42),
    delay: between(next, 0, 9),
    duration: between(next, 5, 11),
    tail: Math.round(between(next, 48, 110)),
    color: COLORS[index % COLORS.length],
  }));
  return (
    <div aria-hidden="true" data-visual-motion="meteors" className={cn('pointer-events-none absolute inset-0 overflow-hidden', props.className)}>
      {meteors.map((meteor, index) => (
        <span
          key={index}
          className="visual-meteor"
          style={
            {
              left: `${meteor.left}%`,
              top: `${meteor.top}%`,
              '--meteor-angle': `${props.angle ?? 145}deg`,
              '--meteor-travel': '720px',
              '--meteor-delay': `${meteor.delay}s`,
              '--meteor-duration': `${meteor.duration}s`,
              '--meteor-tail': `${meteor.tail}px`,
              '--meteor-color': meteor.color,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
